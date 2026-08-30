"""Real-first training and an inference-mode learning gate for the geometry extractor."""
from __future__ import annotations

import json
import math
import os
import random
import copy
from pathlib import Path
from typing import Any, Iterator, Sequence

import numpy as np
import torch
from torch.utils.data import DataLoader, Sampler

from .events import emit
from .extraction import (CORNER_ORDER, NORMALIZE_MEAN, NORMALIZE_STD, ExtractionDataset, ExtractionRecord,
                         _atomic_torch_save, _device, _load_model, _sha256, _write_json, _write_jsonl, read_manifest)
from .extraction_network import (ARCHITECTURE, DECODER_CHANNELS, EMA_DECAY, HEATMAP_SIZE, INPUT_SIZE,
                                 MASK_THRESHOLD, MINIMUM_CORNER_PEAK, TOP_K_CORNERS, TRAINING_RECIPE,
                                 CardExtractor, geometry_loss)
from .extraction_evaluation import (CHECKPOINT_SELECTION_POLICY, predict, selection_key,
                                    summarize, write_failures)

MAX_AMP_OVERFLOW_RETRIES = 16
SAMPLING_POLICY = {"real_positive_fraction": .75, "group_balanced_fraction": .5,
                   "maximum_synthetic_fraction": .2, "replacement": True}


def _optimizer_update(model, optimizer, scaler, images, corners, presence, device,
                      phase: str, completed_updates: int, max_retries: int = MAX_AMP_OVERFLOW_RETRIES):
    """Finish one real update, retrying the same batch after recoverable AMP overflow."""
    for attempt in range(max_retries + 1):
        optimizer.zero_grad(set_to_none=True)
        with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=device.type == "cuda"):
            outputs = model.forward_geometry(images)
            loss, parts = geometry_loss(outputs, corners, presence)
        if not torch.isfinite(loss):
            raise RuntimeError(f"{phase}: non-finite forward loss at update {completed_updates + 1}; AMP scaling cannot repair a forward failure")
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        gradients = [(name, torch.isfinite(parameter.grad).all()) for name, parameter in model.named_parameters()
                     if parameter.grad is not None]
        if not gradients:
            raise RuntimeError(f"{phase}: no gradients at update {completed_updates + 1}")
        finite = torch.stack([check for _, check in gradients]).cpu().tolist()
        if not all(finite):
            affected = [name for (name, _), valid in zip(gradients, finite) if not valid][:8]
            if not scaler.is_enabled():
                optimizer.zero_grad(set_to_none=True)
                raise RuntimeError(f"{phase}: non-finite gradients without AMP at update {completed_updates + 1}: {affected}")
            previous_scale = scaler.get_scale()
            # unscale_ recorded the non-finite gradients. step skips optimizer
            # mutation; update reduces the scale before retrying this batch.
            scaler.step(optimizer)
            scaler.update()
            optimizer.zero_grad(set_to_none=True)
            next_scale = scaler.get_scale()
            emit("extraction_amp_overflow", phase=phase, optimizer_updates=completed_updates,
                 failed_attempt=attempt + 1, retry=attempt + 1 if attempt < max_retries else None,
                 maximum_retries=max_retries, previous_loss_scale=previous_scale, loss_scale=next_scale,
                 affected_parameters=affected, retrying=attempt < max_retries)
            if attempt >= max_retries or not (math.isfinite(next_scale) and 0 < next_scale < previous_scale):
                raise RuntimeError(f"{phase}: AMP gradients remain non-finite at update {completed_updates + 1} "
                                   f"after {attempt + 1} attempts (loss scale {next_scale}); stopping without updating weights. "
                                   f"Affected parameters: {affected}")
            continue
        # Retain the strict guard if the norm overflows despite finite elements:
        # the scaler would not detect/skip that separate failure.
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5., error_if_nonfinite=True)
        scaler.step(optimizer)
        scaler.update()
        return loss.detach(), {name: value.detach() for name, value in parts.items()}, attempt


class RealFirstBatches(Sampler[list[tuple[int, int]]]):
    def __init__(self, records: Sequence[ExtractionRecord], batch_size: int, steps: int,
                 generator: torch.Generator) -> None:
        self.real = [index for index, record in enumerate(records) if record.source_kind == "real"]
        self.synthetic = [index for index, record in enumerate(records) if record.source_kind != "real"]
        if not self.real:
            raise ValueError("Spatial extractor training requires real annotated photographs")
        self.batch_size, self.steps, self.generator = batch_size, steps, generator
        self.synthetic_per_batch = batch_size // 5 if self.synthetic else 0
        self.classes = {present: [i for i in self.real if records[i].card_present == present]
                        for present in (True, False)}
        self.groups = {present: [[i for i in pool if records[i].source_group == group]
                                for group in sorted({records[i].source_group for i in pool})]
                       for present, pool in self.classes.items()}
        missing = ["positive" if present else "negative" for present, pool in self.classes.items() if not pool]
        if missing:
            emit("extraction_sampling_warning", missing_classes=missing,
                 message="Real training lacks a presence class; sampling available labels only.")

    def __len__(self) -> int:
        return self.steps

    def __iter__(self) -> Iterator[list[tuple[int, int]]]:
        for _ in range(self.steps):
            indices = []
            real_count = self.batch_size - self.synthetic_per_batch
            # Stochastic rounding preserves the 75/25 target even for batch one.
            exact_negatives = real_count * .25
            negative_count = int(exact_negatives) + int(torch.rand((), generator=self.generator) < exact_negatives % 1)
            if not self.classes[False]:
                negative_count = 0
            elif not self.classes[True]:
                negative_count = real_count
            for present, count in ((True, real_count - negative_count), (False, negative_count)):
                pool, groups = self.classes[present], self.groups[present]
                for _ in range(count):
                    if torch.rand((), generator=self.generator) < .5:
                        group = groups[int(torch.randint(len(groups), (), generator=self.generator))]
                        indices.append(group[int(torch.randint(len(group), (), generator=self.generator))])
                    else:
                        indices.append(pool[int(torch.randint(len(pool), (), generator=self.generator))])
            if self.synthetic_per_batch:
                indices.extend(self.synthetic[i] for i in torch.randint(len(self.synthetic),
                    (self.synthetic_per_batch,), generator=self.generator).tolist())
            order = torch.randperm(len(indices), generator=self.generator).tolist()
            seeds = torch.randint(2**31, (len(indices),), generator=self.generator).tolist()
            yield [(indices[index], seed) for index, seed in zip(order, seeds)]


def _seed(seed: int) -> None:
    torch.manual_seed(seed)
    random.seed(seed)
    np.random.seed(seed & 0xffffffff)


def _configuration(records, metadata, manifest, model_version, batch_size, seed, device, pretrained, learning=False):
    return {"artifact_schema_version": 2, "architecture": ARCHITECTURE, "training_recipe_version": TRAINING_RECIPE,
            "checkpoint_selection_policy": CHECKPOINT_SELECTION_POLICY,
            "model_version": model_version, "dataset_version": records[0].dataset_version,
            "manifest_sha256": _sha256(manifest), "input_size": INPUT_SIZE, "heatmap_size": HEATMAP_SIZE,
            "decoder_channels": DECODER_CHANNELS,
            "corner_order": list(CORNER_ORDER), "normalization_mean": NORMALIZE_MEAN, "normalization_std": NORMALIZE_STD,
            "normalization_policy": "frozen-backbone-bn", "letterbox": "centered-contain-black",
            "include_synthetic": metadata.get("include_synthetic", any(item.source_kind != "real" for item in records)), "batch_size": batch_size,
            "seed": seed, "pretrained": pretrained, "development_only": learning,
            "amp_overflow_retry_limit": MAX_AMP_OVERFLOW_RETRIES,
            "sampling_policy": dict(SAMPLING_POLICY), "target_boundary": "physical-card-excluding-sleeve",
            "decoder_policy": {"type": "generic-corner-topk-polygon-mask", "top_k": TOP_K_CORNERS,
                "nms_kernel": 5, "minimum_corner_peak": MINIMUM_CORNER_PEAK, "mask_threshold": MASK_THRESHOLD,
                "candidate_score": "mean-log-corner-confidence-plus-2x-mask-iou",
                "orientation": "screen-clockwise-anchor-topmost-then-readable-top-left"},
            "ema_policy": {"enabled_after_frozen_epochs": 5, "decay": EMA_DECAY},
            "objective": {"corner_heatmap": "2x-centernet-modified-focal", "gaussian_sigma_cells": 1.5,
                          "offset": "smooth-l1-beta-1/9-at-four-rounded-cells",
                          "mask": "balanced-bce-plus-dice", "orientation": "0.5x-cross-entropy-positive-only",
                          "presence": "class-balanced-bce"},
            "training_image_hashes": sorted({item.image_sha256 for item in records if item.split == "train"}),
            "effective_cuda_profile": {"device_index": device.index, "effective_batch_size": batch_size,
                "name": torch.cuda.get_device_name(device), "vram_mib": torch.cuda.get_device_properties(device).total_memory // 1048576}
                if device.type == "cuda" else None}


def _validate_resume(checkpoint, config):
    for key in ("architecture", "training_recipe_version", "input_size", "normalization_policy", "corner_order",
                "dataset_version", "manifest_sha256", "model_version", "seed", "include_synthetic", "development_only",
                "sampling_policy", "objective", "decoder_policy", "ema_policy", "batch_size", "checkpoint_selection_policy"):
        if checkpoint.get(key) != config.get(key):
            raise ValueError(f"Resume checkpoint {key} does not match this extraction run; start a fresh run")


def _random_state(generator):
    return {"torch_rng_state": torch.get_rng_state(), "python_rng_state": random.getstate(),
            "numpy_rng_state": np.random.get_state(), "sampler_rng_state": generator.get_state(),
            "cuda_rng_states": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else []}


def _restore_random(checkpoint, generator):
    torch.set_rng_state(checkpoint["torch_rng_state"])
    random.setstate(checkpoint["python_rng_state"])
    np.random.set_state(checkpoint["numpy_rng_state"])
    generator.set_state(checkpoint["sampler_rng_state"])
    if torch.cuda.is_available() and checkpoint["cuda_rng_states"]:
        torch.cuda.set_rng_state_all(checkpoint["cuda_rng_states"])


def _optimizer(model):
    return torch.optim.AdamW([
        {"params": list(model.features.parameters()), "lr": 3e-5},
        {"params": [parameter for name, parameter in model.named_parameters() if not name.startswith("features.")], "lr": 1e-3},
    ], weight_decay=1e-4)


class ModelEma:
    def __init__(self, model: CardExtractor, decay: float = EMA_DECAY) -> None:
        self.model = copy.deepcopy(model).eval()
        self.decay = decay
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)

    @torch.no_grad()
    def update(self, model: CardExtractor) -> None:
        source = model.state_dict()
        for name, value in self.model.state_dict().items():
            incoming = source[name].detach()
            if value.is_floating_point():
                value.mul_(self.decay).add_(incoming, alpha=1 - self.decay)
            else:
                value.copy_(incoming)


def _snapshot_dataset(output, manifest, metadata, root):
    destination = output / "dataset"
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("manifest.jsonl", "preparation-report.json", "source-inventory.json", "grouping-report.json", "split-assignments.json"):
        source = manifest if name == "manifest.jsonl" else manifest.parent / name
        if source.exists():
            (destination / name).write_bytes(source.read_bytes())
    try:
        image_root = os.path.relpath(root, destination).replace("\\", "/")
        external = False
    except ValueError:
        # Windows cannot express a relative path between drive letters. Never
        # embed a machine-absolute source path in a portable result bundle.
        image_root, external = ".", True
    _write_json(destination / "metadata.json", {**metadata, "image_root": image_root,
                                               "requires_original_data_root": external})


def _preprocessing(config):
    return {"preprocessing_schema_version": 2, "input_width": config["input_size"], "input_height": config["input_size"],
            "resize": "aspect-preserving-contain", "resize_rounding": "round-half-to-even", "padding": "centered-floor-left-top",
            "padding_color_rgb": [0, 0, 0], "augmentation_outside_fill": "reflected-source-border",
            "channel_order": "RGB", "normalization_mean": NORMALIZE_MEAN,
            "normalization_std": NORMALIZE_STD, "source_coordinate_normalization": "x/(width-1), y/(height-1)",
            "corner_order": list(CORNER_ORDER), "rectified_size": [315, 440]}


def _training_reports(output, history, best, development_only):
    _write_jsonl(output / "training-history.jsonl", history)
    selected = next((item for item in reversed(history) if item["selected"]), history[-1])
    _write_json(output / "checkpoint-selection.json", {
        "policy": CHECKPOINT_SELECTION_POLICY,
        "ranking": "presence/negative guard; forced positive correct-warp coverage; all-four accuracy; p95; mean",
        "raw_or_ema": selected.get("selected_weight_source"),
        "best_key": best, "development_only": development_only,
        "selected_epoch": selected["epoch"], "selected_phase": "main",
        "below_target": best is None or not best[0],
    })


def train(manifest: Path, artifacts_root: Path, model_version: str, epochs: int, batch_size: int,
          learning_rate: float, workers: int, pretrained: bool, resume: Path | None, device_name: str,
          seed: int, cuda_index: int | None, max_batches: int | None = None, patience: int = 30) -> dict[str, Any]:
    if epochs < 1 or batch_size < 1 or patience < 1 or (max_batches is not None and max_batches < 1):
        raise ValueError("Epochs, batch size, patience, and update limits must be positive")
    _seed(seed)
    records, root, metadata = read_manifest(manifest)
    training = [item for item in records if item.split == "train"]
    validation = [item for item in records if item.split == "validation" and item.source_kind == "real"]
    has_validation = any(item.card_present for item in validation)
    validation_has_both_classes = has_validation and any(not item.card_present for item in validation)
    if not any(item.source_kind == "real" and item.card_present for item in training):
        raise ValueError("Training requires at least one real annotated positive photograph")
    device = _device(device_name, cuda_index)
    output = artifacts_root.resolve() / model_version
    config = _configuration(records, metadata, manifest, model_version, batch_size, seed, device, pretrained)
    config.update(max_epochs=epochs, patience=patience, minimum_stopping_epoch=40,
                  learning_rate=learning_rate, backbone_learning_rate=3e-5, warmup_epochs=5,
                  development_only=not validation_has_both_classes, workers=workers, max_batches=max_batches)
    checkpoint = torch.load(resume, map_location="cpu", weights_only=False) if resume else None
    if checkpoint:
        _validate_resume(checkpoint, config)
        for key in ("max_epochs", "patience", "learning_rate", "max_batches"):
            if checkpoint.get(key) != config[key]:
                raise ValueError(f"Resume checkpoint {key} differs; keep the original schedule")
    elif (output / "last.pt").exists():
        raise ValueError("This run already has a checkpoint; resume it or start a fresh model version")
    model = CardExtractor(pretrained=pretrained and checkpoint is None).to(device)
    optimizer = _optimizer(model)
    def decay(index):
        return .01 + .99 * (1 + math.cos(math.pi * min(1., max(0., (index - 5) / max(1, epochs - 5))))) / 2
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, [lambda index: 0 if index < 5 else decay(index),
        lambda index: 1 if index < 5 else learning_rate / 1e-3 * decay(index)])
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    generator = torch.Generator().manual_seed(seed)
    start, best, stale, updates, history = 1, None, 0, 0, []
    overflow_retries = 0
    ema: ModelEma | None = None
    if checkpoint:
        model.load_state_dict(checkpoint["model_state"])
        if checkpoint.get("ema_model_state") is not None:
            ema = ModelEma(model)
            ema.model.load_state_dict(checkpoint["ema_model_state"])
        optimizer.load_state_dict(checkpoint["optimizer_state"])
        scheduler.load_state_dict(checkpoint["scheduler_state"])
        scaler.load_state_dict(checkpoint["scaler_state"])
        _restore_random(checkpoint, generator)
        start, best = checkpoint["epoch"] + 1, checkpoint["best_selection_key"]
        stale, updates, history = checkpoint["stale_epochs"], checkpoint["optimizer_updates"], checkpoint["history"]
        overflow_retries = checkpoint.get("amp_overflow_retries", 0)
        if not (output / "best.pt").is_file():
            raise ValueError("The earlier selected checkpoint is missing; restore best.pt before resuming")
        _training_reports(output, history, best, not validation_has_both_classes)
    _snapshot_dataset(output, manifest, metadata, root)
    _write_json(output / "config.json", config)
    _write_json(output / "preprocessing.json", _preprocessing(config))
    real_count = sum(item.source_kind == "real" for item in training)
    steps = max(32, math.ceil(real_count / max(1, batch_size - (batch_size // 5 if any(item.source_kind != "real" for item in training) else 0))))
    if max_batches is not None:
        steps = min(steps, max_batches)
    sampler = RealFirstBatches(training, batch_size, steps, generator)
    loader = DataLoader(ExtractionDataset(root, training, training=True), batch_sampler=sampler,
                        num_workers=workers, pin_memory=device.type == "cuda", persistent_workers=workers > 0)
    validation_loader = DataLoader(ExtractionDataset(root, validation), batch_size=batch_size,
                                   num_workers=workers, persistent_workers=workers > 0,
                                   pin_memory=device.type == "cuda") if validation else None
    completed = start - 1
    while completed < epochs:
        if has_validation and completed >= 40 and stale >= patience:
            emit("extraction_early_stopped", epoch=completed, patience=patience)
            break
        epoch = completed + 1
        model.set_backbone_trainable(epoch > 5)
        if epoch == 6 and ema is None:
            ema = ModelEma(model)
        model.train()
        learning_rates = {"backbone": optimizer.param_groups[0]["lr"], "heads": optimizer.param_groups[1]["lr"]}
        totals = {key: 0. for key in ("loss", "corner_focal_loss", "offset_loss", "mask_bce_loss",
                                      "mask_dice_loss", "orientation_loss", "presence_loss")}
        epoch_retries = 0
        sampled_real = sampled_synthetic = sampled_positive = sampled_negative = 0
        real_ids = {item.sample_id for item in training if item.source_kind == "real"}
        for batch, (images, corners, presence, sample_ids) in enumerate(loader, 1):
            for sample_id, present in zip(sample_ids, presence.tolist()):
                if sample_id in real_ids:
                    sampled_real += 1
                    sampled_positive += int(present > .5)
                    sampled_negative += int(present <= .5)
                else:
                    sampled_synthetic += 1
            images, corners, presence = images.to(device), corners.to(device), presence.to(device)
            loss, parts, retries = _optimizer_update(model, optimizer, scaler, images, corners, presence,
                                                     device, "Extraction geometry training", updates)
            if ema is not None:
                ema.update(model)
            epoch_retries += retries
            overflow_retries += retries
            updates += 1
            for key, value in {"loss": loss, **parts}.items():
                totals[key] += float(value.detach())
            if batch == 1 or batch == steps or batch % 8 == 0:
                emit("extraction_training_progress", phase="main", phase_epoch=epoch, phase_epochs=epochs,
                     epoch=epoch, epochs=epochs, batch=batch, total_batches=steps,
                     amp_overflow_retries=overflow_retries, loss_scale=scaler.get_scale(),
                     optimizer_updates=updates, sampled_real=sampled_real, sampled_synthetic=sampled_synthetic,
                     sampled_real_positive=sampled_positive, sampled_real_negative=sampled_negative,
                     **{key: value / batch for key, value in totals.items()})
        raw_predictions = predict(model, validation, root, device, batch_size, workers, config,
                                  "Real validation raw checkpoint selection", loader=validation_loader)
        candidates = [("raw", model, raw_predictions, selection_key(raw_predictions) if has_validation else None)]
        if ema is not None:
            ema_predictions = predict(ema.model, validation, root, device, batch_size, workers, config,
                                      "Real validation EMA checkpoint selection", loader=validation_loader)
            candidates.append(("ema", ema.model, ema_predictions, selection_key(ema_predictions) if has_validation else None))
        selected_source, selected_model, predictions, key = max(candidates, key=lambda item: item[3] or ())
        metrics = summarize(predictions)
        improved = key is not None and (best is None or key > tuple(best))
        if improved:
            best, stale = key, 0
        elif has_validation and epoch > 40:
            stale += 1
        scheduler.step()
        completed = epoch
        row = {"epoch": epoch, "phase": "main", "phase_epoch": epoch, "phase_epochs": epochs,
               "optimizer_updates": updates, **{key: value / steps for key, value in totals.items()},
               "amp_overflow_retries": epoch_retries, "loss_scale": scaler.get_scale(),
               "learning_rates": learning_rates, "backbone_frozen": epoch <= 5,
               "validation_metrics": metrics, "selection_key": key, "selected": improved,
               "selected_weight_source": selected_source,
               "raw_validation_metrics": summarize(raw_predictions),
               "ema_validation_metrics": summarize(candidates[1][2]) if len(candidates) > 1 else None,
               "selection_constraints_met": key[0] if key else None,
               "development_only": not validation_has_both_classes,
               "sampled_real": sampled_real, "sampled_synthetic": sampled_synthetic,
               "sampled_real_positive": sampled_positive, "sampled_real_negative": sampled_negative}
        history.append(row)
        saved = {**config, "epoch": epoch, "training_phase": "main", "phase_epoch": epoch,
                 "main_completed_epochs": completed,
                 "model_state": model.state_dict(), "optimizer_state": optimizer.state_dict(),
                 "scheduler_state": scheduler.state_dict(), "scaler_state": scaler.state_dict(),
                 "best_selection_key": best, "stale_epochs": stale, "optimizer_updates": updates,
                 "amp_overflow_retries": overflow_retries,
                 "ema_model_state": ema.model.state_dict() if ema is not None else None,
                 "history": history, **_random_state(generator)}
        _atomic_torch_save(saved, output / "last.pt")
        if improved or not has_validation:
            selected_saved = {**saved, "model_state": selected_model.state_dict(),
                              "selected_weight_source": selected_source}
            _atomic_torch_save(selected_saved, output / "best.pt")
        _training_reports(output, history, best, not validation_has_both_classes)
        emit("extraction_epoch_completed", **row)
    result = {"model_version": model_version, "completed_epoch": completed,
              "best_selection_key": best, "training_phase": "main"}
    emit("extraction_training_completed", **result)
    return result


def learning_check(manifest: Path, artifacts_root: Path, model_version: str, device_name: str,
                   batch_size: int, workers: int, seed: int, cuda_index: int | None,
                   max_updates: int = 1000, pretrained: bool = True) -> dict[str, Any]:
    _seed(seed)
    records, root, metadata = read_manifest(manifest)
    available = sorted((item for item in records if item.source_kind == "real" and item.split == "train"), key=lambda item: item.sample_id)
    selected = [item for item in available if item.card_present][:16] + [item for item in available if not item.card_present][:8]
    if not any(item.card_present for item in selected):
        raise ValueError("Learning check requires real positive training photographs")
    device = _device(device_name, cuda_index)
    output = artifacts_root / model_version
    config = _configuration(selected, metadata, manifest, model_version, batch_size, seed, device, pretrained, True)
    config["learning_sample_ids"] = [item.sample_id for item in selected]
    last = output / "last.pt"
    previous = torch.load(last, map_location="cpu", weights_only=False) if last.exists() else None
    if previous:
        _validate_resume(previous, config)
        if previous["learning_sample_ids"] != config["learning_sample_ids"]:
            raise ValueError("Learning-check sample selection differs from its checkpoint")
    model = CardExtractor(pretrained=pretrained and previous is None).to(device)
    optimizer = _optimizer(model)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    generator = torch.Generator().manual_seed(seed)
    start, history = 0, []
    overflow_retries = 0
    if previous:
        model.load_state_dict(previous["model_state"])
        optimizer.load_state_dict(previous["optimizer_state"])
        scaler.load_state_dict(previous["scaler_state"])
        _restore_random(previous, generator)
        start, history = previous["optimizer_updates"], previous["history"]
        overflow_retries = previous.get("amp_overflow_retries", 0)
    _snapshot_dataset(output, manifest, metadata, root)
    _write_json(output / "config.json", config)
    _write_json(output / "preprocessing.json", _preprocessing(config))
    loader = DataLoader(ExtractionDataset(root, selected), batch_size=min(batch_size, len(selected)), num_workers=workers)
    # Cache only this bounded, unaugmented sample in host RAM.
    batches = list(loader)
    predictions = []
    passed = False
    for step in range(start, max_updates + 1):
        if step == start or step % 50 == 0 or step == max_updates:
            predictions = predict(model, selected, root, device, batch_size, 0, config)
            metrics = summarize(predictions)
            passed = ((metrics["mean_corner_error"] or 0) <= .015 and (metrics["all_four_within_4_percent"] or 0) >= .95
                      and (not metrics["negatives"] or ((metrics["presence_precision"] or 0) >= .95 and (metrics["presence_recall"] or 0) >= .95)))
            saved = {**config, "model_state": model.state_dict(), "optimizer_state": optimizer.state_dict(),
                     "scaler_state": scaler.state_dict(), "optimizer_updates": step, "history": history,
                     "amp_overflow_retries": overflow_retries,
                     **_random_state(generator)}
            _atomic_torch_save(saved, last)
            emit("extraction_learning_progress", updates=step, maximum_updates=max_updates, passed=passed,
                 amp_overflow_retries=overflow_retries, loss_scale=scaler.get_scale(), **metrics)
            if passed or step == max_updates:
                break
        model.set_backbone_trainable(step >= 100)
        model.train()
        optimizer.param_groups[0]["lr"] = 3e-5 if step >= 100 else 0.
        optimizer.param_groups[1]["lr"] = 3e-4 if step >= 100 else 1e-3
        images, corners, presence, _ = batches[step % len(batches)]
        images, corners, presence = images.to(device), corners.to(device), presence.to(device)
        loss, parts, retries = _optimizer_update(model, optimizer, scaler, images, corners, presence,
                                                 device, "Real-photo learning check", step)
        overflow_retries += retries
        history.append({"update": step + 1, "amp_overflow_retries": retries, "loss_scale": scaler.get_scale(),
                        "loss": float(loss), **{key: float(value) for key, value in parts.items()}})
    loaded_config, loaded = _load_model(last, device)
    reloaded_predictions = predict(loaded, selected, root, device, batch_size, 0, loaded_config)
    parity = all(np.allclose([v for point in before["corners"] for v in point.values()],
                             [v for point in after["corners"] for v in point.values()], atol=1e-6)
                 and abs(before["presence_probability"] - after["presence_probability"]) <= 1e-6
                 for before, after in zip(predictions, reloaded_predictions))
    report = {"learning_check_schema_version": 2, "model_version": model_version, "passed": passed and parity,
              "development_only": True, "evaluation_scope": "memorization-of-training-subset-not-held-out",
              "metrics": summarize(reloaded_predictions), "checkpoint_reload_parity": parity,
              "missing_classes": ["negative"] if not any(not item.card_present for item in selected) else [],
              "sample_ids": config["learning_sample_ids"], "optimizer_updates": step,
              "amp_overflow_retries": overflow_retries}
    write_failures(output, reloaded_predictions, selected, root, .5)
    _write_jsonl(output / "training-history.jsonl", history)
    _write_json(output / "learning-check.json", report)
    if not report["passed"]:
        raise RuntimeError("Real-photo learning check failed; inspect learning-check.json and failure overlays before full training")
    emit("extraction_learning_completed", **report)
    return report

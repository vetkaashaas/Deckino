from __future__ import annotations

import json
import os
import platform
import random
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Sequence

import torch
from PIL import Image
from torch.nn import functional as F
from torch.utils.data import DataLoader

from . import __version__
from .camera_manifest import prepare_camera_manifest
from .events import emit
from .manifest import (
    HELD_OUT_ARTWORK,
    SYNTHETIC_VIEW,
    ManifestRecord,
    create_subset,
    prepare_dataset,
    validate_manifest,
    write_json,
)
from .model import (
    ArcMarginProduct,
    CardDataset,
    EmbeddingNetwork,
    build_evaluation_transform,
    build_train_transform,
    calibrate_thresholds,
    collect_predictions,
    crop_card_art,
    evaluate_model,
    summarize_predictions,
)

ARTIFACT_SCHEMA_VERSION = 3
DEFAULT_SCORE_THRESHOLD = 0.45
DEFAULT_MARGIN_THRESHOLD = 0.05


def _resolve_device(requested: str, cuda_device_index: int | None = None) -> torch.device:
    if requested not in {"auto", "cuda", "cpu"}:
        raise ValueError("device must be one of: auto, cuda, cpu")
    if requested == "auto":
        requested = "cuda" if torch.cuda.is_available() else "cpu"
    device = torch.device(requested)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA requested but torch.cuda.is_available() is false")
    if device.type == "cuda" and cuda_device_index is not None:
        if cuda_device_index < 0 or cuda_device_index >= torch.cuda.device_count():
            raise ValueError(f"CUDA device index is unavailable: {cuda_device_index}")
        return torch.device("cuda", cuda_device_index)
    expected_name = os.environ.get("DECKINO_CUDA_DEVICE_NAME")
    if device.type == "cuda" and expected_name:
        matching_index = next(
            (
                index
                for index in range(torch.cuda.device_count())
                if expected_name.casefold() in torch.cuda.get_device_name(index).casefold()
            ),
            None,
        )
        if matching_index is None:
            raise ValueError(f"Required CUDA device was not found: {expected_name}")
        return torch.device("cuda", matching_index)
    return device


def _driver_version() -> str | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.splitlines()[0].strip() or None
    except (FileNotFoundError, subprocess.SubprocessError, IndexError):
        return None


def doctor(
    require_cuda: bool = False,
    expected_device: str | None = None,
    minimum_vram_mb: int = 6000,
) -> int:
    if minimum_vram_mb < 1:
        raise ValueError("minimum VRAM must be positive")
    cuda_available = torch.cuda.is_available()
    devices = []
    for index in range(torch.cuda.device_count()):
        properties = torch.cuda.get_device_properties(index)
        devices.append(
            {
                "index": index,
                "name": properties.name,
                "vram_mb": round(properties.total_memory / (1024 * 1024)),
                "compute_capability": f"{properties.major}.{properties.minor}",
            }
        )
    expected_device_found = expected_device is None or any(
        expected_device.casefold() in item["name"].casefold() for item in devices
    )
    candidates = [
        item for item in devices
        if item["vram_mb"] >= minimum_vram_mb
        and (expected_device is None or expected_device.casefold() in item["name"].casefold())
    ]
    selected_device = max(candidates, key=lambda item: (item["vram_mb"], -item["index"]), default=None)
    selected_profile = None
    if selected_device is not None:
        validated = any(
            name in selected_device["name"].casefold()
            for name in ("rtx 3060 laptop", "rtx 4070 laptop")
        )
        batch_size = 64 if selected_device["vram_mb"] >= 7680 else 32
        selected_profile = {
            "batch_size": batch_size,
            "validated": validated,
            "label": (
                f"Validated {batch_size}-batch profile"
                if validated
                else f"Compatible unvalidated {batch_size}-batch profile"
            ),
        }
    sufficient_vram = selected_device is not None
    healthy = cuda_available and expected_device_found and sufficient_vram
    emit(
        "doctor",
        cli_version=__version__,
        python=sys.version.split()[0],
        platform=platform.platform(),
        torch=torch.__version__,
        cuda_runtime=torch.version.cuda,
        driver_version=_driver_version(),
        cuda_available=cuda_available,
        expected_device=expected_device,
        expected_device_found=expected_device_found,
        minimum_vram_mb=minimum_vram_mb,
        sufficient_vram=sufficient_vram,
        selected_device=selected_device,
        selected_profile=selected_profile,
        devices=devices,
        status="ok" if healthy else "not-ready",
    )
    return 0 if healthy or not require_cuda else 1


def accelerator_smoke(
    manifest_path: Path,
    device_name: str,
    batch_size: int = 64,
    embedding_dim: int = 512,
    steps: int = 2,
    cuda_device_index: int | None = None,
) -> int:
    if steps < 1:
        raise ValueError("steps must be at least 1")
    device = _resolve_device(device_name, cuda_device_index)
    if device.type != "cuda":
        raise ValueError("CUDA smoke requires a CUDA device")
    metadata = json.loads((manifest_path.parent / "metadata.json").read_text(encoding="utf-8"))
    if metadata.get("schema_version") == 4:
        from .artwork import read_artwork_manifest

        artwork_records, _ = read_artwork_manifest(manifest_path)
        class_count = len({record.artwork_id for record in artwork_records})
    else:
        records, _ = validate_manifest(manifest_path)
        class_count = len({record.oracle_id for record in records})
    model = EmbeddingNetwork(embedding_dim=embedding_dim, pretrained=False).to(device)
    head = ArcMarginProduct(embedding_dim=embedding_dim, class_count=class_count).to(device)
    optimizer = torch.optim.AdamW([*model.parameters(), *head.parameters()], lr=3e-4)
    scaler = torch.amp.GradScaler("cuda", init_scale=1024.0)
    started_at = time.perf_counter()
    losses: list[float] = []
    optimizer_steps = 0
    for _ in range(steps):
        images = torch.rand(batch_size, 3, 224, 224, device=device)
        targets = torch.arange(batch_size, device=device) % class_count
        optimizer.zero_grad(set_to_none=True)
        with torch.autocast(device_type="cuda", dtype=torch.float16):
            embeddings = model(images)
        # ArcFace normalization and square-root gradients are unstable in fp16.
        # Keep the expensive backbone under AMP but calculate the metric head in fp32.
        with torch.autocast(device_type="cuda", enabled=False):
            logits = head(embeddings.float(), targets)
            loss = F.cross_entropy(logits, targets)
        scale_before = scaler.get_scale()
        scaler.scale(loss).backward()
        scaler.step(optimizer)
        scaler.update()
        if scaler.get_scale() >= scale_before:
            optimizer_steps += 1
        losses.append(float(loss.detach().cpu().item()))
    if optimizer_steps == 0 or not optimizer.state:
        emit(
            "accelerator_smoke_failed",
            code="optimizer_steps_skipped",
            message="AMP skipped every optimizer step",
            recommendation="Retry after updating Deckino; ArcFace must run in float32",
        )
        raise RuntimeError("CUDA smoke did not complete an optimizer step")
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    emit(
        "accelerator_smoke_completed",
        device=str(device),
        steps=steps,
        batch_size=batch_size,
        embedding_dim=embedding_dim,
        classes=class_count,
        amp=True,
        optimizer_steps=optimizer_steps,
        elapsed_ms=(time.perf_counter() - started_at) * 1000,
        final_loss=losses[-1],
    )
    return 0


def cache_backbone() -> int:
    emit("backbone_cache_started")
    EmbeddingNetwork(embedding_dim=512, pretrained=True)
    emit("backbone_cache_completed")
    return 0


def prepare(
    data_root: Path,
    dataset_version: str,
    max_classes: int | None,
) -> int:
    emit(
        "prepare_started",
        data_root=str(data_root),
        dataset_version=dataset_version,
    )
    report = prepare_dataset(
        data_root,
        dataset_version,
        max_classes,
        progress=lambda scanned, total, missing, corrupt: emit(
            "prepare_progress",
            scanned=scanned,
            total=total,
            missing=missing,
            corrupt=corrupt,
        ),
    )
    emit("prepare_completed", **asdict(report))
    return 0


def subset(
    source_manifest: Path,
    dataset_version: str,
    max_classes: int,
    min_images_per_class: int,
) -> int:
    emit(
        "subset_started",
        source_manifest=str(source_manifest),
        dataset_version=dataset_version,
    )
    report = create_subset(
        source_manifest,
        dataset_version,
        max_classes=max_classes,
        min_images_per_class=min_images_per_class,
    )
    emit("subset_completed", **report)
    return 0


def prepare_camera(
    input_root: Path,
    output_root: Path,
    dataset_manifest: Path,
    camera_version: str,
) -> int:
    emit(
        "camera_prepare_started",
        input_root=str(input_root),
        output_root=str(output_root),
        camera_version=camera_version,
    )
    report = prepare_camera_manifest(
        input_root,
        output_root,
        dataset_manifest,
        camera_version,
    )
    emit("camera_prepare_completed", **asdict(report))
    return 0


def _labels(records: Sequence[ManifestRecord]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    names: dict[str, str] = {}
    for record in sorted(records, key=lambda value: (value.oracle_id, value.printing_id)):
        names.setdefault(record.oracle_id, record.card_name)
    oracle_ids = sorted(names)
    labels = [
        {"index": index, "oracle_id": oracle_id, "card_name": names[oracle_id]}
        for index, oracle_id in enumerate(oracle_ids)
    ]
    return labels, {item["oracle_id"]: item["index"] for item in labels}


def _checkpoint_payload(
    model: EmbeddingNetwork,
    head: ArcMarginProduct,
    optimizer: torch.optim.Optimizer,
    epoch: int,
    best_top1: float,
    config: dict[str, Any],
    labels: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
        "dataset_version": config["dataset_version"],
        "model_version": config["model_version"],
        "epoch": epoch,
        "best_top1": best_top1,
        "config": config,
        "labels": labels,
        # Persist CPU tensors so checkpoints are backend-neutral and portable.
        "model_state": _cpu_checkpoint_value(model.state_dict()),
        "head_state": _cpu_checkpoint_value(head.state_dict()),
        "optimizer_state": _cpu_checkpoint_value(optimizer.state_dict()),
    }


def _cpu_checkpoint_value(value: Any) -> Any:
    if isinstance(value, torch.Tensor):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {key: _cpu_checkpoint_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_cpu_checkpoint_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_cpu_checkpoint_value(item) for item in value)
    return value


def _load_checkpoint(path: Path, device: torch.device) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {path}")
    checkpoint = torch.load(
        path,
        map_location="cpu",
        weights_only=True,
    )
    if checkpoint.get("artifact_schema_version") != ARTIFACT_SCHEMA_VERSION:
        raise ValueError(
            "Unsupported checkpoint artifact schema; schema v1/v2 DirectML-era "
            "artifacts must be retrained"
        )
    return checkpoint


def _move_optimizer_state(
    optimizer: torch.optim.Optimizer, device: torch.device
) -> None:
    for state in optimizer.state.values():
        for key, value in state.items():
            if isinstance(value, torch.Tensor):
                state[key] = value.to(device)


def _loader(
    root: Path,
    records: Sequence[ManifestRecord],
    label_to_index: dict[str, int],
    batch_size: int,
    workers: int,
    device: torch.device,
    simulated_camera: bool,
) -> DataLoader:
    dataset = CardDataset(
        root,
        records,
        label_to_index,
        build_evaluation_transform(simulated_camera=simulated_camera),
        deterministic=True,
    )
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=workers,
        pin_memory=device.type == "cuda",
    )


def train(
    manifest_path: Path,
    artifacts_root: Path,
    model_version: str,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    workers: int,
    embedding_dim: int,
    pretrained: bool,
    resume_path: Path | None,
    device_name: str,
    max_batches: int | None,
    seed: int = 0,
    cuda_device_index: int | None = None,
) -> int:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    records, dataset_root = validate_manifest(manifest_path)
    dataset_version = records[0].dataset_version
    labels, label_to_index = _labels(records)
    training_records = [record for record in records if record.split == "train"]
    validation_records = [record for record in records if record.split == "validation"]
    if not training_records:
        raise ValueError("Manifest has no training records")
    if not validation_records:
        raise ValueError("Manifest has no validation records")
    if epochs < 1 or batch_size < 2 or embedding_dim < 32:
        raise ValueError("epochs must be >= 1, batch_size >= 2, and embedding_dim >= 32")

    device = _resolve_device(device_name, cuda_device_index)
    artifact_root = artifacts_root.resolve() / model_version
    if resume_path is None and artifact_root.exists() and any(artifact_root.iterdir()):
        raise ValueError(
            f"Artifact version already exists: {artifact_root}. Use a new version or --resume."
        )
    artifact_root.mkdir(parents=True, exist_ok=True)
    config = {
        "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
        "dataset_version": dataset_version,
        "model_version": model_version,
        "embedding_dim": embedding_dim,
        "class_count": len(labels),
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "workers": workers,
        "device": device_name,
        "amp": device.type == "cuda",
        "amp_dtype": "float16" if device.type == "cuda" else None,
        "amp_initial_scale": 1024.0 if device.type == "cuda" else None,
        "arcface_dtype": "float32",
        "pretrained": pretrained,
        "image_size": 224,
        "arcface_scale": 30.0,
        "arcface_margin": 0.35,
        "seed": seed,
    }
    write_json(artifact_root / "config.json", config)
    write_json(
        artifact_root / "labels.json",
        {
            "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
            "dataset_version": dataset_version,
            "model_version": model_version,
            "labels": labels,
        },
    )

    model = EmbeddingNetwork(
        embedding_dim=embedding_dim,
        pretrained=pretrained and resume_path is None,
    ).to(device)
    head = ArcMarginProduct(embedding_dim, len(labels)).to(device)
    optimizer = torch.optim.AdamW(
        [*model.parameters(), *head.parameters()], lr=learning_rate, weight_decay=1e-4
    )
    start_epoch = 0
    best_top1 = 0.0
    if resume_path is not None:
        checkpoint = _load_checkpoint(resume_path, device)
        if checkpoint["dataset_version"] != dataset_version:
            raise ValueError("Resume checkpoint dataset version does not match the manifest")
        if checkpoint["model_version"] != model_version:
            raise ValueError("Resume checkpoint model version does not match --model-version")
        if checkpoint["config"]["embedding_dim"] != embedding_dim:
            raise ValueError("Resume checkpoint embedding dimension does not match")
        if int(checkpoint["config"].get("seed", 0)) != seed:
            raise ValueError("Resume checkpoint seed does not match")
        if [item["oracle_id"] for item in checkpoint["labels"]] != [
            item["oracle_id"] for item in labels
        ]:
            raise ValueError("Resume checkpoint label mapping does not match the manifest")
        model.load_state_dict(checkpoint["model_state"])
        head.load_state_dict(checkpoint["head_state"])
        optimizer.load_state_dict(checkpoint["optimizer_state"])
        _move_optimizer_state(optimizer, device)
        start_epoch = int(checkpoint["epoch"]) + 1
        best_top1 = float(checkpoint["best_top1"])
        emit(
            "checkpoint_resumed",
            dataset_version=dataset_version,
            model_version=model_version,
            completed_epoch=start_epoch,
            optimizer_state_entries=len(optimizer.state),
            seed=seed,
        )

    training_dataset = CardDataset(
        dataset_root, training_records, label_to_index, build_train_transform()
    )
    training_loader = DataLoader(
        training_dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=workers,
        pin_memory=device.type == "cuda",
        drop_last=len(training_dataset) % batch_size == 1,
        generator=torch.Generator().manual_seed(seed),
    )
    validation_loader = _loader(
        dataset_root,
        validation_records,
        label_to_index,
        batch_size,
        workers,
        device,
        simulated_camera=True,
    )
    scaler = torch.amp.GradScaler(
        "cuda", enabled=device.type == "cuda", init_scale=1024.0
    )
    emit(
        "training_started",
        dataset_version=dataset_version,
        model_version=model_version,
        device=str(device),
        classes=len(labels),
        train_samples=len(training_dataset),
        validation_samples=len(validation_records),
        start_epoch=start_epoch,
    )

    if start_epoch >= epochs:
        raise ValueError(f"Checkpoint already completed epoch {start_epoch}; increase --epochs")
    index_to_oracle = [item["oracle_id"] for item in labels]
    for epoch in range(start_epoch, epochs):
        model.train()
        head.train()
        running_loss = 0.0
        batches = 0
        optimizer_steps = 0
        for batch_index, (images, targets, _printing_ids) in enumerate(training_loader):
            if max_batches is not None and batch_index >= max_batches:
                break
            images = images.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, enabled=device.type == "cuda"):
                embeddings = model(images)
            with torch.autocast(device_type=device.type, enabled=False):
                logits = head(embeddings.float(), targets)
                loss = F.cross_entropy(logits, targets)
            scale_before = scaler.get_scale()
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            if scaler.get_scale() >= scale_before:
                optimizer_steps += 1
            running_loss += float(loss.detach().cpu().item())
            batches += 1
            emit(
                "training_progress",
                epoch=epoch + 1,
                epochs=epochs,
                batch=batch_index + 1,
                batches=(
                    len(training_loader)
                    if max_batches is None
                    else min(len(training_loader), max_batches)
                ),
                loss=float(loss.detach().cpu().item()),
            )
        if batches == 0:
            raise ValueError("Training produced no batches; reduce the batch size")
        if optimizer_steps == 0 or not optimizer.state:
            emit(
                "training_error",
                code="optimizer_steps_skipped",
                epoch=epoch + 1,
                message="AMP skipped every optimizer step; no resumable optimizer state exists",
            )
            raise RuntimeError(
                "AMP skipped every optimizer step. Update Deckino or run with a lower AMP scale."
            )

        evaluation = evaluate_model(
            model, head, validation_loader, index_to_oracle, device
        )
        is_best = evaluation.top1 >= best_top1
        best_top1 = max(best_top1, evaluation.top1)
        payload = _checkpoint_payload(
            model, head, optimizer, epoch, best_top1, config, labels
        )
        torch.save(payload, artifact_root / "last.pt")
        if is_best:
            torch.save(payload, artifact_root / "best.pt")
        report = {
            "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
            "dataset_version": dataset_version,
            "model_version": model_version,
            "epoch": epoch + 1,
            "loss": running_loss / batches,
            "optimizer_steps": optimizer_steps,
            **asdict(evaluation),
        }
        write_json(artifact_root / "evaluation.json", report)
        emit("epoch_completed", **report)
    emit("training_completed", artifact_root=str(artifact_root), best_top1=best_top1)
    return 0


def checkpoint_info(checkpoint_path: Path) -> int:
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {checkpoint_path}")
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    schema = int(checkpoint.get("artifact_schema_version", 0))
    if schema not in {3, 4}:
        raise ValueError("Checkpoint inspection supports artifact schema v3 or v4")
    config = checkpoint["config"]
    optimizer_state = checkpoint.get("optimizer_state")
    completed_epoch = (
        int(checkpoint["completed_epoch"])
        if schema == 4
        else int(checkpoint["epoch"]) + 1
    )
    class_count = (
        int(config["artwork_classes"])
        if schema == 4
        else len(checkpoint["labels"])
    )
    emit(
        "checkpoint_info",
        artifact_schema_version=checkpoint["artifact_schema_version"],
        dataset_version=checkpoint["dataset_version"],
        model_version=checkpoint["model_version"],
        completed_epoch=completed_epoch,
        class_count=class_count,
        embedding_dim=int(config["embedding_dim"]),
        seed=int(config.get("seed", 0)),
        identity_key=checkpoint.get("identity_key", "oracle_id"),
        optimizer_state_present=isinstance(optimizer_state, dict)
        and bool(optimizer_state.get("state")),
    )
    return 0


def _restore_for_inference(
    checkpoint_path: Path, device: torch.device
) -> tuple[dict[str, Any], EmbeddingNetwork, ArcMarginProduct]:
    checkpoint = _load_checkpoint(checkpoint_path, device)
    config = checkpoint["config"]
    model = EmbeddingNetwork(config["embedding_dim"], pretrained=False)
    head = ArcMarginProduct(config["embedding_dim"], len(checkpoint["labels"]))
    model.load_state_dict(checkpoint["model_state"])
    head.load_state_dict(checkpoint["head_state"])
    model.to(device).eval()
    head.to(device).eval()
    return checkpoint, model, head


def _validate_labels(
    records: Sequence[ManifestRecord], label_to_index: dict[str, int], description: str
) -> None:
    unknown = sorted({record.oracle_id for record in records} - set(label_to_index))
    if unknown:
        raise ValueError(f"{description} contains {len(unknown)} unknown oracle IDs")


def evaluate(
    manifest_path: Path,
    checkpoint_path: Path,
    device_name: str,
    batch_size: int,
    workers: int,
    camera_manifest_path: Path | None = None,
    comparison_checkpoint_path: Path | None = None,
    cuda_device_index: int | None = None,
) -> int:
    records, root = validate_manifest(manifest_path)
    device = _resolve_device(device_name, cuda_device_index)
    checkpoint, model, head = _restore_for_inference(checkpoint_path, device)
    if checkpoint["dataset_version"] != records[0].dataset_version:
        raise ValueError("Checkpoint dataset version does not match the manifest")
    labels = checkpoint["labels"]
    label_to_index = {item["oracle_id"]: item["index"] for item in labels}
    index_to_oracle = [item["oracle_id"] for item in labels]
    validation_records = [record for record in records if record.split == "validation"]
    if not validation_records:
        raise ValueError("Manifest has no validation records")
    _validate_labels(validation_records, label_to_index, "Validation manifest")

    def collect_for(
        candidate_path: Path,
        candidate_checkpoint: dict[str, Any],
        candidate_model: EmbeddingNetwork,
        candidate_head: ArcMarginProduct,
    ) -> tuple[list[Any], Any]:
        if candidate_checkpoint["dataset_version"] != checkpoint["dataset_version"]:
            raise ValueError("Comparison checkpoint dataset version does not match")
        if candidate_checkpoint["model_version"] != checkpoint["model_version"]:
            raise ValueError("Comparison checkpoint model version does not match")
        if [item["oracle_id"] for item in candidate_checkpoint["labels"]] != [
            item["oracle_id"] for item in labels
        ]:
            raise ValueError("Comparison checkpoint label mapping does not match")
        candidate_loader = _loader(
            root,
            validation_records,
            label_to_index,
            batch_size,
            workers,
            device,
            simulated_camera=True,
        )
        candidate_predictions = collect_predictions(
            candidate_model, candidate_head, candidate_loader, device
        )
        candidate_overall = summarize_predictions(
            candidate_predictions, index_to_oracle
        )
        return candidate_predictions, candidate_overall

    predictions, uncalibrated_overall = collect_for(
        checkpoint_path, checkpoint, model, head
    )
    checkpoint_results: dict[str, dict[str, Any]] = {
        checkpoint_path.name: asdict(uncalibrated_overall)
    }
    selected_checkpoint_path = checkpoint_path
    selected_checkpoint = checkpoint
    selected_model = model
    selected_head = head
    if (
        comparison_checkpoint_path is not None
        and comparison_checkpoint_path.resolve() != checkpoint_path.resolve()
    ):
        comparison_checkpoint, comparison_model, comparison_head = (
            _restore_for_inference(comparison_checkpoint_path, device)
        )
        comparison_predictions, comparison_overall = collect_for(
            comparison_checkpoint_path,
            comparison_checkpoint,
            comparison_model,
            comparison_head,
        )
        checkpoint_results[comparison_checkpoint_path.name] = asdict(
            comparison_overall
        )
        if comparison_overall.top1 > uncalibrated_overall.top1:
            selected_checkpoint_path = comparison_checkpoint_path
            selected_checkpoint = comparison_checkpoint
            selected_model = comparison_model
            selected_head = comparison_head
            predictions = comparison_predictions

    calibration = calibrate_thresholds(predictions)
    grouped: dict[str, dict[str, Any]] = {}
    for validation_kind in (HELD_OUT_ARTWORK, SYNTHETIC_VIEW):
        group_predictions = [
            prediction
            for record, prediction in zip(validation_records, predictions, strict=True)
            if record.validation_kind == validation_kind
        ]
        grouped[validation_kind] = asdict(
            summarize_predictions(
                group_predictions,
                index_to_oracle,
                calibration.score_threshold,
                calibration.margin_threshold,
            )
        )
    overall = summarize_predictions(
        predictions,
        index_to_oracle,
        calibration.score_threshold,
        calibration.margin_threshold,
    )

    camera_result: dict[str, Any] | None = None
    if camera_manifest_path is not None:
        camera_records, camera_root = validate_manifest(camera_manifest_path)
        if camera_records[0].dataset_version != selected_checkpoint["dataset_version"]:
            raise ValueError("Camera manifest dataset version does not match checkpoint")
        _validate_labels(camera_records, label_to_index, "Camera manifest")
        camera_loader = _loader(
            camera_root,
            camera_records,
            label_to_index,
            batch_size,
            workers,
            device,
            simulated_camera=False,
        )
        camera_predictions = collect_predictions(
            selected_model, selected_head, camera_loader, device
        )
        camera_result = asdict(
            summarize_predictions(
                camera_predictions,
                index_to_oracle,
                calibration.score_threshold,
                calibration.margin_threshold,
            )
        )
        write_json(
            checkpoint_path.parent / "camera-report.json",
            {
                "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
                "dataset_version": selected_checkpoint["dataset_version"],
                "model_version": selected_checkpoint["model_version"],
                "camera_manifest": camera_manifest_path.name,
                **camera_result,
            },
        )

    simulated_qualified = overall.top1 >= 0.95 and calibration.qualified
    camera_qualified = (
        camera_result["accepted_precision"] >= 0.99
        and camera_result["coverage"] >= 0.80
        if camera_result is not None
        else None
    )
    report = {
        "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
        "dataset_version": checkpoint["dataset_version"],
        "model_version": checkpoint["model_version"],
        "qualified": simulated_qualified and camera_qualified is True,
        "baseline_qualified": simulated_qualified,
        "simulated_qualified": simulated_qualified,
        "camera_evaluated": camera_result is not None,
        "camera_qualified": camera_qualified,
        "selected_checkpoint": selected_checkpoint_path.name,
        "checkpoint_results": checkpoint_results,
        "thresholds": asdict(calibration),
        "overall": asdict(overall),
        "groups": grouped,
        "real_camera": camera_result,
    }
    thresholds = {
        "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
        "dataset_version": checkpoint["dataset_version"],
        "model_version": checkpoint["model_version"],
        "selected_checkpoint": selected_checkpoint_path.name,
        **asdict(calibration),
    }
    output = checkpoint_path.parent / "evaluation.json"
    threshold_output = checkpoint_path.parent / "thresholds.json"
    write_json(output, report)
    write_json(threshold_output, thresholds)
    emit(
        "evaluation_completed",
        report_path=str(output),
        thresholds_path=str(threshold_output),
        **report,
    )
    return 0


def _resolve_thresholds(
    checkpoint: dict[str, Any],
    checkpoint_path: Path,
    score_threshold: float | None,
    margin_threshold: float | None,
) -> tuple[float, float]:
    threshold_path = checkpoint_path.parent / "thresholds.json"
    stored: dict[str, Any] | None = None
    if threshold_path.is_file():
        stored = json.loads(threshold_path.read_text(encoding="utf-8"))
        if stored.get("artifact_schema_version") != ARTIFACT_SCHEMA_VERSION:
            raise ValueError("Unsupported threshold artifact schema")
        if stored.get("dataset_version") != checkpoint["dataset_version"]:
            raise ValueError("Threshold dataset version does not match checkpoint")
        if stored.get("model_version") != checkpoint["model_version"]:
            raise ValueError("Threshold model version does not match checkpoint")
        selected_checkpoint = stored.get("selected_checkpoint")
        if selected_checkpoint is not None and selected_checkpoint != checkpoint_path.name:
            raise ValueError("Thresholds were calibrated for a different checkpoint")
    score = score_threshold
    margin = margin_threshold
    if score is None:
        score = (
            float(stored["score_threshold"])
            if stored is not None
            else DEFAULT_SCORE_THRESHOLD
        )
    if margin is None:
        margin = (
            float(stored["margin_threshold"])
            if stored is not None
            else DEFAULT_MARGIN_THRESHOLD
        )
    return score, margin


@torch.inference_mode()
def recognize(
    checkpoint_path: Path,
    image_path: Path,
    device_name: str,
    score_threshold: float | None,
    margin_threshold: float | None,
    input_kind: str = "auto",
    cuda_device_index: int | None = None,
) -> int:
    if not image_path.is_file():
        raise FileNotFoundError(f"Image not found: {image_path}")
    device = _resolve_device(device_name, cuda_device_index)
    checkpoint, model, head = _restore_for_inference(checkpoint_path, device)
    score_threshold, margin_threshold = _resolve_thresholds(
        checkpoint,
        checkpoint_path,
        score_threshold,
        margin_threshold,
    )
    with Image.open(image_path) as source:
        image = crop_card_art(source.convert("RGB"), input_kind)
    tensor = build_evaluation_transform(simulated_camera=False)(image).unsqueeze(0).to(device)
    similarities = model(tensor) @ head.centers().to(device).T
    count = min(2, similarities.shape[1])
    values, indices = similarities.topk(count, dim=1)
    best_score = float(values[0, 0].item())
    runner_up = float(values[0, 1].item()) if count > 1 else -1.0
    margin = best_score - runner_up
    label = checkpoint["labels"][int(indices[0, 0].item())]
    rejected = best_score < score_threshold or margin < margin_threshold
    emit(
        "recognition",
        dataset_version=checkpoint["dataset_version"],
        model_version=checkpoint["model_version"],
        rejected=rejected,
        oracle_id=None if rejected else label["oracle_id"],
        card_name=None if rejected else label["card_name"],
        cosine_score=best_score,
        confidence=max(0.0, min(1.0, (best_score + 1.0) / 2.0)),
        margin=margin,
        score_threshold=score_threshold,
        margin_threshold=margin_threshold,
        input_kind=input_kind,
    )
    return 0

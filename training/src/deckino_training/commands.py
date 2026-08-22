from __future__ import annotations

import json
import os
import platform
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

import torch
from PIL import Image
from torch.nn import functional as F
from torch.utils.data import DataLoader

from . import __version__
from .events import emit
from .manifest import prepare_dataset, validate_manifest
from .model import (
    ArcMarginProduct,
    CardDataset,
    EmbeddingNetwork,
    build_evaluation_transform,
    build_train_transform,
    crop_card_art,
    evaluate_model,
)

ARTIFACT_SCHEMA_VERSION = 1


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _resolve_device(requested: str) -> torch.device:
    if requested == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    device = torch.device(requested)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA/ROCm device requested but torch.cuda.is_available() is false")
    return device


def doctor() -> int:
    hip_version = getattr(torch.version, "hip", None)
    cuda_version = getattr(torch.version, "cuda", None)
    devices = [torch.cuda.get_device_name(index) for index in range(torch.cuda.device_count())]
    healthy_gpu = bool(torch.cuda.is_available() and (hip_version or cuda_version))
    emit(
        "doctor",
        cli_version=__version__,
        python=sys.version.split()[0],
        platform=platform.platform(),
        wsl="microsoft" in platform.release().lower() or "WSL_DISTRO_NAME" in os.environ,
        torch=torch.__version__,
        hip=hip_version,
        cuda=cuda_version,
        accelerator_available=torch.cuda.is_available(),
        devices=devices,
        status="ok" if healthy_gpu else "cpu-only",
    )
    return 0


def prepare(data_root: Path, output_root: Path, dataset_version: str, max_classes: int | None) -> int:
    emit(
        "prepare_started",
        data_root=str(data_root),
        output_root=str(output_root),
        dataset_version=dataset_version,
    )
    report = prepare_dataset(data_root, output_root, dataset_version, max_classes)
    emit("prepare_completed", **asdict(report))
    return 0


def _labels(records: list) -> tuple[list[dict[str, Any]], dict[str, int]]:
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
        "model_state": model.state_dict(),
        "head_state": head.state_dict(),
        "optimizer_state": optimizer.state_dict(),
    }


def _load_checkpoint(path: Path, device: torch.device) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {path}")
    checkpoint = torch.load(path, map_location=device, weights_only=True)
    if checkpoint.get("artifact_schema_version") != ARTIFACT_SCHEMA_VERSION:
        raise ValueError("Unsupported checkpoint artifact schema")
    return checkpoint


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
) -> int:
    records, dataset_root = validate_manifest(manifest_path)
    dataset_version = records[0].dataset_version
    labels, label_to_index = _labels(records)
    train_records = [record for record in records if record.split == "train"]
    validation_records = [record for record in records if record.split == "validation"]
    if not train_records:
        raise ValueError("Manifest has no training records")
    if not validation_records:
        raise ValueError("Manifest has no held-out validation records")
    if epochs < 1 or batch_size < 2 or embedding_dim < 32:
        raise ValueError("epochs must be >= 1, batch_size >= 2, and embedding_dim >= 32")

    device = _resolve_device(device_name)
    artifact_root = artifacts_root.resolve() / model_version
    if resume_path is None and artifact_root.exists() and any(artifact_root.iterdir()):
        raise ValueError(
            f"Artifact version already exists: {artifact_root}. Use a new --model-version or --resume."
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
        "pretrained": pretrained,
        "image_size": 224,
        "arcface_scale": 30.0,
        "arcface_margin": 0.35,
    }
    _write_json(artifact_root / "config.json", config)
    _write_json(
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
        checkpoint_oracles = [item["oracle_id"] for item in checkpoint["labels"]]
        current_oracles = [item["oracle_id"] for item in labels]
        if checkpoint_oracles != current_oracles:
            raise ValueError("Resume checkpoint label mapping does not match the manifest")
        model.load_state_dict(checkpoint["model_state"])
        head.load_state_dict(checkpoint["head_state"])
        optimizer.load_state_dict(checkpoint["optimizer_state"])
        start_epoch = int(checkpoint["epoch"]) + 1
        best_top1 = float(checkpoint["best_top1"])

    training_dataset = CardDataset(
        dataset_root, train_records, label_to_index, build_train_transform()
    )
    validation_dataset = CardDataset(
        dataset_root,
        validation_records,
        label_to_index,
        build_evaluation_transform(simulated_camera=True),
        deterministic=True,
    )
    training_loader = DataLoader(
        training_dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=workers,
        pin_memory=device.type == "cuda",
        drop_last=len(training_dataset) % batch_size == 1,
    )
    validation_loader = DataLoader(
        validation_dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=workers,
        pin_memory=device.type == "cuda",
    )
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    emit(
        "training_started",
        dataset_version=dataset_version,
        model_version=model_version,
        device=str(device),
        classes=len(labels),
        train_samples=len(training_dataset),
        validation_samples=len(validation_dataset),
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
        for batch_index, (images, targets, _printing_ids) in enumerate(training_loader):
            if max_batches is not None and batch_index >= max_batches:
                break
            images = images.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, enabled=device.type == "cuda"):
                logits = head(model(images), targets)
                loss = F.cross_entropy(logits, targets)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            running_loss += float(loss.detach().item())
            batches += 1
            emit(
                "training_progress",
                epoch=epoch + 1,
                epochs=epochs,
                batch=batch_index + 1,
                batches=len(training_loader) if max_batches is None else min(len(training_loader), max_batches),
                loss=float(loss.detach().item()),
            )
        if batches == 0:
            raise ValueError("Training produced no batches; increase the dataset or reduce batch size")

        evaluation = evaluate_model(model, head, validation_loader, index_to_oracle, device)
        is_best = evaluation.top1 >= best_top1
        best_top1 = max(best_top1, evaluation.top1)
        payload = _checkpoint_payload(model, head, optimizer, epoch, best_top1, config, labels)
        torch.save(payload, artifact_root / "last.pt")
        if is_best:
            torch.save(payload, artifact_root / "best.pt")
        report = {
            "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
            "dataset_version": dataset_version,
            "model_version": model_version,
            "epoch": epoch + 1,
            "loss": running_loss / batches,
            **asdict(evaluation),
        }
        _write_json(artifact_root / "evaluation.json", report)
        emit("epoch_completed", **report)
    emit("training_completed", artifact_root=str(artifact_root), best_top1=best_top1)
    return 0


def _restore_for_inference(
    checkpoint_path: Path, device: torch.device
) -> tuple[dict[str, Any], EmbeddingNetwork, ArcMarginProduct]:
    checkpoint = _load_checkpoint(checkpoint_path, device)
    config = checkpoint["config"]
    model = EmbeddingNetwork(config["embedding_dim"], pretrained=False).to(device)
    head = ArcMarginProduct(config["embedding_dim"], len(checkpoint["labels"])).to(device)
    model.load_state_dict(checkpoint["model_state"])
    head.load_state_dict(checkpoint["head_state"])
    model.eval()
    head.eval()
    return checkpoint, model, head


def evaluate(manifest_path: Path, checkpoint_path: Path, device_name: str, batch_size: int, workers: int) -> int:
    records, root = validate_manifest(manifest_path)
    device = _resolve_device(device_name)
    checkpoint, model, head = _restore_for_inference(checkpoint_path, device)
    if checkpoint["dataset_version"] != records[0].dataset_version:
        raise ValueError("Checkpoint dataset version does not match the manifest")
    labels = checkpoint["labels"]
    label_to_index = {item["oracle_id"]: item["index"] for item in labels}
    validation_records = [record for record in records if record.split == "validation"]
    if not validation_records:
        raise ValueError("Manifest has no held-out validation records")
    unknown = sorted({record.oracle_id for record in validation_records} - set(label_to_index))
    if unknown:
        raise ValueError(f"Validation manifest contains {len(unknown)} unknown oracle IDs")
    dataset = CardDataset(
        root,
        validation_records,
        label_to_index,
        build_evaluation_transform(simulated_camera=True),
        deterministic=True,
    )
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=workers)
    result = evaluate_model(
        model, head, loader, [item["oracle_id"] for item in labels], device
    )
    report = {
        "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
        "dataset_version": checkpoint["dataset_version"],
        "model_version": checkpoint["model_version"],
        **asdict(result),
    }
    output = checkpoint_path.parent / "evaluation.json"
    _write_json(output, report)
    emit("evaluation_completed", report_path=str(output), **report)
    return 0


@torch.inference_mode()
def recognize(
    checkpoint_path: Path,
    image_path: Path,
    device_name: str,
    score_threshold: float,
    margin_threshold: float,
    input_kind: str = "auto",
) -> int:
    if not image_path.is_file():
        raise FileNotFoundError(f"Image not found: {image_path}")
    device = _resolve_device(device_name)
    checkpoint, model, head = _restore_for_inference(checkpoint_path, device)
    with Image.open(image_path) as source:
        image = source.convert("RGB")
    image = crop_card_art(image, input_kind)
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

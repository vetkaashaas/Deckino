from __future__ import annotations

import hashlib
import json
import math
import random
import sqlite3
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, UnidentifiedImageError
from torch import Tensor
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision.transforms import functional as TF

from .events import emit
from .model import (
    IMAGE_SIZE,
    NORMALIZE_MEAN,
    NORMALIZE_STD,
    ArcMarginProduct,
    EmbeddingNetwork,
    build_train_transform,
)

ARTWORK_MANIFEST_SCHEMA_VERSION = 4
ARTWORK_ARTIFACT_SCHEMA_VERSION = 4
INDEX_SCHEMA_VERSION = 1
STRICT_TOP1 = 0.995
STRICT_TOP5 = 0.999
STRICT_PRECISION = 0.999
STRICT_COVERAGE = 0.95


@dataclass(frozen=True)
class ArtworkRecord:
    dataset_version: str
    image_path: str
    artwork_id: str
    illustration_id: str | None
    oracle_id: str
    oracle_ids: list[str]
    oracle_names: dict[str, str]
    printing_id: str
    card_name: str
    category: str
    role: str
    view_profile: str
    view_seed: int
    input_kind: str = "art"


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _seed(value: str) -> int:
    return int(_hash(value)[:15], 16)


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _write_jsonl(path: Path, values: Iterable[object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for value in values:
            stream.write(json.dumps(value, ensure_ascii=False, sort_keys=True))
            stream.write("\n")


def _category(name: str, type_line: str | None) -> str:
    if name in {"Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"}:
        return "basic_land"
    if type_line and "token" in type_line.casefold():
        return "token"
    return "card"


def prepare_artwork_dataset(data_root: Path, dataset_version: str) -> dict[str, Any]:
    data_root = data_root.resolve()
    connection = sqlite3.connect(data_root / "deckino.db")
    connection.row_factory = sqlite3.Row
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(cards)")}
        required = {"oracle_id", "illustration_id", "is_paper"}
        missing = required - columns
        if missing:
            raise ValueError(
                "Database is missing " + ", ".join(f"cards.{item}" for item in sorted(missing))
                + "; run Deckino.Toolbox and complete Scryfall Sync"
            )
        eligibility = connection.execute(
            """
            SELECT
              SUM(CASE WHEN is_paper = 1 THEN 1 ELSE 0 END) AS paper_rows,
              SUM(CASE WHEN is_paper = 1 AND oracle_id IS NULL THEN 1 ELSE 0 END) AS missing_oracle,
              SUM(CASE WHEN is_paper = 1 AND art_crop_uri IS NULL THEN 1 ELSE 0 END) AS missing_art_crop,
              SUM(CASE WHEN is_paper = 1 AND oracle_id IS NOT NULL AND art_crop_uri IS NOT NULL
                        AND NOT EXISTS (
                          SELECT 1 FROM art_downloads d
                          WHERE d.scryfall_id = cards.scryfall_id
                            AND d.status = 'downloaded' AND d.file_path IS NOT NULL
                        ) THEN 1 ELSE 0 END) AS incomplete_download
            FROM cards
            """
        ).fetchone()
        rows = connection.execute(
            """
            SELECT c.scryfall_id, c.oracle_id, c.illustration_id, c.name,
                   o.type_line, d.file_path
            FROM cards c
            JOIN art_downloads d ON d.scryfall_id = c.scryfall_id
            LEFT JOIN oracle_cards o ON o.oracle_id = c.oracle_id
            WHERE c.is_paper = 1 AND c.oracle_id IS NOT NULL
              AND c.art_crop_uri IS NOT NULL AND d.status = 'downloaded'
              AND d.file_path IS NOT NULL
            ORDER BY COALESCE(c.illustration_id, c.scryfall_id), c.scryfall_id
            """
        ).fetchall()
    finally:
        connection.close()

    eligible: dict[str, sqlite3.Row] = {}
    fallback_ids: list[str] = []
    excluded_missing = 0
    excluded_corrupt = 0
    artwork_oracles: dict[str, set[str]] = defaultdict(set)
    artwork_names: dict[str, dict[str, str]] = defaultdict(dict)
    for index, row in enumerate(rows, start=1):
        source = Path(row["file_path"])
        if not source.is_file():
            excluded_missing += 1
            continue
        try:
            with Image.open(source) as image:
                image.verify()
        except (OSError, UnidentifiedImageError):
            excluded_corrupt += 1
            continue
        artwork_id = row["illustration_id"] or f"printing:{row['scryfall_id']}"
        if row["illustration_id"] is None:
            fallback_ids.append(artwork_id)
        artwork_oracles[artwork_id].add(row["oracle_id"])
        artwork_names[artwork_id][row["oracle_id"]] = row["name"]
        eligible.setdefault(artwork_id, row)
        if index % 500 == 0 or index == len(rows):
            emit(
                "prepare_artwork_progress",
                scanned=index,
                total=len(rows),
                artworks=len(eligible),
                missing=excluded_missing,
                corrupt=excluded_corrupt,
            )
    conflicts = {key: sorted(value) for key, value in artwork_oracles.items() if len(value) > 1}
    if len(eligible) < 2:
        raise ValueError("Fewer than two artwork identities are eligible")

    records: list[ArtworkRecord] = []
    labels: list[dict[str, Any]] = []
    roles = (
        ("prototype", "clean"),
        ("calibration", "medium"),
        ("test", "mild"),
        ("test", "medium"),
        ("diagnostic", "severe"),
    )
    for artwork_index, artwork_id in enumerate(sorted(eligible, key=_hash)):
        row = eligible[artwork_id]
        oracle_ids = sorted(artwork_oracles[artwork_id])
        source = Path(row["file_path"])
        try:
            relative = source.resolve().relative_to(data_root).as_posix()
        except ValueError as error:
            raise ValueError(f"Cached image is outside the data root: {source}") from error
        category = _category(row["name"], row["type_line"])
        labels.append(
            {
                "index": artwork_index,
                "artwork_id": artwork_id,
                "illustration_id": row["illustration_id"],
                "oracle_id": row["oracle_id"],
                "oracle_ids": oracle_ids,
                "oracle_names": artwork_names[artwork_id],
                "ambiguous": len(oracle_ids) > 1,
                "printing_id": row["scryfall_id"],
                "card_name": row["name"],
                "category": category,
            }
        )
        artwork_roles = (("prototype", "clean"),) if len(oracle_ids) > 1 else roles
        for role, profile in artwork_roles:
            records.append(
                ArtworkRecord(
                    dataset_version=dataset_version,
                    image_path=relative,
                    artwork_id=artwork_id,
                    illustration_id=row["illustration_id"],
                    oracle_id=row["oracle_id"],
                    oracle_ids=oracle_ids,
                    oracle_names=artwork_names[artwork_id],
                    printing_id=row["scryfall_id"],
                    card_name=row["name"],
                    category=category,
                    role=role,
                    view_profile=profile,
                    view_seed=_seed(f"{artwork_id}:{role}:{profile}"),
                )
            )
    records.sort(key=lambda item: (_hash(item.artwork_id), item.role, item.view_profile))
    root = data_root / "exports" / dataset_version
    metadata = {
        "schema_version": ARTWORK_MANIFEST_SCHEMA_VERSION,
        "dataset_version": dataset_version,
        "image_root": "../..",
        "artworks": len(labels),
        "oracle_cards": len({oracle_id for item in labels for oracle_id in item["oracle_ids"]}),
        "records": len(records),
        "roles": dict(Counter(item.role for item in records)),
    }
    report = {
        **metadata,
        "fallback_artwork_ids": len(fallback_ids),
        "fallback_examples": fallback_ids[:100],
        "excluded_missing": excluded_missing,
        "excluded_corrupt": excluded_corrupt,
        "paper_printings_scanned": int(eligibility["paper_rows"] or 0),
        "excluded_missing_oracle": int(eligibility["missing_oracle"] or 0),
        "excluded_missing_art_crop": int(eligibility["missing_art_crop"] or 0),
        "excluded_incomplete_download": int(eligibility["incomplete_download"] or 0),
        "ambiguous_illustrations": len(conflicts),
        "ambiguous_oracle_mappings": sum(len(value) for value in conflicts.values()),
        "ambiguous_examples": [
            {"artwork_id": artwork_id, "oracle_ids": oracle_ids}
            for artwork_id, oracle_ids in sorted(conflicts.items())[:100]
        ],
    }
    _write_json(root / "metadata.json", metadata)
    _write_json(root / "labels.json", {**metadata, "labels": labels})
    _write_json(root / "report.json", report)
    # The manifest is the workflow completion marker, so publish it last.
    _write_jsonl(root / "manifest.jsonl", (asdict(item) for item in records))
    emit("artwork_dataset_prepared", **report)
    return report


def read_artwork_manifest(path: Path) -> tuple[list[ArtworkRecord], Path]:
    metadata_path = path.parent / "metadata.json"
    if not metadata_path.is_file():
        raise ValueError("Artwork manifest metadata is missing")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("schema_version") != ARTWORK_MANIFEST_SCHEMA_VERSION:
        raise ValueError("Artwork manifests require schema v4")
    root = (path.parent / metadata["image_root"]).resolve()
    records: list[ArtworkRecord] = []
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                records.append(ArtworkRecord(**json.loads(line)))
    if not records or any(item.dataset_version != metadata["dataset_version"] for item in records):
        raise ValueError("Artwork manifest is empty or version-inconsistent")
    return records, root


def _view(image: Image.Image, profile: str, seed: int) -> Tensor:
    image = image.convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.BICUBIC)
    if profile != "clean":
        rng = random.Random(seed)
        strength = {"mild": 0.45, "medium": 0.8, "severe": 1.25}[profile]
        image = ImageEnhance.Brightness(image).enhance(1.0 + rng.uniform(-0.18, 0.18) * strength)
        image = ImageEnhance.Contrast(image).enhance(1.0 + rng.uniform(-0.16, 0.16) * strength)
        image = ImageEnhance.Color(image).enhance(1.0 + rng.uniform(-0.12, 0.12) * strength)
        if rng.random() < 0.65:
            image = image.filter(ImageFilter.GaussianBlur(rng.uniform(0.15, 0.8) * strength))
        angle = rng.uniform(-3.0, 3.0) * strength
        image = image.rotate(angle, resample=Image.Resampling.BICUBIC)
        if rng.random() < 0.55:
            overlay = Image.new("RGB", image.size, "white")
            band = max(2, int(IMAGE_SIZE * rng.uniform(0.03, 0.10) * strength))
            left = rng.randrange(-band, IMAGE_SIZE)
            mask = Image.new("L", image.size, 0)
            opacity = int(255 * rng.uniform(0.08, 0.25))
            ImageDraw.Draw(mask).rectangle(
                (max(0, left), 0, min(IMAGE_SIZE, left + band), IMAGE_SIZE),
                fill=opacity,
            )
            image = Image.composite(overlay, image, mask)
    tensor = TF.to_tensor(image)
    return TF.normalize(tensor, NORMALIZE_MEAN, NORMALIZE_STD)


class ArtworkViewDataset(Dataset[tuple[Tensor, int]]):
    def __init__(self, root: Path, records: Sequence[ArtworkRecord], oracle_indices: dict[str, int]):
        self.root = root
        self.records = list(records)
        self.oracle_indices = oracle_indices

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> tuple[Tensor, int]:
        record = self.records[index]
        with Image.open(self.root / record.image_path) as source:
            tensor = _view(source, record.view_profile, record.view_seed)
        return tensor, self.oracle_indices[record.oracle_id]


def _load_embedding(checkpoint_path: Path, device: torch.device) -> tuple[dict[str, Any], EmbeddingNetwork]:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    schema = int(checkpoint.get("artifact_schema_version", 0))
    if schema not in {3, 4}:
        raise ValueError("Prototype indexing supports checkpoint schema v3 or v4")
    config = checkpoint["config"]
    model = EmbeddingNetwork(int(config["embedding_dim"]), pretrained=False)
    model.load_state_dict(checkpoint["model_state"])
    model.to(device).eval()
    return checkpoint, model


def _device(name: str, cuda_index: int | None) -> torch.device:
    if name == "cpu":
        return torch.device("cpu")
    if name == "auto" and not torch.cuda.is_available():
        return torch.device("cpu")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available")
    index = 0 if cuda_index is None else cuda_index
    torch.cuda.set_device(index)
    return torch.device("cuda", index)


class PairedArtworkDataset(Dataset[tuple[Tensor, Tensor, int]]):
    def __init__(self, root: Path, records: Sequence[ArtworkRecord]) -> None:
        self.root = root
        self.records = list(records)
        self.transform = build_train_transform()

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> tuple[Tensor, Tensor, int]:
        record = self.records[index]
        with Image.open(self.root / record.image_path) as source:
            image = source.convert("RGB")
        return self.transform(image), self.transform(image), index


def _supervised_contrastive_loss(embeddings: Tensor, labels: Tensor, temperature: float) -> Tensor:
    similarities = embeddings @ embeddings.T / temperature
    diagonal = torch.eye(embeddings.shape[0], dtype=torch.bool, device=embeddings.device)
    positives = labels.unsqueeze(0).eq(labels.unsqueeze(1)) & ~diagonal
    logits = similarities.masked_fill(diagonal, -torch.inf)
    log_probabilities = logits - torch.logsumexp(logits, dim=1, keepdim=True)
    return -(log_probabilities.masked_fill(~positives, 0).sum(dim=1) / positives.sum(dim=1)).mean()


def _save_artwork_checkpoint(
    path: Path,
    model: EmbeddingNetwork,
    head: ArcMarginProduct,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler,
    config: dict[str, Any],
    epoch: int,
    best_loss: float,
    best_epoch: int,
    epochs_without_improvement: int,
) -> None:
    def cpu_backed(value: Any) -> Any:
        if isinstance(value, Tensor):
            return value.detach().cpu()
        if isinstance(value, dict):
            return {key: cpu_backed(item) for key, item in value.items()}
        if isinstance(value, list):
            return [cpu_backed(item) for item in value]
        if isinstance(value, tuple):
            return tuple(cpu_backed(item) for item in value)
        return value

    payload = {
        "artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION,
        "identity_key": "artwork_id",
        "dataset_version": config["dataset_version"],
        "model_version": config["model_version"],
        "completed_epoch": epoch,
        "best_loss": best_loss,
        "best_epoch": best_epoch,
        "epochs_without_improvement": epochs_without_improvement,
        "model_state": {key: value.detach().cpu() for key, value in model.state_dict().items()},
        "head_state": {key: value.detach().cpu() for key, value in head.state_dict().items()},
        "optimizer_state": cpu_backed(optimizer.state_dict()),
        "scheduler_state": scheduler.state_dict(),
        "config": config,
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(payload, temporary)
    temporary.replace(path)


def train_artwork(
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
    seed: int,
    cuda_device_index: int | None,
) -> dict[str, Any]:
    if epochs < 1 or batch_size < 2:
        raise ValueError("epochs must be positive and paired artwork batch size must be at least two")
    torch.manual_seed(seed)
    random.seed(seed)
    np.random.seed(seed)
    records, root = read_artwork_manifest(manifest_path)
    prototypes = [item for item in records if item.role == "prototype"]
    device = _device(device_name, cuda_device_index)
    model = EmbeddingNetwork(embedding_dim, pretrained=pretrained).to(device)
    head = ArcMarginProduct(embedding_dim, len(prototypes)).to(device)
    optimizer = torch.optim.AdamW(
        list(model.parameters()) + list(head.parameters()), lr=learning_rate, weight_decay=1e-4
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, epochs))
    start_epoch = 0
    best_loss = math.inf
    best_epoch = 0
    epochs_without_improvement = 0
    config = {
        "dataset_version": records[0].dataset_version,
        "model_version": model_version,
        "embedding_dim": embedding_dim,
        "artwork_classes": len(prototypes),
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "workers": workers,
        "seed": seed,
        "pretrained": pretrained,
        "arcface_margin": 0.35,
        "contrastive_weight": 0.2,
        "contrastive_temperature": 0.07,
    }
    if resume_path is not None:
        checkpoint = torch.load(resume_path, map_location="cpu", weights_only=False)
        if checkpoint.get("artifact_schema_version") != ARTWORK_ARTIFACT_SCHEMA_VERSION:
            raise ValueError("Artwork training can only resume artifact schema v4 checkpoints")
        if checkpoint.get("identity_key") != "artwork_id":
            raise ValueError("Checkpoint identity key is not artwork_id")
        if checkpoint.get("dataset_version") != config["dataset_version"]:
            raise ValueError("Checkpoint dataset version does not match the manifest")
        if checkpoint.get("model_version") != model_version:
            raise ValueError("Checkpoint model version does not match the requested run")
        saved_config = checkpoint.get("config", {})
        if int(saved_config.get("embedding_dim", -1)) != embedding_dim:
            raise ValueError("Checkpoint embedding dimension is incompatible")
        if int(saved_config.get("artwork_classes", -1)) != len(prototypes):
            raise ValueError("Checkpoint artwork label count is incompatible")
        model.load_state_dict(checkpoint["model_state"])
        head.load_state_dict(checkpoint["head_state"])
        optimizer.load_state_dict(checkpoint["optimizer_state"])
        for optimizer_state in optimizer.state.values():
            for key, value in optimizer_state.items():
                if isinstance(value, Tensor):
                    optimizer_state[key] = value.to(device)
        scheduler.load_state_dict(checkpoint["scheduler_state"])
        start_epoch = int(checkpoint["completed_epoch"])
        best_loss = float(checkpoint.get("best_loss", math.inf))
        best_epoch = int(checkpoint.get("best_epoch", start_epoch))
        epochs_without_improvement = int(checkpoint.get("epochs_without_improvement", 0))
        emit("artwork_checkpoint_resumed", completed_epoch=start_epoch, optimizer_state=True)
    output = artifacts_root / model_version
    output.mkdir(parents=True, exist_ok=True)
    _write_json(output / "configuration.json", {
        "artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION,
        **config,
        "epochs": epochs,
    })
    loader = DataLoader(
        PairedArtworkDataset(root, prototypes),
        batch_size=max(1, batch_size // 2),
        shuffle=True,
        num_workers=workers,
        pin_memory=device.type == "cuda",
        drop_last=True,
    )
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    completed_epoch = start_epoch
    for epoch in range(start_epoch + 1, epochs + 1):
        started = time.monotonic()
        model.train()
        head.train()
        total_loss = 0.0
        batches = 0
        for first, second, artwork_labels in loader:
            images = torch.cat((first, second)).to(device, non_blocking=True)
            artwork_labels = artwork_labels.to(device)
            labels = torch.cat((artwork_labels, artwork_labels))
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, enabled=device.type == "cuda"):
                embeddings = model(images)
            logits = head(embeddings.float(), labels)
            arcface_loss = nn.functional.cross_entropy(logits, labels)
            contrastive_loss = _supervised_contrastive_loss(embeddings.float(), labels, 0.07)
            loss = arcface_loss + 0.2 * contrastive_loss
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            total_loss += float(loss.detach())
            batches += 1
        scheduler.step()
        epoch_loss = total_loss / max(1, batches)
        improved = epoch_loss < best_loss - 1e-5
        if improved:
            best_loss = epoch_loss
            best_epoch = epoch
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
        _save_artwork_checkpoint(
            output / "last.pt", model, head, optimizer, scheduler, config, epoch, best_loss,
            best_epoch, epochs_without_improvement,
        )
        if improved:
            _save_artwork_checkpoint(
                output / "best.pt", model, head, optimizer, scheduler, config, epoch, best_loss,
                best_epoch, epochs_without_improvement,
            )
        emit(
            "artwork_epoch_completed",
            epoch=epoch,
            epochs=epochs,
            loss=epoch_loss,
            elapsed_seconds=time.monotonic() - started,
        )
        completed_epoch = epoch
        if epoch >= 10 and epochs_without_improvement >= 5:
            emit(
                "artwork_early_stopped",
                completed_epoch=epoch,
                best_epoch=best_epoch,
                patience=5,
            )
            break
    return {"model_version": model_version, "completed_epoch": completed_epoch, "best_loss": best_loss}


@torch.inference_mode()
def build_index(
    manifest_path: Path,
    checkpoint_path: Path,
    output_root: Path,
    device_name: str,
    batch_size: int,
    cuda_device_index: int | None,
) -> dict[str, Any]:
    records, root = read_artwork_manifest(manifest_path)
    prototypes = [item for item in records if item.role == "prototype"]
    device = _device(device_name, cuda_device_index)
    checkpoint, model = _load_embedding(checkpoint_path, device)
    vectors: list[np.ndarray] = []
    labels: list[dict[str, Any]] = []
    for start in range(0, len(prototypes), batch_size):
        batch_records = prototypes[start : start + batch_size]
        batch_views: list[Tensor] = []
        for record in batch_records:
            with Image.open(root / record.image_path) as source:
                image = source.convert("RGB")
                views = [_view(image, "clean", record.view_seed)]
                views.extend(_view(image, "mild", record.view_seed + offset) for offset in range(1, 5))
                batch_views.append(torch.stack(views))
        images = torch.cat(batch_views)
        embedded_chunks = [
            model(images[offset : offset + batch_size].to(device))
            for offset in range(0, images.shape[0], batch_size)
        ]
        embedded = torch.cat(embedded_chunks).reshape(len(batch_records), 5, -1).mean(dim=1)
        embedded = torch.nn.functional.normalize(embedded, dim=1)
        vectors.append(embedded.cpu().numpy().astype(np.float32))
        labels.extend(
            {
                "index": start + offset,
                "artwork_id": item.artwork_id,
                "oracle_id": item.oracle_id,
                "oracle_ids": item.oracle_ids,
                "oracle_names": item.oracle_names,
                "ambiguous": len(item.oracle_ids) > 1,
                "printing_id": item.printing_id,
                "card_name": item.card_name,
                "category": item.category,
            }
            for offset, item in enumerate(batch_records)
        )
        emit("index_progress", completed=min(start + batch_size, len(prototypes)), total=len(prototypes))
    matrix = np.concatenate(vectors)
    output_root.mkdir(parents=True, exist_ok=True)
    vector_path = output_root / "index.f32"
    matrix.tofile(vector_path)
    metadata = {
        "index_schema_version": INDEX_SCHEMA_VERSION,
        "artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION,
        "dataset_version": prototypes[0].dataset_version,
        "checkpoint_model_version": checkpoint["model_version"],
        "checkpoint_file": checkpoint_path.name,
        "count": len(labels),
        "embedding_dimension": int(matrix.shape[1]),
        "dtype": "float32",
        "normalization": "l2",
        "vectors_sha256": hashlib.sha256(vector_path.read_bytes()).hexdigest(),
        "labels_sha256": hashlib.sha256(
            json.dumps(labels, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }
    _write_json(output_root / "index-metadata.json", metadata)
    _write_json(output_root / "index-labels.json", {**metadata, "labels": labels})
    inference_checkpoint = output_root.parent / "embedding.pt"
    inference_temporary = inference_checkpoint.with_suffix(".pt.tmp")
    torch.save(
        {
            "artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION,
            "identity_key": "artwork_prototype",
            "dataset_version": prototypes[0].dataset_version,
            "model_version": checkpoint["model_version"],
            "source_checkpoint": checkpoint_path.name,
            "config": {"embedding_dim": int(matrix.shape[1])},
            "model_state": {key: value.detach().cpu() for key, value in model.state_dict().items()},
        },
        inference_temporary,
    )
    inference_temporary.replace(inference_checkpoint)
    emit("prototype_index_built", **metadata)
    return metadata


def _load_index(index_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], np.ndarray]:
    metadata = json.loads((index_root / "index-metadata.json").read_text(encoding="utf-8"))
    if metadata.get("index_schema_version") != INDEX_SCHEMA_VERSION:
        raise ValueError("Unsupported prototype index schema")
    if metadata.get("artifact_schema_version") != ARTWORK_ARTIFACT_SCHEMA_VERSION:
        raise ValueError("Prototype index requires artifact schema v4")
    vector_path = index_root / "index.f32"
    if hashlib.sha256(vector_path.read_bytes()).hexdigest() != metadata["vectors_sha256"]:
        raise ValueError("Prototype index checksum mismatch")
    labels = json.loads((index_root / "index-labels.json").read_text(encoding="utf-8"))["labels"]
    labels_hash = hashlib.sha256(
        json.dumps(labels, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if labels_hash != metadata.get("labels_sha256") or len(labels) != int(metadata["count"]):
        raise ValueError("Prototype index labels checksum or count mismatch")
    vectors = np.fromfile(vector_path, dtype=np.float32).reshape(
        int(metadata["count"]), int(metadata["embedding_dimension"])
    )
    return metadata, labels, vectors


def _thresholds(scores: np.ndarray, margins: np.ndarray, correct: np.ndarray) -> dict[str, Any]:
    best: tuple[float, float, float, float] | None = None
    for score_threshold in np.linspace(-0.2, 0.95, 116):
        for margin_threshold in np.linspace(0.0, 0.30, 61):
            accepted = (scores >= score_threshold) & (margins >= margin_threshold)
            coverage = float(accepted.mean())
            precision = float(correct[accepted].mean()) if accepted.any() else 0.0
            if precision >= STRICT_PRECISION and coverage >= STRICT_COVERAGE:
                candidate = (coverage, precision, float(score_threshold), float(margin_threshold))
                if best is None or candidate[:2] > best[:2]:
                    best = candidate
    if best is None:
        candidates: list[tuple[float, float, float, float]] = []
        for score_threshold in np.linspace(-0.2, 0.95, 116):
            for margin_threshold in np.linspace(0.0, 0.30, 61):
                accepted = (scores >= score_threshold) & (margins >= margin_threshold)
                precision = float(correct[accepted].mean()) if accepted.any() else 0.0
                candidates.append((precision, float(accepted.mean()), float(score_threshold), float(margin_threshold)))
        precision, coverage, score_threshold, margin_threshold = max(candidates)
    else:
        coverage, precision, score_threshold, margin_threshold = best
    return {
        "score_threshold": score_threshold,
        "margin_threshold": margin_threshold,
        "target_precision": STRICT_PRECISION,
        "minimum_coverage": STRICT_COVERAGE,
        "calibration_precision": precision,
        "calibration_coverage": coverage,
        "qualified": precision >= STRICT_PRECISION and coverage >= STRICT_COVERAGE,
    }


@torch.inference_mode()
def _predict(
    model: EmbeddingNetwork,
    records: Sequence[ArtworkRecord],
    root: Path,
    index_vectors: np.ndarray,
    index_labels: list[dict[str, Any]],
    device: torch.device,
    batch_size: int,
) -> list[dict[str, Any]]:
    oracle_ids = sorted({oracle_id for item in index_labels for oracle_id in item.get("oracle_ids", [item["oracle_id"]])})
    oracle_to_index = {value: index for index, value in enumerate(oracle_ids)}
    expanded_prototypes = [
        (prototype_index, oracle_to_index[oracle_id])
        for prototype_index, item in enumerate(index_labels)
        for oracle_id in item.get("oracle_ids", [item["oracle_id"]])
    ]
    expanded_prototype_indices = torch.tensor(
        [item[0] for item in expanded_prototypes], device=device
    )
    prototype_oracles = torch.tensor([item[1] for item in expanded_prototypes], device=device)
    oracle_prototype_indices = {
        oracle_index: torch.nonzero(prototype_oracles == oracle_index, as_tuple=False).flatten()
        for oracle_index in range(len(oracle_ids))
    }
    prototypes = torch.from_numpy(index_vectors).to(device)
    loader = DataLoader(ArtworkViewDataset(root, records, oracle_to_index), batch_size=batch_size)
    results: list[dict[str, Any]] = []
    record_offset = 0
    for images, actual in loader:
        images = images.to(device)
        query = model(images)
        similarities = query @ prototypes.T
        expanded_similarities = similarities[:, expanded_prototype_indices]
        collapsed = torch.full(
            (images.shape[0], len(oracle_ids)), -math.inf, device=device
        )
        collapsed.scatter_reduce_(
            1,
            prototype_oracles.unsqueeze(0).expand(images.shape[0], -1),
            expanded_similarities,
            reduce="amax",
            include_self=True,
        )
        values, indices = collapsed.topk(min(5, len(oracle_ids)), dim=1)
        for row in range(images.shape[0]):
            record = records[record_offset + row]
            candidates: list[dict[str, Any]] = []
            for rank in range(indices.shape[1]):
                oracle_index = int(indices[row, rank])
                expanded_indices = oracle_prototype_indices[oracle_index]
                winning_offset = int(expanded_similarities[row, expanded_indices].argmax())
                prototype_index = int(expanded_prototype_indices[expanded_indices[winning_offset]])
                prototype_label = index_labels[prototype_index]
                candidates.append(
                    {
                        "oracle_id": oracle_ids[oracle_index],
                        "score": float(values[row, rank]),
                        "artwork_id": prototype_label["artwork_id"],
                        "printing_id": prototype_label["printing_id"],
                        "card_name": prototype_label["card_name"],
                        "ambiguous_artwork": bool(prototype_label.get("ambiguous", False)),
                    }
                )
            results.append(
                {
                    "artwork_id": record.artwork_id,
                    "actual_oracle_id": record.oracle_id,
                    "category": record.category,
                    "view_profile": record.view_profile,
                    "predicted_oracle_id": candidates[0]["oracle_id"],
                    "predicted_artwork_id": candidates[0]["artwork_id"],
                    "predicted_printing_id": candidates[0]["printing_id"],
                    "score": candidates[0]["score"],
                    "margin": candidates[0]["score"] - candidates[1]["score"],
                    "top5_correct": any(item["oracle_id"] == record.oracle_id for item in candidates),
                    "candidates": candidates,
                }
            )
        record_offset += images.shape[0]
        emit("index_evaluation_progress", completed=record_offset, total=len(records))
    return results


def _metrics(predictions: Sequence[dict[str, Any]], thresholds: dict[str, Any]) -> dict[str, Any]:
    score = float(thresholds["score_threshold"])
    margin = float(thresholds["margin_threshold"])
    correct = [item["actual_oracle_id"] == item["predicted_oracle_id"] for item in predictions]
    accepted = [item["score"] >= score and item["margin"] >= margin for item in predictions]
    accepted_count = sum(accepted)
    accepted_correct = sum(ok and take for ok, take in zip(correct, accepted, strict=True))
    return {
        "samples": len(predictions),
        "top1": sum(correct) / len(predictions),
        "top5": sum(bool(item["top5_correct"]) for item in predictions) / len(predictions),
        "accepted": accepted_count,
        "accepted_precision": accepted_correct / accepted_count if accepted_count else 0.0,
        "coverage": accepted_count / len(predictions),
    }


def evaluate_index(
    manifest_path: Path,
    checkpoint_path: Path,
    index_root: Path,
    output_path: Path,
    device_name: str,
    batch_size: int,
    cuda_device_index: int | None,
) -> dict[str, Any]:
    records, root = read_artwork_manifest(manifest_path)
    metadata, labels, vectors = _load_index(index_root)
    if metadata["dataset_version"] != records[0].dataset_version:
        raise ValueError("Index dataset version does not match artwork manifest")
    device = _device(device_name, cuda_device_index)
    checkpoint, model = _load_embedding(checkpoint_path, device)
    if metadata["checkpoint_model_version"] != checkpoint["model_version"]:
        raise ValueError("Index checkpoint model version does not match the selected checkpoint")
    if int(metadata["embedding_dimension"]) != int(checkpoint["config"]["embedding_dim"]):
        raise ValueError("Index embedding dimension does not match the selected checkpoint")
    calibration_records = [item for item in records if item.role == "calibration"]
    test_records = [item for item in records if item.role == "test"]
    diagnostic_records = [item for item in records if item.role == "diagnostic"]
    calibration_predictions = _predict(model, calibration_records, root, vectors, labels, device, batch_size)
    thresholds = _thresholds(
        np.asarray([item["score"] for item in calibration_predictions]),
        np.asarray([item["margin"] for item in calibration_predictions]),
        np.asarray([item["actual_oracle_id"] == item["predicted_oracle_id"] for item in calibration_predictions]),
    )
    test_predictions = _predict(model, test_records, root, vectors, labels, device, batch_size)
    diagnostic_predictions = _predict(model, diagnostic_records, root, vectors, labels, device, batch_size)
    overall = _metrics(test_predictions, thresholds)
    groups: dict[str, Any] = {}
    oracle_counts = Counter(
        oracle_id for item in labels for oracle_id in item.get("oracle_ids", [item["oracle_id"]])
    )
    group_members = {
        "singleton_artwork": [item for item in test_predictions if oracle_counts[item["actual_oracle_id"]] == 1],
        "alternate_artwork": [item for item in test_predictions if oracle_counts[item["actual_oracle_id"]] > 1],
        "basic_land": [item for item in test_predictions if item["category"] == "basic_land"],
        "token": [item for item in test_predictions if item["category"] == "token"],
    }
    for name, values in group_members.items():
        groups[name] = _metrics(values, thresholds) if values else None
    subgroup_qualified = all(
        value is None or value["top1"] >= 0.99 for value in groups.values()
    )
    qualified = (
        overall["top1"] >= STRICT_TOP1
        and overall["top5"] >= STRICT_TOP5
        and overall["accepted_precision"] >= STRICT_PRECISION
        and overall["coverage"] >= STRICT_COVERAGE
        and subgroup_qualified
    )
    failures = [
        item for item in test_predictions
        if item["actual_oracle_id"] != item["predicted_oracle_id"]
        or item["score"] < thresholds["score_threshold"]
        or item["margin"] < thresholds["margin_threshold"]
    ]
    failure_path = output_path.with_name("retrieval-failures.jsonl")
    _write_jsonl(failure_path, failures[:1000])
    report = {
        "retrieval_report_schema_version": 1,
        "artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION,
        "dataset_version": records[0].dataset_version,
        "checkpoint_model_version": checkpoint["model_version"],
        "index_schema_version": INDEX_SCHEMA_VERSION,
        "qualified": qualified,
        "targets": {
            "top1": STRICT_TOP1,
            "top5": STRICT_TOP5,
            "accepted_precision": STRICT_PRECISION,
            "coverage": STRICT_COVERAGE,
            "subgroup_top1": 0.99,
        },
        "thresholds": thresholds,
        "test": overall,
        "groups": groups,
        "severe_diagnostic": _metrics(diagnostic_predictions, thresholds),
        "failure_report": failure_path.name,
        "calibration_samples": len(calibration_predictions),
        "test_samples": len(test_predictions),
        "ambiguous_artworks": sum(bool(item.get("ambiguous", False)) for item in labels),
        "ambiguous_policy": "indexed_for_detection_but_rejected_without_a_unique_oracle",
    }
    _write_json(output_path, report)
    _write_json(output_path.with_name("artwork-thresholds.json"), {
        "artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION,
        "dataset_version": records[0].dataset_version,
        "checkpoint_model_version": checkpoint["model_version"],
        **thresholds,
    })
    emit("prototype_evaluation_completed", report_path=str(output_path), **report)
    return report


@torch.inference_mode()
def recognize_index(
    checkpoint_path: Path,
    index_root: Path,
    image_path: Path,
    thresholds_path: Path,
    device_name: str,
    cuda_device_index: int | None,
) -> dict[str, Any]:
    metadata, labels, vectors = _load_index(index_root)
    thresholds = json.loads(thresholds_path.read_text(encoding="utf-8"))
    device = _device(device_name, cuda_device_index)
    checkpoint, model = _load_embedding(checkpoint_path, device)
    if metadata["checkpoint_model_version"] != checkpoint["model_version"]:
        raise ValueError("Index checkpoint model version does not match the selected checkpoint")
    if thresholds.get("artifact_schema_version") != ARTWORK_ARTIFACT_SCHEMA_VERSION:
        raise ValueError("Artwork thresholds require artifact schema v4")
    if thresholds.get("dataset_version") != metadata["dataset_version"]:
        raise ValueError("Artwork thresholds dataset version does not match the index")
    if thresholds.get("checkpoint_model_version") != checkpoint["model_version"]:
        raise ValueError("Artwork thresholds checkpoint does not match the selected checkpoint")
    with Image.open(image_path) as image:
        query = model(_view(image, "clean", 0).unsqueeze(0).to(device))
    scores = query @ torch.from_numpy(vectors).to(device).T
    oracle_best: dict[str, tuple[float, dict[str, Any]]] = {}
    for index, score in enumerate(scores[0].tolist()):
        label = labels[index]
        for oracle_id in label.get("oracle_ids", [label["oracle_id"]]):
            previous = oracle_best.get(oracle_id)
            if previous is None or score > previous[0]:
                oracle_best[oracle_id] = (score, label)
    candidates = sorted(
        ((score, oracle_id, label) for oracle_id, (score, label) in oracle_best.items()),
        key=lambda item: item[0],
        reverse=True,
    )[:5]
    best_score, best_oracle_id, best_label = candidates[0]
    margin = best_score - candidates[1][0]
    ambiguous_artwork = bool(best_label.get("ambiguous", False))
    best_card_name = best_label.get("oracle_names", {}).get(best_oracle_id, best_label["card_name"])
    rejected = (
        ambiguous_artwork
        or best_score < thresholds["score_threshold"]
        or margin < thresholds["margin_threshold"]
    )
    result = {
        "dataset_version": metadata["dataset_version"],
        "model_version": checkpoint["model_version"],
        "rejected": rejected,
        "oracle_id": None if rejected else best_oracle_id,
        "card_name": None if rejected else best_card_name,
        "candidate_oracle_id": best_oracle_id,
        "candidate_card_name": best_card_name,
        "candidate_artwork_id": best_label["artwork_id"],
        "cosine_score": best_score,
        "margin": margin,
        "score_threshold": thresholds["score_threshold"],
        "margin_threshold": thresholds["margin_threshold"],
        "ambiguous_artwork": ambiguous_artwork,
        "candidate_oracle_ids": best_label.get("oracle_ids", [best_label["oracle_id"]]),
        "rejection_reason": (
            "ambiguous_artwork" if ambiguous_artwork
            else "below_confidence_threshold" if rejected
            else None
        ),
        "candidates": [
            {
                "oracle_id": item[1],
                "card_name": item[2].get("oracle_names", {}).get(item[1], item[2]["card_name"]),
                "score": item[0],
            }
            for item in candidates
        ],
    }
    emit("prototype_recognition", **result)
    return result

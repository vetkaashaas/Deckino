"""Rank corner annotations for review against the edge-intersection convention.

Labels saved before the convention was written down may sit on the rounded
corner arc, on a sleeve edge, or on the printed frame. This audit runs the
extractor plus corner refiner over every annotated positive photograph and
ranks labels by how far they disagree with the refined corners. It never edits
a sidecar: a person reviews the listed photos in the Corner Annotator (where
"Snap to card edges" applies the same refiner) and saves the corrections.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw

from .events import emit
from .extraction import (CORNER_ORDER, LEGACY_COORDINATE_TRANSFORM, NORMALIZE_MEAN, NORMALIZE_STD,
                         ExtractionDataset, _device, _load_model, _quad_valid, _write_json, read_manifest,
                         unletterbox)
from .extraction_network import corner_anchor_policy_for_config, decode_geometry, offset_range_for_config
from .extraction_refiner import load_refiner, refine_corners

# Disagreement above this fraction of the card diagonal is listed for review.
REVIEW_THRESHOLD = .012
PREVIEW_LIMIT = 60


def _sidecar_convention(image_path: Path) -> str | None:
    sidecar = image_path.with_name(f"{image_path.stem}._annotations.json")
    try:
        return json.loads(sidecar.read_text(encoding="utf-8")).get("CornerConvention")
    except (OSError, json.JSONDecodeError):
        return None


def _preview(image: Image.Image, label: list[dict[str, float]], refined: list[dict[str, float]],
             destination: Path) -> None:
    """Side-by-side zoomed crops of each corner: red label, cyan refined."""
    width, height = image.width - 1, image.height - 1
    label_px = np.array([[p["x"] * width, p["y"] * height] for p in label])
    refined_px = np.array([[p["x"] * width, p["y"] * height] for p in refined])
    diagonal = float(np.linalg.norm(label_px[0] - label_px[2]))
    half = max(12, int(diagonal * .05))
    tiles = []
    for index in range(4):
        cx, cy = label_px[index].round().astype(int)
        tile = image.crop((cx - half, cy - half, cx + half, cy + half)).resize((200, 200), Image.Resampling.BICUBIC)
        draw, scale = ImageDraw.Draw(tile), 200 / (2 * half)
        for points, colour in ((label_px, (255, 90, 90)), (refined_px, (0, 220, 255))):
            x, y = (points[index] - (cx - half, cy - half)) * scale
            draw.ellipse((x - 5, y - 5, x + 5, y + 5), outline=colour, width=2)
        draw.text((4, 4), CORNER_ORDER[index], fill="white", stroke_width=1, stroke_fill="black")
        tiles.append(tile)
    sheet = Image.new("RGB", (800, 200))
    for index, tile in enumerate(tiles):
        sheet.paste(tile, (index * 200, 0))
    sheet.save(destination, quality=90)


def audit_labels(manifest: Path, checkpoint_path: Path, refiner_path: Path, output: Path,
                 device_name: str, cuda_index: int | None, threshold: float = REVIEW_THRESHOLD) -> dict[str, Any]:
    records, root, _ = read_manifest(manifest)
    positives = [record for record in records if record.source_kind == "real" and record.card_present]
    device = _device(device_name, cuda_index)
    config, model = _load_model(checkpoint_path, device)
    refiner_config, refiner = load_refiner(refiner_path, device)
    trained = set(config.get("training_image_hashes") or []) | set(refiner_config.get("training_image_hashes") or [])
    coordinate_transform = config.get("coordinate_transform", LEGACY_COORDINATE_TRANSFORM)
    dataset = ExtractionDataset(root, positives, input_size=config["input_size"],
                                mean=config.get("normalization_mean", NORMALIZE_MEAN),
                                std=config.get("normalization_std", NORMALIZE_STD),
                                coordinate_transform=coordinate_transform)
    previews = output / "previews"
    previews.mkdir(parents=True, exist_ok=True)
    rows = []
    model.eval()
    with torch.inference_mode():
        for index, record in enumerate(positives):
            tensor, _, _, _ = dataset[index]
            outputs = model.forward_geometry(tensor[None].to(device))
            predicted, _ = decode_geometry(outputs, corner_anchor_policy_for_config(config),
                                           offset_range_for_config(config))
            coarse = unletterbox(predicted[0].tolist(), record.image_width, record.image_height,
                                 config["input_size"], coordinate_transform)
            image_path = root / record.image_path
            row: dict[str, Any] = {"sample_id": record.sample_id, "image_path": record.image_path,
                                   "split": record.split, "source_group": record.source_group,
                                   "seen_in_training": record.image_sha256 in trained,
                                   "corner_convention": _sidecar_convention(image_path)}
            if not _quad_valid(coarse):
                rows.append({**row, "status": "model_geometry_invalid", "max_disagreement": None})
                continue
            with Image.open(image_path) as source:
                image = source.convert("RGB")
            refined = refine_corners(refiner, image, coarse, device)
            width, height = record.image_width - 1, record.image_height - 1
            label = [(p["x"] * width, p["y"] * height) for p in record.corners]
            served = [(p["x"] * width, p["y"] * height) for p in refined["corners"]]
            diagonal = max(1., math.dist(label[0], label[2]))
            disagreement = [math.dist(a, b) / diagonal for a, b in zip(served, label)]
            center = np.mean(label, axis=0)
            # Positive radial: the model places the corner outside the label (label on the arc or frame).
            radial = [float(np.dot(np.subtract(a, b), np.subtract(b, center)) / (np.linalg.norm(np.subtract(b, center)) * diagonal))
                      for a, b in zip(served, label)]
            row.update(status="compared", refined=refined["refined"], corner_disagreement=disagreement,
                       corner_radial_offset=radial, max_disagreement=max(disagreement),
                       refined_corners=refined["corners"], label_corners=record.corners)
            rows.append(row)
            if (index + 1) % 25 == 0 or index + 1 == len(positives):
                emit("extraction_label_audit_progress", completed=index + 1, total=len(positives))
    compared = [row for row in rows if row["max_disagreement"] is not None]
    compared.sort(key=lambda row: -row["max_disagreement"])
    flagged = [row for row in compared if row["max_disagreement"] >= threshold]
    for rank, row in enumerate(flagged[:PREVIEW_LIMIT]):
        name = f"{rank:03d}-{row['sample_id'][:12]}.jpg"
        with Image.open(root / row["image_path"]) as source:
            _preview(source.convert("RGB"), row["label_corners"], row["refined_corners"], previews / name)
        row["preview"] = f"previews/{name}"
    radial = [value for row in compared for value in row["corner_radial_offset"]]
    report = {"audit_schema_version": 1, "convention": "edge-intersection-v1",
              "model_version": config.get("model_version"), "review_threshold": threshold,
              "positives": len(positives), "compared": len(compared), "flagged": len(flagged),
              "unrecorded_convention": sum(row["corner_convention"] is None for row in rows),
              "median_disagreement": float(np.median([row["max_disagreement"] for row in compared])) if compared else None,
              # A consistent positive median means labels systematically sit inside the edge intersection.
              "median_radial_offset": float(np.median(radial)) if radial else None,
              "note": "Disagreement on photos seen in training understates label error; the model partly memorized those labels.",
              "review_queue": [{key: row.get(key) for key in (
                  "image_path", "split", "seen_in_training", "corner_convention", "max_disagreement",
                  "corner_disagreement", "corner_radial_offset", "preview")} for row in flagged],
              "invalid": [row for row in rows if row["max_disagreement"] is None]}
    _write_json(output / "label-audit.json", report)
    emit("extraction_label_audit_completed", **{key: report[key] for key in (
        "positives", "compared", "flagged", "unrecorded_convention", "median_disagreement", "median_radial_offset")})
    return report

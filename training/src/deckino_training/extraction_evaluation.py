"""Shared real-camera metrics for selection, calibration, and locked testing."""
from __future__ import annotations

import math
import json
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import torch
from PIL import Image, ImageDraw
from torch.utils.data import DataLoader

from .events import emit
from .extraction import (CORNER_ORDER, NORMALIZE_MEAN, NORMALIZE_STD, RECTIFIED_WIDTH, RECTIFIED_HEIGHT,
                         ExtractionDataset, ExtractionRecord, _atomic_torch_save, _device,
                         _homography_coefficients, _load_model, _project_points, _quad_valid, _sha256,
                         _write_json, _write_jsonl, read_manifest, unletterbox)


def predict(model, records: Sequence[ExtractionRecord], root: Path, device: torch.device,
            batch_size: int, workers: int, config: dict[str, Any], phase: str = "", loader=None) -> list[dict[str, Any]]:
    model.eval()
    lookup = {record.sample_id: record for record in records}
    loader = loader if loader is not None else DataLoader(ExtractionDataset(root, records, input_size=config["input_size"],
                                         mean=config.get("normalization_mean", NORMALIZE_MEAN),
                                         std=config.get("normalization_std", NORMALIZE_STD)),
                        batch_size=batch_size, num_workers=workers)
    predictions = []
    canonical = [(0., 0.), (RECTIFIED_WIDTH - 1., 0.),
                 (RECTIFIED_WIDTH - 1., RECTIFIED_HEIGHT - 1.), (0., RECTIFIED_HEIGHT - 1.)]
    with torch.inference_mode():
        for batch, (images, _, _, ids) in enumerate(loader, 1):
            predicted, logits = model(images.to(device))
            if not torch.isfinite(predicted).all() or not torch.isfinite(logits).all():
                raise RuntimeError("Extractor inference returned non-finite predictions")
            for values, probability, sample_id in zip(predicted.cpu().tolist(), logits.sigmoid().cpu().tolist(), ids):
                record = lookup[sample_id]
                corners = unletterbox(values, record.image_width, record.image_height, config["input_size"])
                pixels = [(point["x"] * (record.image_width - 1), point["y"] * (record.image_height - 1)) for point in corners]
                errors, warp_error = [], None
                if record.card_present:
                    actual = [(point["x"] * (record.image_width - 1), point["y"] * (record.image_height - 1)) for point in record.corners]
                    diagonal = max(1, math.dist(actual[0], actual[2]))
                    errors = [math.dist(point, target) / diagonal for point, target in zip(pixels, actual)]
                    try:
                        landed = _project_points(_homography_coefficients(pixels, canonical), actual)
                        warp_error = max(math.dist(point, target) for point, target in zip(landed, canonical)) / math.dist(canonical[0], canonical[2])
                        if not math.isfinite(warp_error):
                            warp_error = None
                    except (ValueError, np.linalg.LinAlgError):
                        pass
                predictions.append({"sample_id": sample_id, "image_sha256": record.image_sha256,
                                    "actual_present": record.card_present, "presence_probability": probability,
                                    "corners": corners, "quad_valid": _quad_valid(corners),
                                    "corner_errors": errors, "warp_error": warp_error,
                                    "source_kind": record.source_kind, "source_group": record.source_group,
                                    "capture_condition": record.capture_condition or "unlabeled",
                                    "condition_tags": record.condition_tags})
            if phase and (batch == 1 or batch == len(loader) or batch % 10 == 0):
                emit("extraction_evaluation_progress", phase=phase, batch=batch, total_batches=len(loader),
                     completed_samples=len(predictions), total_samples=len(records))
    return predictions


def summarize(predictions: Sequence[dict[str, Any]], threshold: float = 0.5) -> dict[str, Any]:
    positive = [item for item in predictions if item["actual_present"]]
    negative = [item for item in predictions if not item["actual_present"]]
    present = [item for item in predictions if item["presence_probability"] >= threshold]
    true = [item for item in present if item["actual_present"]]
    accepted = [item for item in present if item["quad_valid"]]
    accepted_positive = [item for item in accepted if item["actual_present"]]
    successful = [item for item in accepted_positive if item["warp_error"] is not None and item["warp_error"] <= 0.03]
    errors = [error for item in positive for error in item["corner_errors"]]
    ratio = lambda numerator, denominator: numerator / denominator if denominator else None
    return {"samples": len(predictions), "positives": len(positive), "negatives": len(negative),
            "presence_precision": ratio(len(true), len(present)), "presence_recall": ratio(len(true), len(positive)),
            "negative_false_positive_rate": ratio(len(present) - len(true), len(negative)),
            "mean_corner_error": float(np.mean(errors)) if errors else None,
            "p95_corner_error": float(np.percentile(errors, 95)) if errors else None,
            "all_four_within_4_percent": ratio(sum(max(item["corner_errors"]) <= 0.04 for item in positive), len(positive)),
            "valid_predicted_quadrilateral_rate": ratio(len(accepted), len(present)),
            "accepted_warp_success": ratio(len(successful), len(accepted_positive)),
            "accepted_warp_coverage": ratio(len(accepted_positive), len(positive)),
            "correct_warp_coverage": ratio(len(successful), len(positive)),
            "accepted": len(accepted), "accepted_positive": len(accepted_positive)}


def selection_key(metrics: dict[str, Any]) -> tuple[bool, float, float]:
    floor = metrics["negatives"] > 0 and (metrics["presence_precision"] or 0) >= 0.95 and (metrics["presence_recall"] or 0) >= 0.95
    error = metrics["mean_corner_error"]
    return floor, metrics["correct_warp_coverage"] or 0., -error if error is not None else -1e9


def calibrate(predictions: Sequence[dict[str, Any]]) -> tuple[float, bool]:
    if not any(item["actual_present"] for item in predictions) or not any(not item["actual_present"] for item in predictions):
        return 0.5, False
    best, selected = (-1., -1.), 0.5
    for threshold in sorted({0.5, *(item["presence_probability"] for item in predictions)}):
        metrics = summarize(predictions, threshold)
        precision, recall = metrics["presence_precision"] or 0, metrics["presence_recall"] or 0
        key = (recall if precision >= 0.99 else -1., precision)
        if key > best:
            best, selected = key, threshold
    return selected, best[0] >= 0


def write_failures(output: Path, predictions: Sequence[dict[str, Any]], records: Sequence[ExtractionRecord],
                   root: Path, threshold: float) -> None:
    lookup = {record.sample_id: record for record in records}
    failures = sorted(predictions, key=lambda item: (
        item["actual_present"] == (item["presence_probability"] >= threshold),
        -max(item["corner_errors"], default=0)))[:100]
    _write_jsonl(output / "failures.jsonl", failures)
    gallery = output / "diagnostics" / "failures"
    gallery.mkdir(parents=True, exist_ok=True)
    previews = []
    for index, item in enumerate(failures[:20]):
        record = lookup[item["sample_id"]]
        with Image.open(root / record.image_path) as source:
            image = source.convert("RGB")
        image.thumbnail((640, 640), Image.Resampling.BICUBIC)
        draw = ImageDraw.Draw(image)
        for points, color in ((item["corners"], (0, 220, 255)), (record.corners, (255, 90, 90))):
            if points:
                pixels = [(point["x"] * (image.width - 1), point["y"] * (image.height - 1)) for point in points]
                draw.line([*pixels, pixels[0]], fill=color, width=3)
        name = f"failure-{index:03d}-{record.sample_id[:12]}.jpg"
        image.save(gallery / name, quality=90)
        previews.append({"sample_id": record.sample_id, "preview": name})
    _write_json(gallery / "index.json", {"failures": previews})


def evaluate(manifest: Path, checkpoint_path: Path, output: Path, device_name: str,
             batch_size: int, workers: int, cuda_index: int | None,
             baseline_checkpoint: Path | None = None) -> dict[str, Any]:
    records, root, _ = read_manifest(manifest)
    device = _device(device_name, cuda_index)
    checkpoint, model = _load_model(checkpoint_path, device)
    if checkpoint["dataset_version"] != records[0].dataset_version or (
            checkpoint.get("manifest_sha256") and checkpoint["manifest_sha256"] != _sha256(manifest)):
        raise ValueError("Evaluation manifest does not match the checkpoint training snapshot")
    validation = [item for item in records if item.source_kind == "real" and item.split == "validation"]
    test = [item for item in records if item.source_kind == "real" and item.split == "test"]
    # A completed locked evaluation is immutable for this exact checkpoint and manifest.
    identity = {"checkpoint_sha256": _sha256(checkpoint_path), "manifest_sha256": _sha256(manifest)}
    previous_path = output / "evaluation.json"
    if previous_path.exists():
        previous = json.loads(previous_path.read_text(encoding="utf-8"))
        if previous.get("evaluation_identity") != identity:
            raise ValueError("Evaluation output already belongs to a different checkpoint or manifest")
        for name in ("thresholds.json", "grouped-metrics.json", "extractor.pt", "failures.jsonl"):
            artifact = output / name
            expected = previous.get("artifact_checksums", {}).get(name)
            if not artifact.is_file() or (expected and _sha256(artifact) != expected):
                raise ValueError(f"Completed evaluation artifact is missing or changed: {name}; restore the original run artifacts")
        return previous
    calibration = predict(model, validation, root, device, batch_size, workers, checkpoint, "Real validation calibration")
    threshold, calibrated = calibrate(calibration)
    predictions = predict(model, test, root, device, batch_size, workers, checkpoint, "Locked real test")
    metrics = summarize(predictions, threshold)
    conditions = {}
    for condition in sorted({item["capture_condition"] for item in predictions}):
        subset = [item for item in predictions if item["capture_condition"] == condition]
        conditions[condition] = {**summarize(subset, threshold), "source_groups": len({item["source_group"] for item in subset})}
    def at_least(key: str, limit: float) -> bool:
        return metrics[key] is not None and metrics[key] >= limit
    def at_most(key: str, limit: float) -> bool:
        return metrics[key] is not None and metrics[key] <= limit
    metric_gate = (at_least("presence_precision", .99) and at_least("presence_recall", .98)
                   and at_most("negative_false_positive_rate", .01) and at_most("mean_corner_error", .015)
                   and at_most("p95_corner_error", .04) and at_least("all_four_within_4_percent", .95)
                   and at_least("valid_predicted_quadrilateral_rate", .99) and at_least("accepted_warp_success", .97))
    coverage_gate = metrics["positives"] >= 200 and metrics["negatives"] >= 200 and len({item.source_group for item in test}) >= 5
    condition_gate = bool(conditions) and "unlabeled" not in conditions and all(item["source_groups"] >= 3
        and (not item["positives"] or ((item["presence_recall"] or 0) >= .95 and (item["accepted_warp_success"] or 0) >= .9))
        for item in conditions.values())
    qualified = calibrated and metric_gate and coverage_gate and condition_gate
    report = {"evaluation_schema_version": 2, "artifact_schema_version": checkpoint["artifact_schema_version"],
              "dataset_version": checkpoint["dataset_version"], "model_version": checkpoint["model_version"],
              "evaluation_identity": identity, "split": "test" if test else "unavailable",
              "development_only": not calibrated or not test, "validation_samples": len(validation),
              "test_samples": len(test), "metrics": metrics, "validation_metrics": summarize(calibration, threshold),
              "validation_at_0_5": summarize(calibration), "grouped_conditions": conditions,
              "gates": {"metrics": metric_gate, "real_camera_coverage": coverage_gate, "conditions": condition_gate},
              "qualified": qualified, "calibrated": calibrated,
              "coverage_warnings": (["Unlabeled real-camera conditions cannot qualify."] if "unlabeled" in conditions else [])
                  + (["Insufficient independent locked-test photographs/groups."] if not coverage_gate else [])
                  + (["Real validation lacks both presence classes; threshold is uncalibrated."] if not calibrated else [])}
    validation_metrics = report["validation_metrics"]
    report["development_targets_met"] = all(validation_metrics[key] is not None and predicate(validation_metrics[key])
        for key, predicate in (("mean_corner_error", lambda value: value <= .03),
                               ("p95_corner_error", lambda value: value <= .08),
                               ("all_four_within_4_percent", lambda value: value >= .8),
                               ("correct_warp_coverage", lambda value: value >= .9)))
    synthetic = [item for item in records if item.source_kind != "real" and item.split == "test"]
    synthetic_predictions = predict(model, synthetic, root, device, batch_size, workers, checkpoint, "Separate synthetic test")
    report["synthetic_metrics"] = summarize(synthetic_predictions, threshold)
    report["baseline_comparison"] = {"status": "not_available"}
    if baseline_checkpoint is not None and baseline_checkpoint.is_file() and validation:
        old_config, old_model = _load_model(baseline_checkpoint, device)
        old_predictions = predict(old_model, validation, root, device, batch_size, workers, old_config, "Baseline on real validation")
        hashes = old_config.get("training_image_hashes")
        report["baseline_comparison"] = {"status": "compared", "model_version": old_config["model_version"],
            "split": "validation", "metrics_at_0_5": summarize(old_predictions),
            "training_overlap": "unknown" if hashes is None else sum(item.image_sha256 in hashes for item in validation),
            "samples": [{"sample_id": item.sample_id, "previously_seen": None if hashes is None else item.image_sha256 in hashes}
                        for item in validation],
            "warning": "Legacy training membership may be unknown; this is not an unbiased held-out comparison." if hashes is None else None}
    thresholds = {"threshold_schema_version": 2, "artifact_schema_version": checkpoint["artifact_schema_version"],
                  "dataset_version": checkpoint["dataset_version"], "model_version": checkpoint["model_version"],
                  "presence_threshold": threshold, "calibrated": calibrated, "minimum_area": .0025,
                  "corner_order": list(CORNER_ORDER)}
    _write_json(output / "thresholds.json", thresholds)
    _write_json(output / "grouped-metrics.json", {"capture_conditions": conditions,
        "condition_tags": {tag: summarize([item for item in predictions if tag in item["condition_tags"]], threshold)
                           for tag in sorted({tag for item in predictions for tag in item["condition_tags"]})},
        "source_kinds": {kind: summarize([item for item in [*predictions, *synthetic_predictions] if item["source_kind"] == kind], threshold)
                         for kind in sorted({item["source_kind"] for item in [*predictions, *synthetic_predictions]})}})
    write_failures(output, predictions, test, root, threshold)
    compact = {key: checkpoint[key] for key in ("artifact_schema_version", "dataset_version", "model_version", "architecture", "input_size", "corner_order")}
    compact.update(normalization_mean=checkpoint.get("normalization_mean", NORMALIZE_MEAN),
                   normalization_std=checkpoint.get("normalization_std", NORMALIZE_STD), model_state=model.state_dict())
    _atomic_torch_save(compact, output / "extractor.pt")
    report["artifact_checksums"] = {name: _sha256(output / name)
        for name in ("thresholds.json", "grouped-metrics.json", "extractor.pt", "failures.jsonl")}
    _write_json(output / "evaluation.json", report)
    emit("extraction_evaluated", qualified=qualified, split=report["split"], **metrics)
    return report

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
from .extraction_network import decode_geometry, readable_orientation_class

CHECKPOINT_SELECTION_POLICY = "geometry-guarded-v3"


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
            device_images = images.to(device)
            if hasattr(model, "forward_geometry"):
                outputs = model.forward_geometry(device_images)
                predicted, geometry = decode_geometry(outputs)
                logits = outputs["presence_logits"]
            else:
                predicted, logits = model(device_images)
                geometry = [{"geometry_valid": True, "candidate_score": None, "ambiguity_margin": 1e9,
                             "geometry_ambiguity_margin": 1e9, "semantic_ambiguity_margin": 1e9,
                             "mask_iou": None, "detected_peaks": None, "candidate_count": None,
                             "corner_scores": None, "peak_points": None, "orientation_class": None,
                             "orientation_probability": None, "global_orientation_class": None,
                             "global_orientation_probability": None, "semantic_corner_scores": None}
                            for _ in range(len(ids))]
            if not torch.isfinite(predicted).all() or not torch.isfinite(logits).all():
                raise RuntimeError("Extractor inference returned non-finite predictions")
            for values, probability, details, sample_id in zip(predicted.cpu().tolist(), logits.sigmoid().cpu().tolist(), geometry, ids):
                record = lookup[sample_id]
                corners = unletterbox(values, record.image_width, record.image_height, config["input_size"])
                pixels = [(point["x"] * (record.image_width - 1), point["y"] * (record.image_height - 1)) for point in corners]
                errors, warp_error = [], None
                peak_recall = orientation_correct = None
                if record.card_present:
                    actual = [(point["x"] * (record.image_width - 1), point["y"] * (record.image_height - 1)) for point in record.corners]
                    diagonal = max(1, math.dist(actual[0], actual[2]))
                    errors = [math.dist(point, target) / diagonal for point, target in zip(pixels, actual)]
                    if details.get("peak_points"):
                        peak_values = [value for point in details["peak_points"] for value in point]
                        peak_corners = unletterbox(peak_values, record.image_width, record.image_height,
                                                   config["input_size"])
                        peak_pixels = [(point["x"] * (record.image_width - 1), point["y"] * (record.image_height - 1))
                                       for point in peak_corners]
                        peak_recall = sum(min(math.dist(point, peak) for peak in peak_pixels) / diagonal <= .04
                                          for point in actual) / 4
                    if details.get("orientation_class") is not None:
                        orientation_correct = details["orientation_class"] == readable_orientation_class(
                            np.asarray([[point["x"], point["y"]] for point in record.corners]))
                    try:
                        landed = _project_points(_homography_coefficients(pixels, canonical), actual)
                        warp_error = max(math.dist(point, target) for point, target in zip(landed, canonical)) / math.dist(canonical[0], canonical[2])
                        if not math.isfinite(warp_error):
                            warp_error = None
                    except (ValueError, np.linalg.LinAlgError):
                        pass
                predictions.append({"sample_id": sample_id, "image_sha256": record.image_sha256,
                                    "actual_present": record.card_present, "presence_probability": probability,
                                    "corners": corners, "quad_valid": bool(details["geometry_valid"] and _quad_valid(corners)),
                                    "candidate_score": details["candidate_score"],
                                    "ambiguity_margin": details["ambiguity_margin"], "mask_iou": details["mask_iou"],
                                    "geometry_ambiguity_margin": details.get("geometry_ambiguity_margin"),
                                    "semantic_ambiguity_margin": details.get("semantic_ambiguity_margin"),
                                    "detected_peaks": details["detected_peaks"], "candidate_count": details["candidate_count"],
                                    "corner_scores": details["corner_scores"], "orientation_class": details["orientation_class"],
                                    "orientation_probability": details["orientation_probability"],
                                    "global_orientation_class": details.get("global_orientation_class"),
                                    "global_orientation_probability": details.get("global_orientation_probability"),
                                    "semantic_corner_scores": details.get("semantic_corner_scores"),
                                    "corner_peak_recall_at_8": peak_recall,
                                    "orientation_correct": orientation_correct,
                                    "corner_errors": errors, "warp_error": warp_error,
                                    "source_kind": record.source_kind, "source_group": record.source_group,
                                    "capture_condition": record.capture_condition or "unlabeled",
                                    "condition_tags": record.condition_tags})
            if phase and (batch == 1 or batch == len(loader) or batch % 10 == 0):
                emit("extraction_evaluation_progress", phase=phase, batch=batch, total_batches=len(loader),
                     completed_samples=len(predictions), total_samples=len(records))
    return predictions


def _accepted(item: dict[str, Any], presence_threshold: float, ambiguity_threshold: float) -> bool:
    return (item["presence_probability"] >= presence_threshold and item["quad_valid"]
            and float(item.get("ambiguity_margin", math.inf)) >= ambiguity_threshold)


def summarize(predictions: Sequence[dict[str, Any]], threshold: float = 0.5,
              ambiguity_threshold: float = 0.) -> dict[str, Any]:
    positive = [item for item in predictions if item["actual_present"]]
    negative = [item for item in predictions if not item["actual_present"]]
    present = [item for item in predictions if item["presence_probability"] >= threshold]
    true = [item for item in present if item["actual_present"]]
    accepted = [item for item in predictions if _accepted(item, threshold, ambiguity_threshold)]
    accepted_positive = [item for item in accepted if item["actual_present"]]
    successful = [item for item in accepted_positive if item["warp_error"] is not None and item["warp_error"] <= 0.03]
    errors = [error for item in positive for error in item["corner_errors"]]
    ratio = lambda numerator, denominator: numerator / denominator if denominator else None
    return {"samples": len(predictions), "positives": len(positive), "negatives": len(negative),
            "presence_precision": ratio(len(true), len(present)), "presence_recall": ratio(len(true), len(positive)),
            "negative_false_positive_rate": ratio(len(present) - len(true), len(negative)),
            "accepted_extraction_precision": ratio(len(accepted_positive), len(accepted)),
            "negative_acceptance_rate": ratio(len(accepted) - len(accepted_positive), len(negative)),
            "mean_corner_error": float(np.mean(errors)) if errors else None,
            "p95_corner_error": float(np.percentile(errors, 95)) if errors else None,
            "all_four_within_4_percent": ratio(sum(max(item["corner_errors"]) <= 0.04 for item in positive), len(positive)),
            "valid_predicted_quadrilateral_rate": ratio(sum(item["quad_valid"] for item in present), len(present)),
            "accepted_warp_success": ratio(len(successful), len(accepted_positive)),
            "accepted_warp_coverage": ratio(len(accepted_positive), len(positive)),
            "correct_warp_coverage": ratio(len(successful), len(positive)),
            "corner_measurement_coverage": ratio(sum(bool(item["corner_errors"]) and item["quad_valid"] for item in positive),
                                                 len(positive)),
            "mean_mask_iou": float(np.mean([item["mask_iou"] for item in predictions if item.get("mask_iou") is not None]))
                if any(item.get("mask_iou") is not None for item in predictions) else None,
            "mean_ambiguity_margin": float(np.mean([item["ambiguity_margin"] for item in predictions
                if item.get("ambiguity_margin") is not None and math.isfinite(item["ambiguity_margin"])]))
                if any(item.get("ambiguity_margin") is not None and math.isfinite(item["ambiguity_margin"]) for item in predictions) else None,
            "corner_peak_recall_at_8": float(np.mean([item["corner_peak_recall_at_8"] for item in positive
                if item.get("corner_peak_recall_at_8") is not None]))
                if any(item.get("corner_peak_recall_at_8") is not None for item in positive) else None,
            "orientation_accuracy": float(np.mean([item["orientation_correct"] for item in positive
                if item.get("orientation_correct") is not None]))
                if any(item.get("orientation_correct") is not None for item in positive) else None,
            "accepted": len(accepted), "accepted_positive": len(accepted_positive),
            "presence_threshold": threshold, "ambiguity_margin_threshold": ambiguity_threshold}


def selection_key(predictions: Sequence[dict[str, Any]]) -> tuple[bool, float, float, float, float]:
    """Choose geometry before calibrating serving thresholds on scarce negatives."""
    diagnostic = summarize(predictions, .5, 0.)
    forced = summarize(predictions, 0., 0.)
    has_positive = diagnostic["positives"] > 0
    has_negative = diagnostic["negatives"] > 0
    guard = (has_positive and (diagnostic["presence_recall"] or 0.) >= .9
             and (not has_negative or diagnostic["negative_acceptance_rate"] == 0.))
    return (guard, forced["correct_warp_coverage"] or 0., forced["all_four_within_4_percent"] or 0.,
            -forced["p95_corner_error"] if forced["p95_corner_error"] is not None else -1e9,
            -forced["mean_corner_error"] if forced["mean_corner_error"] is not None else -1e9)


def _legacy_calibrate(predictions: Sequence[dict[str, Any]]) -> tuple[float, bool]:
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


def calibration_report(predictions: Sequence[dict[str, Any]]) -> dict[str, Any]:
    positives = sum(item["actual_present"] for item in predictions)
    negatives = len(predictions) - positives
    report = {"policy": "accepted-precision, negative-acceptance, correct-warp-coverage",
              "validation_positives": positives, "validation_negatives": negatives,
              "minimum_accepted_precision": .99, "maximum_negative_acceptance": .01,
              "provisional": negatives < 200, "candidates": [], "constraints_met": False,
              "presence_threshold": .5, "ambiguity_margin_threshold": 0.,
              "calibrated": False, "status": "missing_presence_class"}
    if not positives or not negatives:
        report["selected_metrics"] = summarize(predictions, .5, 0.)
        return report
    scores = sorted({float(item["presence_probability"]) for item in predictions})
    if any(not math.isfinite(score) or score < 0 or score > 1 for score in scores):
        raise ValueError("Calibration requires finite presence probabilities in [0, 1]")
    thresholds = sorted({.5, 0., 1., *scores, *((a + b) / 2 for a, b in zip(scores, scores[1:]))})
    margins = sorted({0., *(max(0., float(item.get("ambiguity_margin", 1e9))) for item in predictions)})
    margin_thresholds = sorted({0., *margins, *((a + b) / 2 for a, b in zip(margins, margins[1:]))})
    best = None
    for threshold in thresholds:
        for margin in margin_thresholds:
            metrics = summarize(predictions, threshold, margin)
            precision = metrics["accepted_extraction_precision"]
            eligible = (precision is not None and metrics["accepted"] > 0
                        and precision >= .99 and metrics["negative_acceptance_rate"] <= .01)
            report["candidates"].append({"threshold": threshold, "ambiguity_margin_threshold": margin,
                                         "constraints_met": eligible, **metrics})
            if eligible:
                key = (metrics["correct_warp_coverage"], metrics["accepted_warp_coverage"],
                       threshold, margin)
                if best is None or key > best:
                    best = key
    if best is not None:
        report.update(presence_threshold=best[2], ambiguity_margin_threshold=best[3],
                      calibrated=True, constraints_met=True, status="selected")
    else:
        threshold, _ = _legacy_calibrate(predictions)
        report.update(presence_threshold=threshold, status="constraints_unmet_legacy_fallback")
    report["selected_metrics"] = summarize(predictions, report["presence_threshold"],
                                           report["ambiguity_margin_threshold"])
    return report


def calibrate(predictions: Sequence[dict[str, Any]]) -> tuple[float, bool]:
    report = calibration_report(predictions)
    return report["presence_threshold"], report["calibrated"]


def comparison_result(candidate: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    keys = ("mean_corner_error", "p95_corner_error", "all_four_within_4_percent",
            "correct_warp_coverage", "negative_acceptance_rate")
    if any(candidate[key] is None or baseline[key] is None for key in keys):
        return {"accuracy_improved": None, "reason": "required_validation_metrics_unavailable"}
    deltas = {key: candidate[key] - baseline[key] for key in keys}
    regressions = [key for key in ("mean_corner_error", "p95_corner_error", "negative_acceptance_rate")
                   if deltas[key] > 1e-12]
    return {"accuracy_improved": deltas["correct_warp_coverage"] > 1e-12 and not regressions,
            "metric_deltas": deltas, "regressions": regressions,
            "policy": "higher correct-warp coverage without worse mean/p95 corner error or negative acceptance"}


def failure_details(item: dict[str, Any], threshold: float, ambiguity_threshold: float = 0.) -> dict[str, Any]:
    present = item["presence_probability"] >= threshold
    ambiguity_valid = float(item.get("ambiguity_margin", 1e9)) >= ambiguity_threshold
    accepted = present and item["quad_valid"] and ambiguity_valid
    reasons = []
    if item["actual_present"]:
        if not present:
            reasons.append("confidence_rejection")
        if not item["quad_valid"]:
            reasons.append("invalid_geometry")
        elif not ambiguity_valid:
            reasons.append("ambiguous_geometry")
        if max(item["corner_errors"], default=math.inf) > .04:
            reasons.append("corner_tolerance_failure")
        if item["warp_error"] is None or item["warp_error"] > .03:
            reasons.append("warp_tolerance_failure")
    else:
        if present:
            reasons.append("presence_false_positive")
        if not item["quad_valid"]:
            reasons.append("invalid_geometry")
        elif not ambiguity_valid:
            reasons.append("ambiguous_geometry")
        if accepted:
            reasons.append("negative_accepted")
    return {**item, "presence_threshold": threshold, "ambiguity_margin_threshold": ambiguity_threshold,
            "presence_detected": present,
            "accepted": accepted, "failure_reasons": reasons}


def write_failures(output: Path, predictions: Sequence[dict[str, Any]], records: Sequence[ExtractionRecord],
                   root: Path, threshold: float, ambiguity_threshold: float = 0.,
                   *, model=None, config=None, device=None) -> None:
    lookup = {record.sample_id: record for record in records}
    failures = sorted((failure_details(item, threshold, ambiguity_threshold) for item in predictions), key=lambda item: (
        item["actual_present"] == (item["presence_probability"] >= threshold),
        -max(item["corner_errors"], default=0)))[:100]
    gallery = output / "diagnostics" / "failures"
    gallery.mkdir(parents=True, exist_ok=True)
    previews = []
    for index, item in enumerate(failures):
        record = lookup[item["sample_id"]]
        item["ground_truth_corners"] = record.corners
        item["image_path"] = record.image_path
        item["boundary_review_hint"] = None
        if record.corners and item["corner_errors"] and np.mean(item["corner_errors"]) >= .01:
            actual = np.array([[p["x"], p["y"]] for p in record.corners])
            predicted = np.array([[p["x"], p["y"]] for p in item["corners"]])
            radial = ((predicted - actual) * (actual - actual.mean(0))).sum(-1)
            if np.all(radial > 0) or np.all(radial < 0):
                item["boundary_review_hint"] = "Review physical card versus sleeve/inner-frame boundary; not an automatic label correction."
        if index >= 20:
            continue
        with Image.open(root / record.image_path) as source:
            image = source.convert("RGB")
        heatmaps = None
        if model is not None:
            from .extraction_diagnostics import write_corner_heatmaps
            heatmaps = write_corner_heatmaps(image, model, config, device, gallery,
                                            f"failure-{index:03d}-{record.sample_id[:12]}", record.corners)
            item["heatmaps"] = heatmaps
            emit("extraction_heatmap_progress", completed=index + 1, total=min(20, len(failures)))
        image.thumbnail((640, 640), Image.Resampling.BICUBIC)
        draw = ImageDraw.Draw(image)
        for points, color in ((item["corners"], (0, 220, 255)), (record.corners, (255, 90, 90))):
            if points:
                pixels = [(point["x"] * (image.width - 1), point["y"] * (image.height - 1)) for point in points]
                draw.line([*pixels, pixels[0]], fill=color, width=3)
                for number, (x, y) in enumerate(pixels, 1):
                    draw.text((max(0, min(image.width - 20, x)), max(0, min(image.height - 15, y))),
                              str(number), fill=color, stroke_width=1, stroke_fill="black")
        caption = Image.new("RGB", (image.width, image.height + 65), "black")
        caption.paste(image, (0, 65))
        ImageDraw.Draw(caption).text((4, 3),
            f"Cyan: prediction  Red: label (1 TL, 2 TR, 3 BR, 4 BL)\n"
            f"Presence {item['presence_probability']:.4f} / {threshold:.4f}  Accepted: {item['accepted']}\n"
            f"Ambiguity {item.get('ambiguity_margin', 1e9):.4f} / {ambiguity_threshold:.4f}\n"
            + ", ".join(item["failure_reasons"]), fill="white")
        name = f"failure-{index:03d}-{record.sample_id[:12]}.jpg"
        caption.save(gallery / name, quality=90)
        previews.append({"sample_id": record.sample_id, "preview": name,
                         "heatmaps": heatmaps,
                         "accepted": item["accepted"], "failure_reasons": item["failure_reasons"],
                         "boundary_review_hint": item["boundary_review_hint"]})
    _write_jsonl(output / "failures.jsonl", failures)
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
        for name in {"thresholds.json", "grouped-metrics.json", "extractor.pt", "failures.jsonl", *previous.get("artifact_checksums", {})}:
            artifact = output / name
            expected = previous.get("artifact_checksums", {}).get(name)
            if not artifact.is_file() or (expected and _sha256(artifact) != expected):
                raise ValueError(f"Completed evaluation artifact is missing or changed: {name}; restore the original run artifacts")
        return previous
    calibration = predict(model, validation, root, device, batch_size, workers, checkpoint, "Real validation calibration")
    calibration_evidence = calibration_report(calibration)
    threshold = calibration_evidence["presence_threshold"]
    ambiguity_threshold = calibration_evidence.get("ambiguity_margin_threshold", 0.)
    calibrated = calibration_evidence["calibrated"]
    _write_json(output / "calibration.json", calibration_evidence)
    baseline_report = {"status": "not_available", "accuracy_improved": None,
                       "reason": "no_baseline_checkpoint" if baseline_checkpoint is None else
                                 "baseline_checkpoint_missing" if not baseline_checkpoint.is_file() else
                                 "no_real_validation_photos"}
    if baseline_checkpoint is not None and baseline_checkpoint.is_file() and validation:
        if baseline_checkpoint.resolve() == checkpoint_path.resolve():
            raise ValueError("Baseline must be a different preserved model, not the candidate")
        baseline_evaluation = baseline_checkpoint.parent / "evaluation.json"
        if baseline_evaluation.is_file():
            old_report = json.loads(baseline_evaluation.read_text(encoding="utf-8"))
            expected_hash = old_report.get("evaluation_identity", {}).get("checkpoint_sha256")
            if expected_hash and expected_hash != _sha256(baseline_checkpoint):
                raise ValueError("Preserved baseline checkpoint differs from its completed evaluation")
        old_config, old_model = _load_model(baseline_checkpoint, device)
        old_predictions = predict(old_model, validation, root, device, batch_size, workers, old_config, "Baseline on real validation")
        old_calibration = calibration_report(old_predictions)
        old_metrics = summarize(old_predictions, old_calibration["presence_threshold"],
                                old_calibration.get("ambiguity_margin_threshold", 0.))
        hashes = old_config.get("training_image_hashes")
        overlap = None if hashes is None else sum(item.image_sha256 in hashes for item in validation)
        baseline_report = {"status": "compared", "model_version": old_config["model_version"],
            "checkpoint_sha256": _sha256(baseline_checkpoint), "split": "validation",
            "candidate_model_version": checkpoint["model_version"],
            "candidate_checkpoint_sha256": identity["checkpoint_sha256"],
            "manifest_sha256": identity["manifest_sha256"],
            "candidate_metrics_at_0_5": summarize(calibration),
            "candidate_metrics_at_serving_threshold": summarize(calibration, threshold, ambiguity_threshold),
            "threshold_policy": "Both checkpoints calibrated independently on these same real validation photos",
            "selected_epoch": old_config.get("epoch"), "candidate_selected_epoch": checkpoint.get("epoch"),
            "metrics_at_0_5": summarize(old_predictions), "metrics_at_serving_threshold": old_metrics,
            "calibration": old_calibration, "training_overlap": "unknown" if overlap is None else overlap,
            "samples": [{"sample_id": item.sample_id, "previously_seen": None if hashes is None else item.image_sha256 in hashes}
                        for item in validation],
            **comparison_result(summarize(calibration, threshold, ambiguity_threshold), old_metrics),
            "warning": "Training membership is unknown or overlaps validation; comparison is diagnostic, not unbiased held-out evidence."
                       if overlap is None or overlap else None}
        if overlap is None or overlap:
            baseline_report["accuracy_improved"] = None
        del old_model
    _write_json(output / "baseline-comparison.json", baseline_report)
    emit("extraction_baseline_compared", **{key: baseline_report.get(key)
         for key in ("status", "reason", "model_version", "accuracy_improved", "training_overlap")})
    write_failures(output / "diagnostics" / "validation", calibration, validation, root, threshold,
                   ambiguity_threshold,
                   model=model, config=checkpoint, device=device)
    # All calibration/comparison decisions precede the locked-test prediction pass.
    predictions = predict(model, test, root, device, batch_size, workers, checkpoint, "Locked real test")
    metrics = summarize(predictions, threshold, ambiguity_threshold)
    conditions = {}
    for condition in sorted({item["capture_condition"] for item in predictions}):
        subset = [item for item in predictions if item["capture_condition"] == condition]
        conditions[condition] = {**summarize(subset, threshold, ambiguity_threshold),
                                 "source_groups": len({item["source_group"] for item in subset})}
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
    report = {"evaluation_schema_version": 4, "artifact_schema_version": checkpoint["artifact_schema_version"],
              "dataset_version": checkpoint["dataset_version"], "model_version": checkpoint["model_version"],
              "evaluation_identity": identity, "split": "test" if test else "unavailable",
              "development_only": not calibrated or not test, "validation_samples": len(validation),
              "test_samples": len(test), "metrics": metrics,
              "validation_metrics": summarize(calibration, threshold, ambiguity_threshold),
              "validation_at_0_5": summarize(calibration), "grouped_conditions": conditions,
              "gates": {"metrics": metric_gate, "real_camera_coverage": coverage_gate, "conditions": condition_gate},
              "qualified": qualified, "calibrated": calibrated,
              "calibration": calibration_evidence, "baseline_comparison": baseline_report,
              "test_usage": {"purpose": "locked regression check", "fresh_blind_qualification_claimed": False,
                             "note": "Prior supplied test failures were inspected during recipe design; they must not enter training."},
              "coverage_warnings": (["Unlabeled real-camera conditions cannot qualify."] if "unlabeled" in conditions else [])
                  + (["Insufficient independent locked-test photographs/groups."] if not coverage_gate else [])
                  + (["Calibration constraints unavailable or unmet; using a labeled fallback threshold."] if not calibrated else [])
                  + (["Calibration is provisional: fewer than 200 validation negatives."] if calibration_evidence["provisional"] else [])}
    validation_metrics = report["validation_metrics"]
    report["development_targets_met"] = all(validation_metrics[key] is not None and predicate(validation_metrics[key])
        for key, predicate in (("mean_corner_error", lambda value: value <= .03),
                               ("p95_corner_error", lambda value: value <= .08),
                               ("all_four_within_4_percent", lambda value: value >= .8),
                               ("correct_warp_coverage", lambda value: value >= .9)))
    promotion_targets = {"correct_warp_coverage": .70, "all_four_within_4_percent": .85,
                         "maximum_mean_corner_error": .03, "maximum_p95_corner_error": .06,
                         "maximum_accepted_negatives": 0}
    promotion_eligible = bool(test and metrics["correct_warp_coverage"] is not None
        and metrics["correct_warp_coverage"] >= promotion_targets["correct_warp_coverage"]
        and metrics["all_four_within_4_percent"] is not None
        and metrics["all_four_within_4_percent"] >= promotion_targets["all_four_within_4_percent"]
        and metrics["mean_corner_error"] is not None and metrics["mean_corner_error"] <= .03
        and metrics["p95_corner_error"] is not None and metrics["p95_corner_error"] <= .06
        and metrics["accepted"] - metrics["accepted_positive"] == 0)
    report["promotion"] = {"eligible": promotion_eligible, "targets": promotion_targets,
                           "purpose": "development regression protection, not blind qualification",
                           "previous_preview_preserved_when_ineligible": True}
    synthetic = [item for item in records if item.source_kind != "real" and item.split == "test"]
    synthetic_predictions = predict(model, synthetic, root, device, batch_size, workers, checkpoint, "Separate synthetic test")
    report["synthetic_metrics"] = summarize(synthetic_predictions, threshold, ambiguity_threshold)
    thresholds = {"threshold_schema_version": 4, "artifact_schema_version": checkpoint["artifact_schema_version"],
                  "dataset_version": checkpoint["dataset_version"], "model_version": checkpoint["model_version"],
                  "presence_threshold": threshold, "ambiguity_margin_threshold": ambiguity_threshold,
                  "calibrated": calibrated, "minimum_area": .0025,
                  "calibration_provisional": calibration_evidence["provisional"],
                  "calibration_status": calibration_evidence["status"],
                  "corner_order": list(CORNER_ORDER)}
    _write_json(output / "thresholds.json", thresholds)
    _write_json(output / "grouped-metrics.json", {"capture_conditions": conditions,
        "condition_tags": {tag: summarize([item for item in predictions if tag in item["condition_tags"]], threshold,
                                           ambiguity_threshold)
                           for tag in sorted({tag for item in predictions for tag in item["condition_tags"]})},
        "source_kinds": {kind: summarize([item for item in [*predictions, *synthetic_predictions]
                                          if item["source_kind"] == kind], threshold, ambiguity_threshold)
                         for kind in sorted({item["source_kind"] for item in [*predictions, *synthetic_predictions]})}})
    write_failures(output, predictions, test, root, threshold, ambiguity_threshold,
                   model=model, config=checkpoint, device=device)
    compact = {key: checkpoint[key] for key in ("artifact_schema_version", "dataset_version", "model_version",
               "architecture", "input_size", "corner_order")}
    compact.update({key: checkpoint[key] for key in ("heatmap_size", "decoder_channels", "decoder_policy")
                    if key in checkpoint})
    compact.update(normalization_mean=checkpoint.get("normalization_mean", NORMALIZE_MEAN),
                   normalization_std=checkpoint.get("normalization_std", NORMALIZE_STD), model_state=model.state_dict(),
                   training_recipe_version=checkpoint.get("training_recipe_version"),
                   target_boundary=checkpoint.get("target_boundary", "physical-card-excluding-sleeve"),
                   selected_weight_source=checkpoint.get("selected_weight_source", "raw"))
    _atomic_torch_save(compact, output / "extractor.pt")
    compact_config, compact_model = _load_model(output / "extractor.pt", device)
    parity_records = validation[:1] or test[:1]
    if parity_records:
        original = predict(model, parity_records, root, device, 1, 0, checkpoint)
        reloaded = predict(compact_model, parity_records, root, device, 1, 0, compact_config)
        parity = (np.allclose([[value for point in item["corners"] for value in point.values()] for item in original],
                              [[value for point in item["corners"] for value in point.values()] for item in reloaded], atol=1e-6)
                  and np.allclose([item["presence_probability"] for item in original],
                                  [item["presence_probability"] for item in reloaded], atol=1e-6))
        if not parity:
            raise RuntimeError("Compact extractor reload changed inference output")
    else:
        parity = True
    report["compact_reload_parity"] = parity
    report["artifact_checksums"] = {name: _sha256(output / name)
        for name in ("thresholds.json", "grouped-metrics.json", "extractor.pt", "failures.jsonl", "calibration.json", "baseline-comparison.json")}
    _write_json(output / "evaluation.json", report)
    emit("extraction_evaluated", qualified=qualified, split=report["split"], **metrics)
    return report

"""Persistent, side-effect-free corner suggestions for the WPF annotator."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import torch
from PIL import Image, ImageOps

from .events import emit
from .extraction import (NORMALIZE_MEAN, NORMALIZE_STD, _device, _load_model, _quad_valid,
                         _sha256, letterbox, unletterbox)
from .extraction_network import decode_geometry


def _suggest(image_path: Path, model, checkpoint: dict[str, Any], thresholds: dict[str, Any],
             device: torch.device) -> dict[str, Any]:
    with Image.open(image_path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    input_size = int(checkpoint["input_size"])
    tensor, _ = letterbox(image, input_size=input_size,
                          mean=checkpoint.get("normalization_mean", NORMALIZE_MEAN),
                          std=checkpoint.get("normalization_std", NORMALIZE_STD))
    with torch.inference_mode():
        if hasattr(model, "forward_geometry"):
            outputs = model.forward_geometry(tensor.unsqueeze(0).to(device))
            predicted, details = decode_geometry(outputs)
            presence_logits = outputs["presence_logits"]
            geometry = details[0]
        else:
            predicted, presence_logits = model(tensor.unsqueeze(0).to(device))
            geometry = {"geometry_valid": True, "ambiguity_margin": 1e9,
                        "candidate_score": None, "mask_iou": None,
                        "detected_peaks": None, "candidate_count": None,
                        "orientation_class": None, "orientation_probability": None}
    probability = float(presence_logits[0].sigmoid().cpu())
    corners = unletterbox(predicted[0].cpu().tolist(), image.width, image.height, input_size)
    valid = bool(geometry["geometry_valid"] and _quad_valid(corners))
    presence_threshold = float(thresholds.get("presence_threshold", .5))
    ambiguity_threshold = float(thresholds.get("ambiguity_margin_threshold", 0.))
    ambiguity_margin = float(geometry.get("ambiguity_margin", 1e9))
    accepted = valid and probability >= presence_threshold and ambiguity_margin >= ambiguity_threshold
    rejection_reason = None if accepted else (
        "invalid_quadrilateral" if not valid else
        "presence_below_threshold" if probability < presence_threshold else
        "ambiguous_card_geometry")
    return {
        "corners": corners if valid else None,
        "geometry_valid": valid,
        "would_be_accepted": accepted,
        "rejection_reason": rejection_reason,
        "presence_probability": probability,
        "presence_threshold": presence_threshold,
        "ambiguity_margin": ambiguity_margin,
        "ambiguity_margin_threshold": ambiguity_threshold,
        "candidate_score": geometry.get("candidate_score"),
        "mask_iou": geometry.get("mask_iou"),
        "detected_peaks": geometry.get("detected_peaks"),
        "candidate_count": geometry.get("candidate_count"),
        "orientation_class": geometry.get("orientation_class"),
        "orientation_probability": geometry.get("orientation_probability"),
    }


def run_worker(checkpoint_path: Path, thresholds_path: Path, device_name: str,
               cuda_index: int | None) -> int:
    thresholds = json.loads(thresholds_path.read_text(encoding="utf-8"))
    device = _device(device_name, cuda_index)
    checkpoint, model = _load_model(checkpoint_path, device)
    if thresholds.get("model_version") != checkpoint.get("model_version"):
        raise ValueError("Extraction thresholds do not match the suggestion model")
    identity = {"model_version": checkpoint["model_version"],
                "checkpoint_sha256": _sha256(checkpoint_path), "device": str(device)}
    emit("extraction_suggestion_ready", **identity)
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = str(request["request_id"])
            image_path = Path(request["image_path"])
            result = _suggest(image_path, model, checkpoint, thresholds, device)
            emit("extraction_suggestion", request_id=request_id, **identity, **result)
        except Exception as error:  # A bad photograph must not terminate the warmed worker.
            emit("extraction_suggestion_error", request_id=request_id,
                 message=str(error), **identity)
    return 0

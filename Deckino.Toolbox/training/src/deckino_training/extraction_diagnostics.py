"""Bounded inspection overlays for both current and preserved extraction models."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

from .extraction import (CORNER_ORDER, LEGACY_COORDINATE_TRANSFORM, NORMALIZE_MEAN, NORMALIZE_STD,
                         _write_json, letterbox, unletterbox)
from .extraction_network import decode_geometry


def heatmap_statistics(logits: torch.Tensor) -> tuple[np.ndarray, list[dict]]:
    """Describe competing peaks in legacy four-semantic-corner heatmaps."""
    if logits.ndim != 3 or logits.shape[0] != 4 or min(logits.shape[1:]) < 2:
        raise ValueError("Expected four spatial corner heatmaps")
    if not torch.isfinite(logits).all():
        raise ValueError("Non-finite corner heatmaps")
    probabilities = logits.detach().float().flatten(1).softmax(-1).reshape_as(logits).cpu().numpy()
    height, width = probabilities.shape[1:]
    yy, xx = np.mgrid[:height, :width]
    statistics = []
    for name, probability in zip(CORNER_ORDER, probabilities):
        peak_y, peak_x = np.unravel_index(probability.argmax(), probability.shape)
        outside_peak = (xx - peak_x) ** 2 + (yy - peak_y) ** 2 > 4 ** 2
        second_peak = float(probability[outside_peak].max()) if outside_peak.any() else 0.
        peak = float(probability[peak_y, peak_x])
        statistics.append({"corner": name,
            "expected_tensor_xy": [float((probability * xx).sum() / (width - 1)),
                                    float((probability * yy).sum() / (height - 1))],
            "peak_tensor_xy": [float(peak_x / (width - 1)), float(peak_y / (height - 1))],
            "peak_probability": peak, "second_peak_outside_4_cells_ratio": second_peak / peak,
            "normalized_entropy": float(-(probability * np.log(np.maximum(probability, 1e-30))).sum()
                                        / math.log(height * width))})
    return probabilities, statistics


def _render_panel(rgb: np.ndarray, intensity: np.ndarray, title: str, points=()) -> Image.Image:
    size = rgb.shape[0]
    normalized = intensity / max(float(intensity.max()), 1e-8)
    alpha = normalized[..., None] * .7
    panel = Image.fromarray((rgb * (1 - alpha) + np.array([255, 120, 0]) * alpha).astype(np.uint8))
    draw = ImageDraw.Draw(panel)
    for point, color in points:
        x, y = [float(value) * (size - 1) for value in point]
        draw.ellipse((x - 4, y - 4, x + 4, y + 4), outline=color, width=2)
    caption = Image.new("RGB", (size, size + 48), "black")
    caption.paste(panel, (0, 48))
    ImageDraw.Draw(caption).text((4, 4), title, fill="white")
    return caption


def write_corner_heatmaps(image: Image.Image, model, config: dict, device: torch.device,
                          output: Path, stem: str, ground_truth=None) -> dict:
    if not hasattr(model, "forward_geometry") and not hasattr(model, "forward_with_heatmaps"):
        return {"status": "unavailable", "reason": "legacy_coordinate_model_has_no_heatmaps"}
    size = config["input_size"]
    mean = config.get("normalization_mean", NORMALIZE_MEAN)
    std = config.get("normalization_std", NORMALIZE_STD)
    coordinate_transform = config.get("coordinate_transform", LEGACY_COORDINATE_TRANSFORM)
    tensor, targets = letterbox(image, ground_truth, size, mean, std, coordinate_transform)
    model.eval()
    if hasattr(model, "forward_geometry"):
        with torch.inference_mode():
            outputs = model.forward_geometry(tensor[None].to(device))
            corners, decoded = decode_geometry(outputs)
        corner_probability = outputs["corner_logits"][0, 0].sigmoid().cpu()
        mask_probability = outputs["mask_logits"][0, 0].sigmoid().cpu()
        resized_corner = torch.nn.functional.interpolate(corner_probability[None, None], (size, size),
            mode="bilinear", align_corners=True)[0, 0].numpy()
        resized_mask = torch.nn.functional.interpolate(mask_probability[None, None], (size, size),
            mode="bilinear", align_corners=True)[0, 0].numpy()
        tensor_xy = corners[0].tolist()
        rgb = tensor.numpy().transpose(1, 2, 0) * np.asarray(std) + np.asarray(mean)
        rgb = np.clip(rgb * 255, 0, 255).astype(np.uint8)
        decoded_points = [(tensor_xy[index:index + 2], "cyan") for index in range(0, 8, 2)]
        target_points = [] if targets is None else [(targets[index:index + 2].tolist(), "red") for index in range(0, 8, 2)]
        panels = [_render_panel(rgb, resized_corner, "Generic corner peaks\nCyan=decoded Red=label",
                                [*decoded_points, *target_points]),
                  _render_panel(rgb, resized_mask, "Complete-card mask\nOrange=predicted extent")]
        semantic_statistics = None
        if "semantic_corner_logits" in outputs:
            semantic_logits = outputs["semantic_corner_logits"][0].cpu()
            _, semantic_statistics = heatmap_statistics(semantic_logits)
            for index, (name, values) in enumerate(zip(CORNER_ORDER, semantic_logits.sigmoid())):
                intensity = torch.nn.functional.interpolate(values[None, None], (size, size),
                    mode="bilinear", align_corners=True)[0, 0].numpy()
                points = [decoded_points[index]]
                if targets is not None:
                    points.append(target_points[index])
                panels.append(_render_panel(rgb, intensity, f"Semantic {name}\nCyan=decoded Red=label", points))
        rows = math.ceil(len(panels) / 2)
        gallery = Image.new("RGB", (size * 2, (size + 48) * rows), "black")
        for index, panel in enumerate(panels):
            gallery.paste(panel, (index % 2 * size, index // 2 * (size + 48)))
        details = decoded[0]
        details["output_source_corners"] = unletterbox(tensor_xy, image.width, image.height, size,
                                                        coordinate_transform)
        details["annotated_tensor_corners"] = targets.reshape(4, 2).tolist() if targets is not None else None
        report_value = {"heatmap_schema_version": 2, "inspection_only": True,
            "model_version": config["model_version"], "selected_epoch": config.get("epoch"),
            "selected_weight_source": config.get("selected_weight_source", "raw"),
            "input_size": size, "heatmap_size": list(corner_probability.shape),
            "presence_probability": float(outputs["presence_logits"][0].sigmoid().cpu()),
            "orientation_probabilities": outputs["orientation_logits"][0].softmax(0).cpu().tolist(),
            "semantic_corner_heatmaps": semantic_statistics,
            "decoder": details,
            "visualization": "Generic and semantic corner intensity plus complete-card mask; cyan is final semantic corner order."}
    elif hasattr(model, "forward_with_heatmaps"):
        with torch.inference_mode():
            corners, presence, logits = model.forward_with_heatmaps(tensor[None].to(device))
        probabilities, statistics = heatmap_statistics(logits[0])
        tensor_xy = corners[0].cpu().tolist()
        rgb = tensor.numpy().transpose(1, 2, 0) * np.asarray(std) + np.asarray(mean)
        rgb = np.clip(rgb * 255, 0, 255).astype(np.uint8)
        panels = []
        for index, (probability, item) in enumerate(zip(probabilities, statistics)):
            intensity = torch.nn.functional.interpolate(torch.from_numpy(probability)[None, None], (size, size),
                mode="bilinear", align_corners=True)[0, 0].numpy()
            points = [(tensor_xy[index * 2:index * 2 + 2], "cyan"), (item["peak_tensor_xy"], "yellow")]
            if targets is not None:
                points.append((targets[index * 2:index * 2 + 2].tolist(), "red"))
            panels.append(_render_panel(rgb, intensity, f"{index + 1}: {item['corner']}\nCyan=output Yellow=peak", points))
            item["output_tensor_xy"] = tensor_xy[index * 2:index * 2 + 2]
        gallery = Image.new("RGB", (size * 2, (size + 48) * 2), "black")
        for index, panel in enumerate(panels):
            gallery.paste(panel, (index % 2 * size, index // 2 * (size + 48)))
        report_value = {"heatmap_schema_version": 1, "inspection_only": True,
            "model_version": config["model_version"], "selected_epoch": config.get("epoch"),
            "input_size": size, "heatmap_size": list(probabilities.shape[1:]),
            "presence_probability": float(presence[0].sigmoid().cpu()), "corner_order": list(CORNER_ORDER),
            "visualization": "Legacy relative intensity per semantic corner.", "corners": statistics}
    output.mkdir(parents=True, exist_ok=True)
    preview, report = f"{stem}-heatmaps.png", f"{stem}-heatmaps.json"
    gallery.save(output / preview)
    _write_json(output / report, report_value)
    return {"status": "written", "preview": preview, "report": report}

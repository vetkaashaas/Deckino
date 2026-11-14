"""Phone frame, letterbox and geometry decoding shared by validation and benchmarking."""
from __future__ import annotations

import itertools
import math
from typing import Any

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset

from .extraction import (LEGACY_COORDINATE_TRANSFORM, NORMALIZE_MEAN, NORMALIZE_STD,
                         _letterbox_geometry)
from .extraction_network import _portrait_orientation, _screen_clockwise_indices

PHONE_PIPELINE_POLICY = "phone-frame-480-nearest-grid-refiner-v1"
PHONE_SHORT_SIDE = 480


def phone_frame_size(width: int, height: int) -> tuple[int, int]:
    scale = min(1., PHONE_SHORT_SIDE / min(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def phone_frame(image: Image.Image) -> np.ndarray:
    image = image.convert("RGB")
    size = phone_frame_size(*image.size)
    return np.asarray(image.resize(size, Image.Resampling.BILINEAR) if size != image.size else image,
                      dtype=np.uint8)


class PhoneExtractionDataset(Dataset):
    """Validation-only normalized phone frames; annotations remain in photo-normalized coordinates."""
    def __init__(self, image_root, records, input_size=320, mean=NORMALIZE_MEAN, std=NORMALIZE_STD,
                 coordinate_transform=None):
        self.image_root, self.records, self.input_size = image_root, records, input_size
        self.mean = np.asarray(mean, dtype=np.float32)[:, None, None]
        self.std = np.asarray(std, dtype=np.float32)[:, None, None]

    def __len__(self):
        return len(self.records)

    def __getitem__(self, index):
        record = self.records[index]
        with Image.open(self.image_root / record.image_path) as image:
            frame = phone_frame(image)
        tensor = torch.from_numpy((_letterbox(frame, self.input_size) - self.mean) / self.std)
        return tensor, torch.zeros(8), torch.tensor(float(record.card_present)), record.sample_id


# decode-geometry.ts
TOP_K = 8
MINIMUM_CORNER_LOGIT = math.log(.05 / .95)
MAXIMUM_PEAK_CANDIDATES = TOP_K * 4
MINIMUM_QUAD_AREA = .0025
MINIMUM_MASK_IOU = .75
NMS_RADIUS = 2
LEGACY_OFFSET_RANGE = .5
POINT_IN_QUAD_EPSILON = 1e-6


def _sigmoid(value: float) -> float:
    return 1 / (1 + math.exp(-value)) if value >= 0 else math.exp(value) / (1 + math.exp(value))


def _log_softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - values.max()
    return shifted - np.log(np.exp(shifted).sum())


def _letterbox(frame: np.ndarray, size: int) -> np.ndarray:
    """letterboxPackedRgbToPlanarRgb: nearest neighbour into a black square, planar [0, 1] RGB."""
    height, width = frame.shape[:2]
    resized_width, resized_height, left, top, _, _ = _letterbox_geometry(width, height, size,
                                                                         LEGACY_COORDINATE_TRANSFORM)
    xs = np.minimum(width - 1, ((np.arange(resized_width) + .5) / resized_width * width).astype(np.int64))
    ys = np.minimum(height - 1, ((np.arange(resized_height) + .5) / resized_height * height).astype(np.int64))
    pixels = np.zeros((3, size, size), dtype=np.float32)
    pixels[:, top:top + resized_height, left:left + resized_width] = \
        frame[ys[:, None], xs[None, :]].transpose(2, 0, 1) / 255
    return pixels


def _peaks(logits: np.ndarray, offsets: np.ndarray, offset_range: float) -> list[tuple[float, float, float, int, int]]:
    """collectPeaks: 5x5 local maxima above the corner floor, best 32, then 8 at least NMS_RADIUS cells apart."""
    size = logits.shape[0]
    windows = np.lib.stride_tricks.sliding_window_view(np.pad(logits, 2, constant_values=-np.inf), (5, 5))
    flat = np.flatnonzero((logits > MINIMUM_CORNER_LOGIT) & (logits >= windows.max(axis=(2, 3))))
    ranked = flat[np.lexsort((flat, -logits.ravel()[flat]))][:MAXIMUM_PEAK_CANDIDATES]
    peaks: list[tuple[float, float, float, int, int]] = []
    for index in ranked.tolist():
        if len(peaks) == TOP_K:
            break
        y, x = divmod(index, size)
        if any(max(abs(x - peak[3]), abs(y - peak[4])) <= NMS_RADIUS for peak in peaks):
            continue
        offset_x, offset_y = np.clip(offsets[:, y, x], -offset_range, offset_range).tolist()
        # The app keeps peak probabilities in float32 (Math.fround).
        peaks.append((min(1., max(0., (x + offset_x) / (size - 1))), min(1., max(0., (y + offset_y) / (size - 1))),
                      float(np.float32(_sigmoid(logits[y, x]))), x, y))
    return peaks


def _valid_ordered_quad(points: np.ndarray) -> bool:
    if not (np.isfinite(points).all() and (points >= 0).all() and (points <= 1).all()):
        return False
    edges = np.roll(points, -1, axis=0) - points
    following = np.roll(edges, -1, axis=0)
    crosses = edges[:, 0] * following[:, 1] - edges[:, 1] * following[:, 0]
    area = abs(float(np.sum(points[:, 0] * np.roll(points[:, 1], -1) - points[:, 1] * np.roll(points[:, 0], -1)))) / 2
    return area >= MINIMUM_QUAD_AREA and bool((crosses > 1e-8).all() or (crosses < -1e-8).all())


def _mask_iou(points: np.ndarray, mask: np.ndarray, grid_x: np.ndarray, grid_y: np.ndarray) -> float:
    """maskIou: heatmap cells (cell / (size - 1)) inside the quad, epsilon-inclusive, against the mask."""
    positive = np.ones_like(mask)
    negative = np.ones_like(mask)
    for index in range(4):
        (ax, ay), (bx, by) = points[index], points[(index + 1) % 4]
        cross = (bx - ax) * (grid_y - ay) - (by - ay) * (grid_x - ax)
        positive &= cross >= -POINT_IN_QUAD_EPSILON
        negative &= cross <= POINT_IN_QUAD_EPSILON
    polygon = positive | negative
    intersection = int((polygon & mask).sum())
    union = int(mask.sum()) + int(polygon.sum()) - intersection
    return intersection / union if union else 0.


def decode_phone_geometry(outputs: dict[str, np.ndarray], manifest: dict[str, Any]
                          ) -> tuple[list[float], dict[str, Any]]:
    """Decode before presence/margin acceptance so calibration sees every photo."""
    if not all(np.isfinite(value).all() for value in outputs.values()):
        raise RuntimeError("Extractor inference returned non-finite predictions")
    size = manifest["heatmap_size"]
    corner_logits = outputs["corner_logits"].reshape(size, size)
    semantic = outputs.get("semantic_corner_logits")
    semantic = None if semantic is None else semantic.reshape(4, size, size)
    peaks = _peaks(corner_logits if semantic is None else np.maximum(corner_logits, semantic.max(axis=0)),
                   outputs["offsets"].reshape(2, size, size), manifest.get("offset_range") or LEGACY_OFFSET_RANGE)
    mask = outputs["mask_logits"].reshape(size, size) >= 0
    grid_x, grid_y = np.meshgrid(np.arange(size) / max(1, size - 1), np.arange(size) / max(1, size - 1))
    best: tuple[float, np.ndarray, list[tuple[int, int]]] | None = None
    second, count = -math.inf, 0
    for group in itertools.combinations(peaks, 4):
        unordered = np.array([peak[:2] for peak in group], dtype=np.float64)
        order = _screen_clockwise_indices(unordered, manifest["corner_anchor_policy"]).tolist()
        points = unordered[order]
        if not _valid_ordered_quad(points):
            continue
        iou = _mask_iou(points, mask, grid_x, grid_y)
        if iou < MINIMUM_MASK_IOU:
            continue
        score = sum(math.log(max(group[index][2], 1e-8)) for index in order) / 4 + 2 * iou
        count += 1
        if best is None or score > best[0]:
            if best is not None:
                second = best[0]
            best = (score, points, [(group[index][3], group[index][4]) for index in order])
        elif score > second:
            second = score
    details = {"geometry_valid": best is not None, "detected_peaks": len(peaks), "candidate_count": count,
               "peak_points": [[p[0], p[1]] for p in peaks], "candidate_score": -1e9,
               "ambiguity_margin": -1e9, "mask_iou": 0., "corner_scores": [],
               "orientation_class": None, "orientation_probability": None}
    if best is None:
        return [0.] * 8, details
    score, points, cells = best
    orientation_logits = outputs["orientation_logits"].ravel()
    orientation = int(np.argmax(orientation_logits))
    semantic_margin = 1e9
    if semantic is not None:
        orientation_scores = _log_softmax(orientation_logits)
        roles = [_log_softmax(semantic[:, y, x]) for x, y in cells]
        scores = [sum(roles[index][(index - role) % 4] for index in range(4)) / 4 + .5 * orientation_scores[role]
                  for role in range(4)]
        orientation = int(np.argmax(scores))
        ranked = sorted(scores, reverse=True)
        semantic_margin = float(ranked[0] - ranked[1])
    orientation = _portrait_orientation(points.tolist(), orientation)
    corners = np.roll(points, -orientation, axis=0).ravel().tolist()
    margin = min(score - second if count > 1 else 1e9, semantic_margin)
    details.update(candidate_score=score, ambiguity_margin=margin,
                   geometry_ambiguity_margin=score - second if count > 1 else 1e9,
                   semantic_ambiguity_margin=semantic_margin,
                   mask_iou=_mask_iou(points, mask, grid_x, grid_y), orientation_class=orientation)
    return corners, details


def _decode(outputs: dict[str, np.ndarray], manifest: dict[str, Any],
            thresholds: dict[str, Any]) -> tuple[list[float] | None, str | None]:
    """Phone decodeGeometry + acceptExtraction, also used by the exported-model benchmark."""
    if _sigmoid(float(outputs["presence_logits"].ravel()[0])) < thresholds["presence_threshold"]:
        return None, "presence_below_threshold"
    corners, details = decode_phone_geometry(outputs, manifest)
    if not details["geometry_valid"]:
        return None, "invalid_quadrilateral"
    return corners, ("ambiguous_card_geometry"
                     if details["ambiguity_margin"] < thresholds["ambiguity_margin_threshold"] else None)


class TorchRefinerSession:
    """Run the phone's frame/crop graph with live PyTorch weights during checkpoint selection."""
    def __init__(self, model, device):
        from .extraction_refiner import CROP_SIZE, FILL_RGB
        self.model, self.device = model.eval(), device
        self.side = CROP_SIZE
        ys, xs = np.mgrid[0:CROP_SIZE, 0:CROP_SIZE]
        self.points = torch.tensor(np.stack([xs.ravel(), ys.ravel(), np.ones(CROP_SIZE ** 2)], axis=1),
                                   dtype=torch.float32, device=device)
        self.fill = torch.tensor(FILL_RGB, dtype=torch.float32, device=device).view(1, 3, 1, 1)
        self.mean = torch.tensor(NORMALIZE_MEAN, device=device).view(1, 3, 1, 1)
        self.std = torch.tensor(NORMALIZE_STD, device=device).view(1, 3, 1, 1)

    @torch.inference_mode()
    def run(self, output_names, inputs):
        frame = torch.from_numpy(inputs["frame"]).to(self.device, dtype=torch.float32)
        affine = torch.from_numpy(inputs["crop_affine"]).to(self.device)
        grids = (self.points @ affine.transpose(1, 2)).reshape(4, self.side, self.side, 2)
        grid = grids.permute(1, 0, 2, 3).reshape(1, self.side, 4 * self.side, 2)
        sampled = torch.nn.functional.grid_sample(frame - self.fill, grid, mode="bicubic",
                                                  padding_mode="zeros", align_corners=True) + self.fill
        row = sampled.clamp(0, 255).round() / 255
        crops = row.reshape(3, self.side, 4, self.side).permute(2, 0, 1, 3)
        outputs = self.model((crops - self.mean) / self.std)
        if not all(torch.isfinite(value).all() for value in outputs.values()):
            raise RuntimeError("Corner refiner inference returned non-finite predictions")
        return [outputs[name].cpu().numpy() for name in output_names]

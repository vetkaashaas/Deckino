"""Geometry-aware MobileNet card extraction; independent of artwork identity."""
from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw
from torch import Tensor, nn
from torch.nn import functional as F
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

ARCHITECTURE = "mobilenetv3-small-card-geometry-v1"
PREVIOUS_SPATIAL_ARCHITECTURE = "mobilenetv3-small-spatial-v2"
TRAINING_RECIPE = 4
INPUT_SIZE = 320
HEATMAP_SIZE = 80
DECODER_CHANNELS = 48
TOP_K_CORNERS = 8
MINIMUM_CORNER_PEAK = .05
MINIMUM_QUAD_AREA = .0025
MASK_THRESHOLD = .5
EMA_DECAY = .999


class SpatialRefinement(nn.Sequential):
    def __init__(self, channels: int = DECODER_CHANNELS) -> None:
        super().__init__(nn.Conv2d(channels, channels, 3, padding=1, groups=channels, bias=False),
                         nn.Conv2d(channels, channels, 1, bias=False), nn.GroupNorm(8, channels), nn.Hardswish())


class PreviousSpatialCardExtractor(nn.Module):
    """Read-only recipe-3 architecture retained for old previews and comparisons."""
    def __init__(self) -> None:
        super().__init__()
        network = mobilenet_v3_small(weights=None)
        self.features = network.features
        self.lateral = nn.ModuleList(nn.Conv2d(channels, 32, 1) for channels in (16, 24, 48, 576))
        self.refine = nn.ModuleList(nn.Sequential(
            nn.Conv2d(32, 32, 3, padding=1, groups=32, bias=False), nn.Conv2d(32, 32, 1, bias=False),
            nn.GroupNorm(8, 32), nn.Hardswish()) for _ in range(3))
        self.corner_head = nn.Conv2d(32, 4, 1)
        self.presence_head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(),
                                           nn.Linear(576, 128), nn.Hardswish(), nn.Linear(128, 1))

    def forward_with_heatmaps(self, images: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        maps, values = [], images
        for index, layer in enumerate(self.features):
            values = layer(values)
            if index in (1, 3, 8, 12):
                maps.append(values)
        spatial = self.lateral[3](maps[3])
        for block, index in zip(self.refine, (2, 1, 0)):
            spatial = block(F.interpolate(spatial, size=maps[index].shape[-2:], mode="bilinear", align_corners=False)
                            + self.lateral[index](maps[index]))
        logits = self.corner_head(spatial).float()
        distribution = logits.flatten(2).softmax(-1).reshape_as(logits)
        xs = torch.linspace(0, 1, logits.shape[-1], device=logits.device)
        ys = torch.linspace(0, 1, logits.shape[-2], device=logits.device)
        x = (distribution.sum(dim=2) * xs).sum(dim=-1)
        y = (distribution.sum(dim=3) * ys).sum(dim=-1)
        return torch.stack((x, y), dim=-1).flatten(1), self.presence_head(maps[-1]).squeeze(1).float(), logits

    def forward(self, images: Tensor) -> tuple[Tensor, Tensor]:
        corners, presence, _ = self.forward_with_heatmaps(images)
        return corners, presence


class CardExtractor(nn.Module):
    def __init__(self, pretrained: bool = False) -> None:
        super().__init__()
        network = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT if pretrained else None)
        self.features = network.features
        self.lateral = nn.ModuleList(nn.Conv2d(channels, DECODER_CHANNELS, 1)
                                     for channels in (16, 24, 48, 576))
        self.refine = nn.ModuleList(SpatialRefinement() for _ in range(3))
        self.corner_head = nn.Conv2d(DECODER_CHANNELS, 1, 1)
        self.offset_head = nn.Conv2d(DECODER_CHANNELS, 2, 1)
        self.mask_head = nn.Conv2d(DECODER_CHANNELS, 1, 1)
        self.orientation_head = nn.Sequential(nn.Linear(576 + DECODER_CHANNELS, 128), nn.Hardswish(), nn.Linear(128, 4))
        self.presence_head = nn.Sequential(nn.Linear(576 + DECODER_CHANNELS + 2, 128), nn.Hardswish(), nn.Linear(128, 1))
        nn.init.constant_(self.corner_head.bias, -2.19)
        nn.init.constant_(self.mask_head.bias, -1.5)
        self.train(self.training)

    def train(self, mode: bool = True) -> CardExtractor:
        super().train(mode)
        for layer in self.features.modules():
            if isinstance(layer, nn.BatchNorm2d):
                layer.eval()
        return self

    def set_backbone_trainable(self, enabled: bool) -> None:
        for parameter in self.features.parameters():
            parameter.requires_grad_(enabled)

    def forward_geometry(self, images: Tensor) -> dict[str, Tensor]:
        maps, values = [], images
        for index, layer in enumerate(self.features):
            values = layer(values)
            if index in (1, 3, 8, 12):
                maps.append(values)
        spatial = self.lateral[3](maps[3])
        for block, index in zip(self.refine, (2, 1, 0)):
            spatial = block(F.interpolate(spatial, size=maps[index].shape[-2:], mode="bilinear", align_corners=False)
                            + self.lateral[index](maps[index]))
        if spatial.shape[-2:] != (HEATMAP_SIZE, HEATMAP_SIZE):
            spatial = F.interpolate(spatial, size=(HEATMAP_SIZE, HEATMAP_SIZE), mode="bilinear", align_corners=False)
        corner_logits = self.corner_head(spatial).float()
        offsets = self.offset_head(spatial).float()
        mask_logits = self.mask_head(spatial).float()
        deep = F.adaptive_avg_pool2d(maps[-1], 1).flatten(1)
        decoded = F.adaptive_avg_pool2d(spatial, 1).flatten(1)
        mask_features = torch.cat((F.adaptive_avg_pool2d(mask_logits, 1).flatten(1),
                                   F.adaptive_max_pool2d(mask_logits, 1).flatten(1)), dim=1)
        return {"corner_logits": corner_logits, "offsets": offsets, "mask_logits": mask_logits,
                "orientation_logits": self.orientation_head(torch.cat((deep, decoded), dim=1)).float(),
                "presence_logits": self.presence_head(torch.cat((deep, decoded, mask_features), dim=1)).squeeze(1).float()}

    def forward(self, images: Tensor) -> tuple[Tensor, Tensor]:
        outputs = self.forward_geometry(images)
        corners, _ = decode_geometry(outputs)
        return corners.to(images.device), outputs["presence_logits"]


@dataclass(frozen=True)
class GeometryCandidate:
    corners: list[list[float]]
    corner_scores: list[float]
    score: float
    mask_iou: float


def _screen_clockwise(points: np.ndarray) -> np.ndarray:
    center = points.mean(axis=0)
    order = np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))
    ordered = points[order]
    anchor = int(np.lexsort((ordered[:, 0], ordered[:, 1]))[0])
    return np.roll(ordered, -anchor, axis=0)


def readable_orientation_class(points: np.ndarray) -> int:
    """Index of printed TopLeft in the deterministic screen-clockwise order."""
    center = points.mean(axis=0)
    order = np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))
    ordered = points[order]
    anchor = int(np.lexsort((ordered[:, 0], ordered[:, 1]))[0])
    order = np.roll(order, -anchor)
    return int(np.where(order == 0)[0][0])


def _valid_quad(points: np.ndarray) -> bool:
    if points.shape != (4, 2) or not np.isfinite(points).all() or np.any(points < 0) or np.any(points > 1):
        return False
    ordered = _screen_clockwise(points)
    edges = np.roll(ordered, -1, axis=0) - ordered
    crosses = np.cross(edges, np.roll(edges, -1, axis=0))
    area = abs(np.dot(ordered[:, 0], np.roll(ordered[:, 1], -1))
               - np.dot(ordered[:, 1], np.roll(ordered[:, 0], -1))) / 2
    return bool(area >= MINIMUM_QUAD_AREA and (np.all(crosses > 1e-8) or np.all(crosses < -1e-8)))


def _polygon_mask(points: np.ndarray, width: int, height: int) -> np.ndarray:
    mask = Image.new("1", (width, height))
    ImageDraw.Draw(mask).polygon([(float(x * (width - 1)), float(y * (height - 1))) for x, y in points], fill=1)
    return np.asarray(mask, dtype=bool)


def _decode_one(corner_logits: Tensor, offsets: Tensor, mask_logits: Tensor,
                orientation_logits: Tensor) -> tuple[list[float], dict[str, Any]]:
    probability = corner_logits.sigmoid()[0]
    pooled = F.max_pool2d(probability[None, None], 5, stride=1, padding=2)[0, 0]
    suppressed = torch.where(probability == pooled, probability, torch.zeros_like(probability))
    # NMS normally leaves isolated maxima, but equal-valued plateaus can retain
    # adjacent cells. Inspect extra maxima and enforce distinct peaks explicitly
    # so a plateau cannot consume the eight-corner candidate budget.
    scores, indices = torch.topk(suppressed.flatten(), min(TOP_K_CORNERS * 4, suppressed.numel()))
    height, width = probability.shape
    peaks = []
    for score, index in zip(scores.cpu().tolist(), indices.cpu().tolist()):
        if score < MINIMUM_CORNER_PEAK:
            continue
        y, x = divmod(index, width)
        if any(max(abs(x - peak_x), abs(y - peak_y)) <= 2 for _, _, peak_x, peak_y in peaks):
            continue
        offset = offsets[:, y, x].detach().clamp(-.5, .5).cpu().tolist()
        peaks.append(([float((x + offset[0]) / (width - 1)), float((y + offset[1]) / (height - 1))],
                      float(score), x, y))
        if len(peaks) == TOP_K_CORNERS:
            break
    binary_mask = mask_logits.sigmoid()[0].detach().cpu().numpy() >= MASK_THRESHOLD
    candidates: list[GeometryCandidate] = []
    for combination in itertools.combinations(peaks, 4):
        points = _screen_clockwise(np.asarray([item[0] for item in combination], dtype=np.float64))
        if not _valid_quad(points):
            continue
        polygon = _polygon_mask(points, width, height)
        union = np.logical_or(binary_mask, polygon).sum()
        iou = float(np.logical_and(binary_mask, polygon).sum() / union) if union else 0.
        confidences = [item[1] for item in combination]
        score = float(np.mean(np.log(np.maximum(confidences, 1e-8))) + 2 * iou)
        candidates.append(GeometryCandidate(points.tolist(), confidences, score, iou))
    candidates.sort(key=lambda item: item.score, reverse=True)
    orientation = int(orientation_logits.argmax().cpu())
    if candidates:
        selected = candidates[0]
        semantic = selected.corners[orientation:] + selected.corners[:orientation]
        flat = [coordinate for point in semantic for coordinate in point]
        margin = selected.score - candidates[1].score if len(candidates) > 1 else 1e9
        valid = True
    else:
        flat, margin, valid = [0.] * 8, -1e9, False
        selected = GeometryCandidate([], [], -1e9, 0.)
    details = {"geometry_valid": valid, "detected_peaks": len(peaks), "candidate_count": len(candidates),
               "candidate_score": selected.score, "ambiguity_margin": margin, "mask_iou": selected.mask_iou,
               "corner_scores": selected.corner_scores, "peak_points": [point for point, _, _, _ in peaks],
               "orientation_class": orientation,
               "orientation_probability": float(orientation_logits.softmax(0)[orientation].cpu())}
    return flat, details


def decode_geometry(outputs: dict[str, Tensor]) -> tuple[Tensor, list[dict[str, Any]]]:
    corners, diagnostics = [], []
    for values in zip(outputs["corner_logits"], outputs["offsets"], outputs["mask_logits"], outputs["orientation_logits"]):
        decoded, details = _decode_one(*values)
        corners.append(decoded)
        diagnostics.append(details)
    return torch.tensor(corners, dtype=torch.float32), diagnostics


def _orientation_targets(corners: Tensor) -> Tensor:
    targets = []
    for points in corners.detach().cpu().reshape(-1, 4, 2).numpy():
        targets.append(readable_orientation_class(points))
    return torch.tensor(targets, dtype=torch.long, device=corners.device)


def _geometry_targets(corners: Tensor, presence: Tensor, height: int, width: int) -> dict[str, Tensor]:
    batch = corners.shape[0]
    points = corners.reshape(batch, 4, 2).float()
    positive = presence > .5
    heatmaps = torch.zeros((batch, 1, height, width), device=corners.device)
    offsets = torch.zeros((batch, 4, 2), device=corners.device)
    cells = torch.zeros((batch, 4, 2), dtype=torch.long, device=corners.device)
    masks = torch.zeros((batch, 1, height, width), device=corners.device)
    orientations = torch.zeros(batch, dtype=torch.long, device=corners.device)
    if positive.any():
        actual = points[positive]
        scaled = actual * torch.tensor([width - 1, height - 1], device=corners.device)
        rounded = scaled.round()
        cells[positive] = rounded.long()
        offsets[positive] = scaled - rounded
        yy, xx = torch.meshgrid(torch.arange(height, device=corners.device),
                                torch.arange(width, device=corners.device), indexing="ij")
        distance = ((xx[None, None] - rounded[..., 0, None, None]) ** 2
                    + (yy[None, None] - rounded[..., 1, None, None]) ** 2)
        heatmaps[positive, 0] = torch.exp(-distance / (2 * 1.5 ** 2)).amax(1)
        grid = torch.stack((xx / max(1, width - 1), yy / max(1, height - 1)), dim=-1)
        edges = torch.roll(actual, -1, dims=1) - actual
        relative = grid[None, None] - actual[:, :, None, None]
        cross = edges[..., 0, None, None] * relative[..., 1] - edges[..., 1, None, None] * relative[..., 0]
        masks[positive, 0] = (torch.all(cross >= -1e-6, dim=1) | torch.all(cross <= 1e-6, dim=1)).float()
        orientations[positive] = _orientation_targets(actual)
    return {"corner_heatmaps": heatmaps, "offsets": offsets, "cells": cells,
            "masks": masks, "orientations": orientations, "positive": positive}


def geometry_loss(outputs: dict[str, Tensor], corners: Tensor, presence: Tensor) -> tuple[Tensor, dict[str, Tensor]]:
    height, width = outputs["corner_logits"].shape[-2:]
    targets = _geometry_targets(corners, presence, height, width)
    predicted = outputs["corner_logits"].sigmoid().clamp(1e-6, 1 - 1e-6)
    target_heatmaps = targets["corner_heatmaps"]
    positive_pixels = target_heatmaps.eq(1)
    negative_pixels = ~positive_pixels
    positive_term = -torch.log(predicted) * (1 - predicted).pow(2) * positive_pixels
    negative_term = -torch.log(1 - predicted) * predicted.pow(2) * (1 - target_heatmaps).pow(4) * negative_pixels
    corner_focal = (positive_term.sum() / positive_pixels.sum().clamp_min(1)
                    + negative_term.sum() / negative_pixels.sum().clamp_min(1))
    zero = outputs["offsets"].sum() * 0
    offset_loss = orientation_loss = zero
    positive = targets["positive"]
    if positive.any():
        sample_indices = torch.arange(corners.shape[0], device=corners.device)[:, None].expand(-1, 4)[positive]
        cells = targets["cells"][positive]
        sampled_offsets = outputs["offsets"][sample_indices, :, cells[..., 1], cells[..., 0]]
        offset_loss = F.smooth_l1_loss(sampled_offsets, targets["offsets"][positive], beta=1 / 9)
        orientation_loss = F.cross_entropy(outputs["orientation_logits"][positive], targets["orientations"][positive])
    mask_bce = F.binary_cross_entropy_with_logits(outputs["mask_logits"], targets["masks"])
    mask_probability = outputs["mask_logits"].sigmoid()
    intersection = (mask_probability * targets["masks"]).sum((1, 2, 3))
    mask_dice = (1 - (2 * intersection + 1) /
                 (mask_probability.sum((1, 2, 3)) + targets["masks"].sum((1, 2, 3)) + 1)).mean()
    per_sample = F.binary_cross_entropy_with_logits(outputs["presence_logits"], presence.float(), reduction="none")
    class_terms = [per_sample[mask].mean() for mask in (positive, ~positive) if mask.any()]
    presence_loss = torch.stack(class_terms).mean()
    total = 2 * corner_focal + offset_loss + mask_bce + mask_dice + .5 * orientation_loss + presence_loss
    return total, {"corner_focal_loss": corner_focal, "offset_loss": offset_loss,
                   "mask_bce_loss": mask_bce, "mask_dice_loss": mask_dice,
                   "orientation_loss": orientation_loss, "presence_loss": presence_loss}

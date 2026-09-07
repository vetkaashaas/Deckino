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

ARCHITECTURE = "mobilenetv3-small-card-geometry-v4"
RECIPE7_ARCHITECTURE = "mobilenetv3-small-card-geometry-v3"
RECIPE6_ARCHITECTURE = "mobilenetv3-small-card-geometry-v2"
RECIPE4_ARCHITECTURE = "mobilenetv3-small-card-geometry-v1"
PREVIOUS_SPATIAL_ARCHITECTURE = "mobilenetv3-small-spatial-v2"
TRAINING_RECIPE = 8
INPUT_SIZE = 320
HEATMAP_SIZE = 80
DECODER_CHANNELS = 48
TOP_K_CORNERS = 8
MINIMUM_CORNER_PEAK = .05
MINIMUM_QUAD_AREA = .0025
MASK_THRESHOLD = .5
EMA_DECAY = .999
CORNER_ANCHOR_POLICY = "screen-top-left-v2"
LEGACY_CORNER_ANCHOR_POLICY = "screen-topmost-v1"


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


class Recipe4CardExtractor(nn.Module):
    """Read-only recipe-4 architecture retained for previews and comparisons."""
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

    def train(self, mode: bool = True) -> Recipe4CardExtractor:
        super().train(mode)
        for layer in self.features.modules():
            if isinstance(layer, nn.BatchNorm2d):
                layer.eval()
        return self

    def set_backbone_trainable(self, enabled: bool) -> None:
        for parameter in self.features.parameters():
            parameter.requires_grad_(enabled)

    def _decode_features(self, images: Tensor) -> tuple[list[Tensor], Tensor]:
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
        return maps, spatial

    def _geometry_outputs(self, maps: list[Tensor], spatial: Tensor) -> dict[str, Tensor]:
        corner_logits = self.corner_head(spatial).float()
        offsets = self.offset_head(spatial).float()
        mask_logits = self.mask_head(spatial).float()
        deep = F.adaptive_avg_pool2d(maps[-1], 1).flatten(1)
        decoded = F.adaptive_avg_pool2d(spatial, 1).flatten(1)
        mask_features = torch.cat((F.adaptive_avg_pool2d(mask_logits, 1).flatten(1),
                                   F.adaptive_max_pool2d(mask_logits, 1).flatten(1)), dim=1)
        return {"corner_logits": corner_logits, "offsets": offsets, "mask_logits": mask_logits,
                "orientation_logits": self.orientation_head(self._orientation_features(maps, spatial)).float(),
                "presence_logits": self.presence_head(torch.cat((deep, decoded, mask_features), dim=1)).squeeze(1).float()}

    def _orientation_features(self, maps: list[Tensor], spatial: Tensor) -> Tensor:
        return torch.cat((F.adaptive_avg_pool2d(maps[-1], 1).flatten(1),
                          F.adaptive_avg_pool2d(spatial, 1).flatten(1)), dim=1)

    def forward_geometry(self, images: Tensor) -> dict[str, Tensor]:
        maps, spatial = self._decode_features(images)
        return self._geometry_outputs(maps, spatial)

    def forward(self, images: Tensor) -> tuple[Tensor, Tensor]:
        outputs = self.forward_geometry(images)
        corners, _ = decode_geometry(outputs, LEGACY_CORNER_ANCHOR_POLICY)
        return corners.to(images.device), outputs["presence_logits"]


class Recipe6CardExtractor(Recipe4CardExtractor):
    """Recipe-6 extractor retained for preview and baseline compatibility."""
    def __init__(self, pretrained: bool = False) -> None:
        super().__init__(pretrained)
        self.semantic_corner_head = nn.Conv2d(DECODER_CHANNELS, 4, 1)
        nn.init.constant_(self.semantic_corner_head.bias, -2.19)

    def forward_geometry(self, images: Tensor) -> dict[str, Tensor]:
        maps, spatial = self._decode_features(images)
        outputs = self._geometry_outputs(maps, spatial)
        outputs["semantic_corner_logits"] = self.semantic_corner_head(spatial).float()
        return outputs


class Recipe7CardExtractor(Recipe6CardExtractor):
    """Recipe-7 extractor with spatially aware readable-orientation features."""
    def __init__(self, pretrained: bool = False) -> None:
        super().__init__(pretrained)
        # Global average pooling erased the very layout needed to distinguish
        # 90/180-degree readable order. A 2x2 grid adds only ~0.24M net parameters
        # while preserving coarse artwork/text placement for the orientation vote.
        orientation_features = (576 + DECODER_CHANNELS) * 4
        self.orientation_head = nn.Sequential(nn.Linear(orientation_features, 128), nn.Hardswish(),
                                              nn.Dropout(.15), nn.Linear(128, 4))

    def _orientation_features(self, maps: list[Tensor], spatial: Tensor) -> Tensor:
        return torch.cat((F.adaptive_avg_pool2d(maps[-1], 2).flatten(1),
                          F.adaptive_avg_pool2d(spatial, 2).flatten(1)), dim=1)


class CardExtractor(Recipe7CardExtractor):
    """Recipe-8 extractor with stable screen-top-left corner anchoring."""
    def forward(self, images: Tensor) -> tuple[Tensor, Tensor]:
        outputs = self.forward_geometry(images)
        corners, _ = decode_geometry(outputs, CORNER_ANCHOR_POLICY)
        return corners.to(images.device), outputs["presence_logits"]


@dataclass(frozen=True)
class GeometryCandidate:
    corners: list[list[float]]
    corner_scores: list[float]
    peak_cells: list[tuple[int, int]]
    score: float
    mask_iou: float


def corner_anchor_policy_for_config(config: dict[str, Any]) -> str:
    """Resolve decoder semantics while keeping pre-recipe-8 checkpoints readable."""
    configured = config.get("corner_anchor_policy")
    if configured is not None:
        return str(configured)
    return CORNER_ANCHOR_POLICY if config.get("architecture") == ARCHITECTURE else LEGACY_CORNER_ANCHOR_POLICY


def _screen_clockwise(points: np.ndarray, corner_anchor_policy: str = CORNER_ANCHOR_POLICY) -> np.ndarray:
    return points[_screen_clockwise_indices(points, corner_anchor_policy)]


def _screen_clockwise_indices(points: np.ndarray, corner_anchor_policy: str = CORNER_ANCHOR_POLICY) -> np.ndarray:
    center = points.mean(axis=0)
    order = np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))
    ordered = points[order]
    if corner_anchor_policy == CORNER_ANCHOR_POLICY:
        # Anchor the cyclic order to the screen's top-left corner. Unlike the
        # old topmost-vertex rule, this does not change class when a nearly
        # upright card's top edge crosses a one-pixel horizontal tilt.
        anchor = int(np.lexsort((ordered[:, 0], ordered[:, 1], ordered[:, 0] + ordered[:, 1]))[0])
    elif corner_anchor_policy == LEGACY_CORNER_ANCHOR_POLICY:
        anchor = int(np.lexsort((ordered[:, 0], ordered[:, 1]))[0])
    else:
        raise ValueError(f"Unsupported corner anchor policy: {corner_anchor_policy}")
    return np.roll(order, -anchor)


def readable_orientation_class(points: np.ndarray, corner_anchor_policy: str = CORNER_ANCHOR_POLICY) -> int:
    """Index of printed TopLeft in the deterministic screen-clockwise order."""
    order = _screen_clockwise_indices(points, corner_anchor_policy)
    return int(np.where(order == 0)[0][0])


def _valid_quad(points: np.ndarray) -> bool:
    if points.shape != (4, 2) or not np.isfinite(points).all() or np.any(points < 0) or np.any(points > 1):
        return False
    ordered = _screen_clockwise(points)
    edges = np.roll(ordered, -1, axis=0) - ordered
    following = np.roll(edges, -1, axis=0)
    crosses = edges[:, 0] * following[:, 1] - edges[:, 1] * following[:, 0]
    area = abs(np.dot(ordered[:, 0], np.roll(ordered[:, 1], -1))
               - np.dot(ordered[:, 1], np.roll(ordered[:, 0], -1))) / 2
    return bool(area >= MINIMUM_QUAD_AREA and (np.all(crosses > 1e-8) or np.all(crosses < -1e-8)))


def _polygon_mask(points: np.ndarray, width: int, height: int) -> np.ndarray:
    mask = Image.new("1", (width, height))
    ImageDraw.Draw(mask).polygon([(float(x * (width - 1)), float(y * (height - 1))) for x, y in points], fill=1)
    return np.asarray(mask, dtype=bool)


def _decode_one(corner_logits: Tensor, offsets: Tensor, mask_logits: Tensor,
                orientation_logits: Tensor, semantic_corner_logits: Tensor | None = None,
                corner_anchor_policy: str = CORNER_ANCHOR_POLICY,
                ) -> tuple[list[float], dict[str, Any]]:
    generic_probability = corner_logits.sigmoid()[0]
    semantic_probability = semantic_corner_logits.sigmoid() if semantic_corner_logits is not None else None
    # The generic map remains the geometry anchor. Semantic maps may rescue a
    # corner which the generic head ranked just outside its small candidate set.
    probability = (torch.maximum(generic_probability, semantic_probability.amax(0))
                   if semantic_probability is not None else generic_probability)
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
        peaks.append(([float(np.clip((x + offset[0]) / (width - 1), 0., 1.)),
                       float(np.clip((y + offset[1]) / (height - 1), 0., 1.))],
                      float(score), x, y))
        if len(peaks) == TOP_K_CORNERS:
            break
    binary_mask = mask_logits.sigmoid()[0].detach().cpu().numpy() >= MASK_THRESHOLD
    candidates: list[GeometryCandidate] = []
    for combination in itertools.combinations(peaks, 4):
        unordered = np.asarray([item[0] for item in combination], dtype=np.float64)
        order = _screen_clockwise_indices(unordered, corner_anchor_policy)
        points = unordered[order]
        if not _valid_quad(points):
            continue
        polygon = _polygon_mask(points, width, height)
        union = np.logical_or(binary_mask, polygon).sum()
        iou = float(np.logical_and(binary_mask, polygon).sum() / union) if union else 0.
        confidences = [combination[index][1] for index in order]
        cells = [(combination[index][2], combination[index][3]) for index in order]
        score = float(np.mean(np.log(np.maximum(confidences, 1e-8))) + 2 * iou)
        candidates.append(GeometryCandidate(points.tolist(), confidences, cells, score, iou))
    candidates.sort(key=lambda item: item.score, reverse=True)
    orientation_scores = orientation_logits.detach().float().log_softmax(0).cpu()
    global_orientation = int(orientation_scores.argmax())
    semantic_margin = 1e9
    semantic_corner_scores = None
    if candidates:
        selected = candidates[0]
        if semantic_corner_logits is not None:
            role_log_probabilities = semantic_corner_logits.detach().float().log_softmax(0).cpu()
            semantic_scores = []
            for orientation in range(4):
                local = [role_log_probabilities[(index - orientation) % 4, y, x]
                         for index, (x, y) in enumerate(selected.peak_cells)]
                # The dense semantic head carries most of the readable-order
                # decision. The independent global classifier remains a useful
                # low-cost vote when a corner is obscured or glare-heavy.
                semantic_scores.append(torch.stack(local).mean() + .5 * orientation_scores[orientation])
            semantic_scores = torch.stack(semantic_scores)
            orientation = int(semantic_scores.argmax())
            ranked = semantic_scores.sort(descending=True).values
            semantic_margin = float(ranked[0] - ranked[1])
            orientation_probability = float(semantic_scores.softmax(0)[orientation])
            role_probability = semantic_corner_logits.detach().float().softmax(0).cpu()
            semantic_corner_scores = [float(role_probability[(index - orientation) % 4, y, x])
                                      for index, (x, y) in enumerate(selected.peak_cells)]
        else:
            orientation = global_orientation
            orientation_probability = float(orientation_scores.softmax(0)[orientation])
        semantic = selected.corners[orientation:] + selected.corners[:orientation]
        flat = [coordinate for point in semantic for coordinate in point]
        geometry_margin = selected.score - candidates[1].score if len(candidates) > 1 else 1e9
        margin = min(geometry_margin, semantic_margin)
        valid = True
    else:
        flat, margin, geometry_margin, valid = [0.] * 8, -1e9, -1e9, False
        orientation, orientation_probability = global_orientation, float(orientation_scores.softmax(0)[global_orientation])
        selected = GeometryCandidate([], [], [], -1e9, 0.)
    details = {"geometry_valid": valid, "detected_peaks": len(peaks), "candidate_count": len(candidates),
               "candidate_score": selected.score, "ambiguity_margin": margin,
               "geometry_ambiguity_margin": geometry_margin, "semantic_ambiguity_margin": semantic_margin,
               "mask_iou": selected.mask_iou,
               "corner_scores": selected.corner_scores, "peak_points": [point for point, _, _, _ in peaks],
               "orientation_class": orientation,
               "orientation_probability": orientation_probability,
               "global_orientation_class": global_orientation,
               "global_orientation_probability": float(orientation_scores.softmax(0)[global_orientation]),
               "semantic_corner_scores": semantic_corner_scores}
    return flat, details


def decode_geometry(outputs: dict[str, Tensor], corner_anchor_policy: str = CORNER_ANCHOR_POLICY
                    ) -> tuple[Tensor, list[dict[str, Any]]]:
    corners, diagnostics = [], []
    semantic = outputs.get("semantic_corner_logits")
    semantic_values = semantic if semantic is not None else itertools.repeat(None)
    for values in zip(outputs["corner_logits"], outputs["offsets"], outputs["mask_logits"],
                      outputs["orientation_logits"], semantic_values):
        decoded, details = _decode_one(*values, corner_anchor_policy=corner_anchor_policy)
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
    semantic_heatmaps = torch.zeros((batch, 4, height, width), device=corners.device)
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
        gaussian = torch.exp(-distance / (2 * 1.5 ** 2))
        heatmaps[positive, 0] = gaussian.amax(1)
        semantic_heatmaps[positive] = gaussian
        grid = torch.stack((xx / max(1, width - 1), yy / max(1, height - 1)), dim=-1)
        edges = torch.roll(actual, -1, dims=1) - actual
        relative = grid[None, None] - actual[:, :, None, None]
        cross = edges[..., 0, None, None] * relative[..., 1] - edges[..., 1, None, None] * relative[..., 0]
        masks[positive, 0] = (torch.all(cross >= -1e-6, dim=1) | torch.all(cross <= 1e-6, dim=1)).float()
        orientations[positive] = _orientation_targets(actual)
    return {"corner_heatmaps": heatmaps, "semantic_corner_heatmaps": semantic_heatmaps,
            "offsets": offsets, "cells": cells,
            "masks": masks, "orientations": orientations, "positive": positive}


def _modified_focal_loss(logits: Tensor, targets: Tensor) -> Tensor:
    predicted = logits.sigmoid().clamp(1e-6, 1 - 1e-6)
    positive_pixels = targets.eq(1)
    negative_pixels = ~positive_pixels
    positive_term = -torch.log(predicted) * (1 - predicted).pow(2) * positive_pixels
    negative_term = -torch.log(1 - predicted) * predicted.pow(2) * (1 - targets).pow(4) * negative_pixels
    # CenterNet normalizes the complete negative field by the number of target
    # peaks. Averaging the background pixels independently made false corner
    # peaks almost free, especially on negative photos. Per-sample normalization
    # also keeps true no-card examples bounded when they contain no peaks.
    dimensions = tuple(range(1, logits.ndim))
    peak_counts = positive_pixels.sum(dimensions).clamp_min(1)
    return ((positive_term.sum(dimensions) + negative_term.sum(dimensions)) / peak_counts).mean()


def geometry_loss(outputs: dict[str, Tensor], corners: Tensor, presence: Tensor) -> tuple[Tensor, dict[str, Tensor]]:
    height, width = outputs["corner_logits"].shape[-2:]
    targets = _geometry_targets(corners, presence, height, width)
    corner_focal = _modified_focal_loss(outputs["corner_logits"], targets["corner_heatmaps"])
    zero = outputs["offsets"].sum() * 0
    semantic_corner_focal = (_modified_focal_loss(outputs["semantic_corner_logits"],
                                                   targets["semantic_corner_heatmaps"])
                             if "semantic_corner_logits" in outputs else zero)
    offset_loss = orientation_loss = semantic_role_loss = zero
    positive = targets["positive"]
    if positive.any():
        sample_indices = torch.arange(corners.shape[0], device=corners.device)[:, None].expand(-1, 4)[positive]
        cells = targets["cells"][positive]
        sampled_offsets = outputs["offsets"][sample_indices, :, cells[..., 1], cells[..., 0]]
        offset_loss = F.smooth_l1_loss(sampled_offsets, targets["offsets"][positive], beta=1 / 9)
        orientation_loss = F.cross_entropy(outputs["orientation_logits"][positive],
                                           targets["orientations"][positive], label_smoothing=.05)
        if "semantic_corner_logits" in outputs:
            semantic_logits = outputs["semantic_corner_logits"][sample_indices, :, cells[..., 1], cells[..., 0]]
            semantic_roles = torch.arange(4, device=corners.device)[None].expand(cells.shape[0], -1)
            semantic_role_loss = F.cross_entropy(semantic_logits.reshape(-1, 4), semantic_roles.reshape(-1))
    mask_bce = F.binary_cross_entropy_with_logits(outputs["mask_logits"], targets["masks"])
    mask_probability = outputs["mask_logits"].sigmoid()
    intersection = (mask_probability * targets["masks"]).sum((1, 2, 3))
    mask_dice = (1 - (2 * intersection + 1) /
                 (mask_probability.sum((1, 2, 3)) + targets["masks"].sum((1, 2, 3)) + 1)).mean()
    per_sample = F.binary_cross_entropy_with_logits(outputs["presence_logits"], presence.float(), reduction="none")
    class_terms = [per_sample[mask].mean() for mask in (positive, ~positive) if mask.any()]
    presence_loss = torch.stack(class_terms).mean()
    total = (2 * corner_focal + semantic_corner_focal + .75 * semantic_role_loss + offset_loss
             + mask_bce + mask_dice + orientation_loss + presence_loss)
    return total, {"corner_focal_loss": corner_focal, "semantic_corner_focal_loss": semantic_corner_focal,
                   "semantic_role_loss": semantic_role_loss, "offset_loss": offset_loss,
                   "mask_bce_loss": mask_bce, "mask_dice_loss": mask_dice,
                   "orientation_loss": orientation_loss, "presence_loss": presence_loss}

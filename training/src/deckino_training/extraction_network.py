"""MobileNet spatial keypoints; independent of artwork embeddings."""
from __future__ import annotations

import torch
from torch import Tensor, nn
from torch.nn import functional as F
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

ARCHITECTURE = "mobilenetv3-small-spatial-v2"
TRAINING_RECIPE = 3
INPUT_SIZE = 256


class SpatialRefinement(nn.Sequential):
    def __init__(self) -> None:
        super().__init__(nn.Conv2d(32, 32, 3, padding=1, groups=32, bias=False),
                         nn.Conv2d(32, 32, 1, bias=False), nn.GroupNorm(8, 32), nn.Hardswish())


class CardExtractor(nn.Module):
    def __init__(self, pretrained: bool = False) -> None:
        super().__init__()
        network = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT if pretrained else None)
        self.features = network.features
        self.lateral = nn.ModuleList(nn.Conv2d(channels, 32, 1) for channels in (16, 24, 48, 576))
        self.refine = nn.ModuleList(SpatialRefinement() for _ in range(3))
        self.corner_head = nn.Conv2d(32, 4, 1)
        self.presence_head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(),
                                           nn.Linear(576, 128), nn.Hardswish(), nn.Linear(128, 1))
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

    def forward_with_heatmaps(self, images: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        maps = []
        values = images
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
        corners = torch.stack((x, y), dim=-1).flatten(1)
        return corners, self.presence_head(maps[-1]).squeeze(1).float(), logits

    def forward(self, images: Tensor) -> tuple[Tensor, Tensor]:
        corners, presence, _ = self.forward_with_heatmaps(images)
        return corners, presence


def spatial_loss(corners: Tensor, presence_logits: Tensor, heatmaps: Tensor,
                 targets: Tensor, presence: Tensor) -> tuple[Tensor, dict[str, Tensor]]:
    positive = presence > 0.5
    coordinate = corners.sum() * 0
    mean_corner = coordinate
    worst_corner = coordinate
    heatmap_loss = heatmaps.sum() * 0
    if positive.any():
        actual = targets[positive].reshape(-1, 4, 2).float()
        predicted = corners[positive].reshape(-1, 4, 2).float()
        diagonal = torch.linalg.vector_norm(actual[:, 0] - actual[:, 2], dim=-1).clamp_min(1e-4)
        per_corner = F.smooth_l1_loss((predicted - actual) / diagonal[:, None, None],
                                      torch.zeros_like(actual), beta=0.02, reduction="none").mean(-1)
        mean_corner = per_corner.mean(-1).mean()
        worst_corner = per_corner.max(-1).values.mean()
        coordinate = .5 * mean_corner + .5 * worst_corner
        height, width = heatmaps.shape[-2:]
        yy, xx = torch.meshgrid(torch.arange(height, device=heatmaps.device),
                                torch.arange(width, device=heatmaps.device), indexing="ij")
        distance = ((xx - actual[..., 0, None, None] * (width - 1)) ** 2
                    + (yy - actual[..., 1, None, None] * (height - 1)) ** 2)
        gaussian = (-distance / (2 * 1.5 ** 2)).flatten(2).softmax(-1)
        heatmap_loss = F.kl_div(heatmaps[positive].flatten(2).log_softmax(-1), gaussian,
                               reduction="none").sum(-1).mean()
    per_sample = F.binary_cross_entropy_with_logits(presence_logits.float(), presence.float(), reduction="none")
    terms = [per_sample[mask].mean() for mask in (positive, ~positive) if mask.any()]
    classification = torch.stack(terms).mean()
    total = heatmap_loss + 10 * coordinate + classification
    return total, {"heatmap_loss": heatmap_loss, "corner_loss": coordinate,
                   "mean_corner_loss": mean_corner, "worst_corner_loss": worst_corner,
                   "presence_loss": classification}

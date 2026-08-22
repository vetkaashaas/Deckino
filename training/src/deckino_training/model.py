from __future__ import annotations

import hashlib
import math
import random
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import torch
from PIL import Image
from torch import Tensor, nn
from torch.nn import functional as F
from torch.utils.data import Dataset
from torchvision import transforms
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

from .manifest import ManifestRecord

IMAGE_SIZE = 224
NORMALIZE_MEAN = (0.485, 0.456, 0.406)
NORMALIZE_STD = (0.229, 0.224, 0.225)


class RandomGlare:
    """Adds a bright translucent band that approximates glare and foil sheen."""

    def __init__(self, probability: float = 0.35) -> None:
        self.probability = probability

    def __call__(self, image: Tensor) -> Tensor:
        if torch.rand(()) >= self.probability:
            return image
        _, height, width = image.shape
        band_width = max(1, int(width * float(torch.empty(()).uniform_(0.06, 0.22))))
        start = int(torch.randint(-band_width, width, ()).item())
        end = min(width, start + band_width)
        start = max(0, start)
        if end <= start:
            return image
        alpha = float(torch.empty(()).uniform_(0.12, 0.38))
        result = image.clone()
        result[:, :, start:end] = result[:, :, start:end].lerp(
            torch.ones_like(result[:, :, start:end]), alpha
        )
        return result


def build_train_transform() -> Callable[[Image.Image], Tensor]:
    return transforms.Compose(
        [
            transforms.RandomResizedCrop(IMAGE_SIZE, scale=(0.72, 1.0), ratio=(0.78, 1.28)),
            transforms.RandomPerspective(distortion_scale=0.28, p=0.65),
            transforms.RandomRotation(7),
            transforms.RandomApply(
                [transforms.ColorJitter(brightness=0.35, contrast=0.3, saturation=0.25, hue=0.03)],
                p=0.8,
            ),
            transforms.RandomApply([transforms.GaussianBlur(5, sigma=(0.1, 1.8))], p=0.3),
            transforms.ToTensor(),
            RandomGlare(),
            transforms.RandomErasing(p=0.12, scale=(0.01, 0.08), ratio=(0.2, 4.0), value="random"),
            transforms.Normalize(NORMALIZE_MEAN, NORMALIZE_STD),
        ]
    )


def build_evaluation_transform(simulated_camera: bool = True) -> Callable[[Image.Image], Tensor]:
    operations: list[Callable] = [transforms.Resize(256), transforms.CenterCrop(IMAGE_SIZE)]
    if simulated_camera:
        operations.extend(
            [
                transforms.RandomPerspective(distortion_scale=0.12, p=1.0),
                transforms.ColorJitter(brightness=0.12, contrast=0.12, saturation=0.08),
                transforms.RandomApply([transforms.GaussianBlur(3, sigma=(0.1, 0.7))], p=0.25),
            ]
        )
    operations.extend([transforms.ToTensor(), transforms.Normalize(NORMALIZE_MEAN, NORMALIZE_STD)])
    return transforms.Compose(operations)


def crop_card_art(image: Image.Image, input_kind: str) -> Image.Image:
    """Extract the conventional art box from an aligned full-card image."""
    if input_kind not in {"auto", "card", "art"}:
        raise ValueError(f"Unsupported input kind: {input_kind}")
    is_full_card = input_kind == "card" or (
        input_kind == "auto" and image.height / max(1, image.width) >= 1.18
    )
    if not is_full_card:
        return image
    width, height = image.size
    return image.crop(
        (
            round(width * 0.08),
            round(height * 0.11),
            round(width * 0.92),
            round(height * 0.49),
        )
    )


class CardDataset(Dataset[tuple[Tensor, int, str]]):
    def __init__(
        self,
        root: Path,
        records: Sequence[ManifestRecord],
        label_to_index: dict[str, int],
        transform: Callable[[Image.Image], Tensor],
        deterministic: bool = False,
    ) -> None:
        self.root = root
        self.records = list(records)
        self.label_to_index = label_to_index
        self.transform = transform
        self.deterministic = deterministic

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> tuple[Tensor, int, str]:
        record = self.records[index]
        with Image.open(self.root / record.image_path) as source:
            image = source.convert("RGB")
        if self.deterministic:
            seed = int(hashlib.sha256(record.printing_id.encode("utf-8")).hexdigest()[:16], 16)
            python_state = random.getstate()
            try:
                random.seed(seed)
                with torch.random.fork_rng(devices=[]):
                    torch.manual_seed(seed)
                    tensor = self.transform(image)
            finally:
                random.setstate(python_state)
        else:
            tensor = self.transform(image)
        return tensor, self.label_to_index[record.oracle_id], record.printing_id


class EmbeddingNetwork(nn.Module):
    def __init__(self, embedding_dim: int = 512, pretrained: bool = False) -> None:
        super().__init__()
        weights = MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
        mobilenet = mobilenet_v3_small(weights=weights)
        self.features = mobilenet.features
        self.pool = mobilenet.avgpool
        self.embedding = nn.Sequential(
            nn.Linear(576, embedding_dim, bias=False),
            nn.BatchNorm1d(embedding_dim),
        )

    def forward(self, images: Tensor) -> Tensor:
        values = self.features(images)
        values = self.pool(values)
        values = torch.flatten(values, 1)
        return F.normalize(self.embedding(values), dim=1)


class ArcMarginProduct(nn.Module):
    def __init__(
        self,
        embedding_dim: int,
        class_count: int,
        scale: float = 30.0,
        margin: float = 0.35,
    ) -> None:
        super().__init__()
        self.scale = scale
        self.margin = margin
        self.weight = nn.Parameter(torch.empty(class_count, embedding_dim))
        nn.init.xavier_uniform_(self.weight)

    def forward(self, embeddings: Tensor, labels: Tensor) -> Tensor:
        cosine = F.linear(F.normalize(embeddings), F.normalize(self.weight)).clamp(-1 + 1e-7, 1 - 1e-7)
        sine = torch.sqrt((1.0 - cosine.square()).clamp_min(1e-7))
        phi = cosine * math.cos(self.margin) - sine * math.sin(self.margin)
        threshold = math.cos(math.pi - self.margin)
        phi = torch.where(cosine > threshold, phi, cosine - math.sin(math.pi - self.margin) * self.margin)
        one_hot = F.one_hot(labels, num_classes=self.weight.shape[0]).to(dtype=cosine.dtype)
        return (one_hot * phi + (1.0 - one_hot) * cosine) * self.scale

    def centers(self) -> Tensor:
        return F.normalize(self.weight.detach(), dim=1)


@dataclass(frozen=True)
class EvaluationResult:
    samples: int
    top1: float
    top5: float
    confusion_pairs: list[dict[str, int | str]]


@torch.inference_mode()
def evaluate_model(
    model: EmbeddingNetwork,
    head: ArcMarginProduct,
    loader: torch.utils.data.DataLoader,
    index_to_oracle: Sequence[str],
    device: torch.device,
) -> EvaluationResult:
    model.eval()
    centers = head.centers().to(device)
    correct1 = 0
    correct5 = 0
    samples = 0
    confusions: Counter[tuple[int, int]] = Counter()
    for images, labels, _printing_ids in loader:
        images = images.to(device)
        labels = labels.to(device)
        similarities = model(images) @ centers.T
        top_count = min(5, similarities.shape[1])
        predictions = similarities.topk(top_count, dim=1).indices
        correct1 += int((predictions[:, 0] == labels).sum().item())
        correct5 += int((predictions == labels.unsqueeze(1)).any(dim=1).sum().item())
        samples += labels.numel()
        for actual, predicted in zip(labels.tolist(), predictions[:, 0].tolist(), strict=True):
            if actual != predicted:
                confusions[(actual, predicted)] += 1
    pairs = [
        {
            "actual_oracle_id": index_to_oracle[actual],
            "predicted_oracle_id": index_to_oracle[predicted],
            "count": count,
        }
        for (actual, predicted), count in confusions.most_common(100)
    ]
    return EvaluationResult(
        samples=samples,
        top1=correct1 / samples if samples else 0.0,
        top5=correct5 / samples if samples else 0.0,
        confusion_pairs=pairs,
    )

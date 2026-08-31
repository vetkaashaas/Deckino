"""Label-preserving camera augmentation. No synthetic assets or identity model."""
from __future__ import annotations

import math
import random
from typing import Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


def project_points(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    homogeneous = np.column_stack((points, np.ones(len(points)))) @ matrix.T
    if np.any(homogeneous[:, 2] <= 1e-6):
        raise ValueError("Augmentation projects corners behind the camera")
    return homogeneous[:, :2] / homogeneous[:, 2:]


def transform_photo(image: Image.Image, corners: Sequence[dict[str, float]] | None,
                    matrix: np.ndarray) -> tuple[Image.Image, list[dict[str, float]] | None]:
    mapped = None
    if corners is not None:
        points = np.array([[point["x"] * (image.width - 1), point["y"] * (image.height - 1)] for point in corners])
        projected = project_points(matrix, points)
        normalized = projected / np.array([image.width - 1, image.height - 1])
        if not np.isfinite(normalized).all() or np.any(normalized < 0) or np.any(normalized > 1):
            raise ValueError("Augmentation would crop a positive card corner")
        mapped = [{"x": float(x), "y": float(y)} for x, y in normalized]
        # Share the inference geometry contract, including minimum usable area.
        from .extraction import _validate_quad
        _validate_quad(mapped)
    # A reflected one-image border supplies real local texture when the inverse
    # warp samples outside the source. Constant black wedges were an accidental
    # shortcut that never occurs in camera photographs.
    source = np.asarray(image.convert("RGB"))
    reflected = Image.fromarray(np.pad(source, ((image.height, image.height),
                                                (image.width, image.width), (0, 0)), mode="reflect"))
    inverse = np.array([[1, 0, image.width], [0, 1, image.height], [0, 0, 1.]]) @ np.linalg.inv(matrix)
    inverse /= inverse[2, 2]
    result = reflected.transform(image.size, Image.Transform.PERSPECTIVE, inverse.flatten()[:8],
                                 Image.Resampling.BICUBIC)
    return result, mapped


def augment_photo(image: Image.Image, corners: Sequence[dict[str, float]] | None,
                  rng: random.Random) -> tuple[Image.Image, Sequence[dict[str, float]] | None]:
    if rng.random() < 0.25:
        return image, corners
    image = image.copy()
    image.thumbnail((512, 512), Image.Resampling.BICUBIC)
    # Do not geometrically transform negatives: cropping could make an ambiguous
    # multi-card/occluded negative into a newly usable target without an annotation.
    if corners is not None:
        width, height = image.size
        center = np.array([[1, 0, -(width - 1) / 2], [0, 1, -(height - 1) / 2], [0, 0, 1.]])
        for _ in range(8):
            angle = math.radians(rng.uniform(-25, 25) if rng.random() < 0.5 else rng.uniform(-180, 180))
            scale = rng.uniform(0.8, 1.15)
            rotation = np.array([[scale * math.cos(angle), -scale * math.sin(angle), 0],
                                 [scale * math.sin(angle), scale * math.cos(angle), 0],
                                 [rng.uniform(-0.12, 0.12) / width, rng.uniform(-0.12, 0.12) / height, 1.]])
            position = np.array([[1, 0, (width - 1) / 2 + rng.uniform(-0.08, 0.08) * width],
                                 [0, 1, (height - 1) / 2 + rng.uniform(-0.08, 0.08) * height], [0, 0, 1.]])
            try:
                image, corners = transform_photo(image, corners, position @ rotation @ center)
                break
            except (ValueError, np.linalg.LinAlgError):
                continue
    image = ImageEnhance.Brightness(image).enhance(rng.uniform(0.8, 1.2))
    image = ImageEnhance.Contrast(image).enhance(rng.uniform(0.85, 1.15))
    pixels = np.asarray(image, dtype=np.float32).copy()
    pixels *= np.array([rng.uniform(0.92, 1.08), 1, rng.uniform(0.92, 1.08)])
    noise = np.random.default_rng(rng.randrange(2**32)).normal(0, rng.uniform(0, 3), pixels.shape)
    image = Image.fromarray(np.clip(pixels + noise, 0, 255).astype(np.uint8))
    if rng.random() < 0.25:
        image = image.filter(ImageFilter.GaussianBlur(rng.uniform(0.1, 0.65)))
    if rng.random() < 0.3:
        mask = Image.new("L", image.size)
        x, y = rng.randrange(image.width), rng.randrange(image.height)
        radius = max(12, min(image.size) // 3)
        ImageDraw.Draw(mask).ellipse((x - radius, y - radius, x + radius, y + radius), fill=rng.randint(20, 55))
        mask = mask.filter(ImageFilter.GaussianBlur(radius / 3))
        image = Image.composite(Image.new("RGB", image.size, rng.choice(("black", "white"))), image, mask)
    return image, corners

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


def _apply_camera_artifacts(image: Image.Image, rng: random.Random) -> Image.Image:
    """Apply bounded phone-camera degradation without changing corner labels."""
    image = ImageEnhance.Brightness(image).enhance(rng.uniform(0.7, 1.3))
    image = ImageEnhance.Contrast(image).enhance(rng.uniform(0.78, 1.28))
    image = ImageEnhance.Color(image).enhance(rng.uniform(0.78, 1.22))

    pixels = np.asarray(image, dtype=np.float32) / 255
    # Exposure gamma and independent red/blue gain approximate auto-exposure
    # and white-balance drift without inventing impossible channel colours.
    pixels = np.power(np.clip(pixels, 1e-5, 1), rng.uniform(0.78, 1.28))
    pixels *= np.array([rng.uniform(0.88, 1.12), 1, rng.uniform(0.88, 1.12)])
    noise = np.random.default_rng(rng.randrange(2**32)).normal(0, rng.uniform(0, 5) / 255, pixels.shape)
    image = Image.fromarray(np.clip((pixels + noise) * 255, 0, 255).astype(np.uint8))

    if rng.random() < 0.3:
        shadow = Image.new("L", image.size)
        draw = ImageDraw.Draw(shadow)
        if rng.random() < .5:
            x = rng.randint(-image.width // 2, image.width)
            draw.polygon(((x, 0), (x + rng.randint(20, max(21, image.width // 2)), 0),
                          (x + rng.randint(-image.width // 2, image.width // 2), image.height),
                          (x - image.width, image.height)), fill=rng.randint(45, 130))
        else:
            x, y = rng.randrange(image.width), rng.randrange(image.height)
            radius = max(12, min(image.size) // 2)
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=rng.randint(35, 105))
        shadow = shadow.filter(ImageFilter.GaussianBlur(max(4, min(image.size) / 18)))
        darkness = rng.uniform(.25, .65)
        image = Image.composite(ImageEnhance.Brightness(image).enhance(darkness), image, shadow)

    if rng.random() < 0.3:
        glare = Image.new("L", image.size)
        draw = ImageDraw.Draw(glare)
        x = rng.randint(-image.width // 3, image.width)
        width = rng.randint(max(8, image.width // 18), max(9, image.width // 4))
        skew = rng.randint(-image.width // 3, image.width // 3)
        draw.polygon(((x, 0), (x + width, 0), (x + width + skew, image.height),
                      (x + skew, image.height)), fill=rng.randint(25, 95))
        glare = glare.filter(ImageFilter.GaussianBlur(max(3, min(image.size) / 35)))
        image = Image.composite(Image.new("RGB", image.size, "white"), image, glare)

    if rng.random() < 0.3:
        factor = rng.uniform(.4, .82)
        reduced = (max(8, round(image.width * factor)), max(8, round(image.height * factor)))
        image = image.resize(reduced, Image.Resampling.BILINEAR).resize(image.size, Image.Resampling.BICUBIC)
    if rng.random() < 0.3:
        image = image.filter(ImageFilter.GaussianBlur(rng.uniform(0.15, 1.15)))
    if rng.random() < 0.15:
        horizontal = rng.random() < .5
        weights = [0.] * 25
        for offset in range(5):
            weights[2 * 5 + offset if horizontal else offset * 5 + 2] = .2
        image = image.filter(ImageFilter.Kernel((5, 5), weights, scale=1.))
    return image


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
            # Phone captures cluster near the four readable rotations. Sampling
            # those modes explicitly gives the semantic/global orientation heads
            # many more hard 90/180-degree examples than a purely uniform angle.
            angle_degrees = (rng.choice((0, 90, 180, 270)) + rng.uniform(-18, 18)
                             if rng.random() < .7 else rng.uniform(-180, 180))
            angle = math.radians(angle_degrees)
            scale = rng.uniform(0.72, 1.15)
            rotation = np.array([[scale * math.cos(angle), -scale * math.sin(angle), 0],
                                 [scale * math.sin(angle), scale * math.cos(angle), 0],
                                 [rng.uniform(-0.14, 0.14) / width, rng.uniform(-0.14, 0.14) / height, 1.]])
            position = np.array([[1, 0, (width - 1) / 2 + rng.uniform(-0.1, 0.1) * width],
                                 [0, 1, (height - 1) / 2 + rng.uniform(-0.1, 0.1) * height], [0, 0, 1.]])
            try:
                image, corners = transform_photo(image, corners, position @ rotation @ center)
                break
            except (ValueError, np.linalg.LinAlgError):
                continue
    return _apply_camera_artifacts(image, rng), corners

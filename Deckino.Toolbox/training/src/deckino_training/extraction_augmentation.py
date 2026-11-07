"""Label-preserving camera augmentation. No synthetic assets or identity model."""
from __future__ import annotations

import math
import random
from typing import Protocol, Sequence

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps


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


class Donors(Protocol):
    """Other training photographs an augmentation may borrow from."""

    def card(self, rng: random.Random) -> tuple[Image.Image, Sequence[dict[str, float]]] | None: ...

    def background(self, rng: random.Random) -> Image.Image | None: ...


def _pixels(corners: Sequence[dict[str, float]], size: tuple[int, int]) -> np.ndarray:
    return np.array([[point["x"] * (size[0] - 1), point["y"] * (size[1] - 1)] for point in corners])


def _quad_mask(points: np.ndarray, size: tuple[int, int]) -> Image.Image:
    mask = Image.new("L", size)
    ImageDraw.Draw(mask).polygon([tuple(point) for point in points], fill=255)
    return mask


def _diagonal(points: np.ndarray) -> float:
    return float(max(np.linalg.norm(points[2] - points[0]), np.linalg.norm(points[3] - points[1])))


def _warp_card(donor: Image.Image, donor_corners: Sequence[dict[str, float]], quad: np.ndarray,
               size: tuple[int, int]) -> tuple[Image.Image, Image.Image]:
    """The donor's card, warped onto ``quad`` (TopLeft, TopRight, BottomRight, BottomLeft pixels)."""
    from .extraction import _homography_coefficients
    source = _pixels(donor_corners, donor.size)
    coefficients = _homography_coefficients([tuple(point) for point in quad], [tuple(point) for point in source])
    warped = donor.transform(size, Image.Transform.PERSPECTIVE, coefficients, Image.Resampling.BICUBIC)
    return warped, _quad_mask(quad, size)


def _swap_background(image: Image.Image, points: np.ndarray, background: Image.Image,
                     rng: random.Random) -> Image.Image:
    """The card on another photograph's surface, with a soft contact shadow."""
    surface = ImageOps.fit(background.convert("RGB"), image.size, Image.Resampling.BICUBIC,
                           centering=(rng.random(), rng.random()))
    mask = _quad_mask(points, image.size)
    shadow = Image.new("L", image.size)
    shadow.paste(mask.filter(ImageFilter.GaussianBlur(rng.uniform(2, 8))),
                 (rng.randint(-4, 6), rng.randint(0, 8)))
    surface = Image.composite(ImageEnhance.Brightness(surface).enhance(rng.uniform(.45, .8)), surface,
                              shadow.point(lambda value: int(value * .6)))
    return Image.composite(image, surface, mask.filter(ImageFilter.GaussianBlur(.6)))


def _add_neighbours(image: Image.Image, points: np.ndarray, donors: Donors, rng: random.Random) -> Image.Image:
    """Other cards under the target (a stack) or beside it and cut by the frame (a binder page, a table).

    The target stays on top and whole. A neighbour that would be a second complete card is skipped: a photo
    of two whole cards is a negative in this dataset, not a positive.
    """
    width, height = image.size
    target = _quad_mask(points, image.size)
    centre, diagonal = points.mean(axis=0), _diagonal(points)
    for _ in range(rng.randint(1, 3)):
        donor = donors.card(rng)
        if donor is None:
            return image
        if rng.random() < .6:
            angle = math.radians(rng.uniform(-12, 12))
            direction = rng.uniform(0, 2 * math.pi)
            shift = np.array([math.cos(direction), math.sin(direction)]) * rng.uniform(.03, .14) * diagonal
            rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
            quad = (points - centre) @ rotation.T * rng.uniform(.96, 1.04) + centre + shift
        else:
            edge = rng.randrange(4)
            across = (points[edge] + points[(edge + 1) % 4] - points[(edge + 2) % 4] - points[(edge + 3) % 4]) / 2
            quad = points + across * rng.uniform(1.03, 1.2)
            inside = (quad >= 0).all(axis=1) & (quad[:, 0] <= width - 1) & (quad[:, 1] <= height - 1)
            if inside.all():
                continue
        warped, mask = _warp_card(*donor, quad, image.size)
        image = Image.composite(warped, image, ImageChops.subtract(mask, target))
    return image


def _add_sleeve(image: Image.Image, points: np.ndarray, rng: random.Random) -> Image.Image:
    """A clear sleeve or toploader: a haze and a bright or dark rim just outside the card, and a streak.

    The label stays on the card itself (target_boundary physical-card-excluding-sleeve).
    """
    toploader = rng.random() < .35
    centre = points.mean(axis=0)
    outer = centre + (points - centre) * (rng.uniform(1.06, 1.14) if toploader else rng.uniform(1.015, 1.045))
    alpha = Image.new("L", image.size)
    draw = ImageDraw.Draw(alpha)
    draw.polygon([tuple(point) for point in outer], fill=rng.randint(8, 30))
    rim = rng.randint(3, 7) if toploader else rng.randint(1, 3)
    draw.line([tuple(point) for point in np.vstack((outer, outer[:1]))], fill=rng.randint(90, 200), width=rim)
    for _ in range(rng.randint(0, 2)):
        start, end = rng.sample(range(4), 2)
        a = outer[start] + (outer[(start + 1) % 4] - outer[start]) * rng.random()
        b = outer[end] + (outer[(end + 1) % 4] - outer[end]) * rng.random()
        band = Image.new("L", image.size)
        ImageDraw.Draw(band).line([tuple(a), tuple(b)], fill=rng.randint(60, 160),
                                  width=max(2, round(_diagonal(points) * rng.uniform(.01, .05))))
        alpha = ImageChops.lighter(alpha, ImageChops.multiply(band, _quad_mask(outer, image.size)))
    colour = (rng.randint(230, 255),) * 3 if rng.random() < .7 else (rng.randint(15, 60),) * 3
    return Image.composite(Image.new("RGB", image.size, colour), image, alpha.filter(ImageFilter.GaussianBlur(.6)))


SKIN_TONES = ((241, 194, 167), (224, 172, 135), (198, 134, 96), (161, 102, 69), (110, 70, 47), (74, 47, 33))


def _add_finger(image: Image.Image, points: np.ndarray, rng: random.Random) -> Image.Image:
    """A finger or thumb over an edge or a corner, coming in from outside the card."""
    centre, diagonal = points.mean(axis=0), _diagonal(points)
    index = rng.randrange(4)
    tip = points[index] if rng.random() < .5 else (points[index] + points[(index + 1) % 4]) / 2
    tip = tip + (centre - tip) * rng.uniform(.02, .25)
    outward = tip - centre
    angle = math.radians(rng.uniform(-40, 40))
    outward = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]) @ outward
    base = tip + outward / max(1e-6, np.linalg.norm(outward)) * diagonal * rng.uniform(.4, .8)
    # A finger is ~18mm wide against the card's ~105mm diagonal.
    thickness = round(diagonal * rng.uniform(.14, .22))
    mask = Image.new("L", image.size)
    draw = ImageDraw.Draw(mask)
    draw.line([tuple(base), tuple(tip)], fill=255, width=thickness)
    draw.ellipse([tip[0] - thickness / 2, tip[1] - thickness / 2, tip[0] + thickness / 2, tip[1] + thickness / 2], fill=255)
    tone = np.array(rng.choice(SKIN_TONES)) * rng.uniform(.75, 1.1)
    skin = np.asarray(Image.new("RGB", image.size, tuple(int(v) for v in np.clip(tone, 0, 255))), dtype=np.float32)
    # A darker rim reads as a rounded finger rather than a flat sticker.
    shading = np.asarray(mask.filter(ImageFilter.GaussianBlur(thickness / 4)), dtype=np.float32)[..., None] / 255
    skin = Image.fromarray(np.clip(skin * (.55 + .5 * shading), 0, 255).astype(np.uint8))
    return Image.composite(skin, image, mask.filter(ImageFilter.GaussianBlur(1.2)))


def _add_hard_glare(image: Image.Image, points: np.ndarray, rng: random.Random) -> Image.Image:
    """A sharp specular patch from a lamp or window, often right on a corner."""
    diagonal = _diagonal(points)
    centre = points[rng.randrange(4)] if rng.random() < .5 else points.mean(axis=0) + (
        points[rng.randrange(4)] - points.mean(axis=0)) * rng.random()
    radius = diagonal * rng.uniform(.04, .18)
    vertices = [tuple(centre + radius * rng.uniform(.5, 1.2) * np.array([math.cos(theta), math.sin(theta)]))
                for theta in sorted(rng.uniform(0, 2 * math.pi) for _ in range(rng.randint(3, 6)))]
    mask = Image.new("L", image.size)
    ImageDraw.Draw(mask).polygon(vertices, fill=rng.randint(150, 240))
    return Image.composite(Image.new("RGB", image.size, (255, 255, rng.randint(235, 255))), image,
                           mask.filter(ImageFilter.GaussianBlur(rng.uniform(.3, 1.5))))


def _overlay_positive(image: Image.Image, corners: Sequence[dict[str, float]], rng: random.Random,
                      donors: Donors | None) -> Image.Image:
    """The situations the card finder failed on in phone photos (2026-11): other surfaces, stacks and
    neighbours, sleeves and toploaders, fingers, and hard glare. None of them moves the labelled corners."""
    points = _pixels(corners, image.size)
    if donors is not None and rng.random() < .2:
        background = donors.background(rng)
        if background is not None:
            image = _swap_background(image, points, background, rng)
    if donors is not None and rng.random() < .25:
        image = _add_neighbours(image, points, donors, rng)
    if rng.random() < .2:
        image = _add_sleeve(image, points, rng)
    if rng.random() < .15:
        image = _add_finger(image, points, rng)
    if rng.random() < .2:
        image = _add_hard_glare(image, points, rng)
    return image


def augment_photo(image: Image.Image, corners: Sequence[dict[str, float]] | None,
                  rng: random.Random, donors: Donors | None = None,
                  ) -> tuple[Image.Image, Sequence[dict[str, float]] | None]:
    if rng.random() < 0.25:
        return image, corners
    image = image.copy()
    image.thumbnail((512, 512), Image.Resampling.BICUBIC)
    # Do not geometrically transform negatives: cropping could make an ambiguous
    # multi-card/occluded negative into a newly usable target without an annotation.
    if corners is not None:
        image = _overlay_positive(image, corners, rng, donors)
        width, height = image.size
        points = _pixels(corners, image.size)
        for _ in range(8):
            # Phone captures cluster near the four readable rotations. Sampling
            # those modes explicitly gives the semantic/global orientation heads
            # many more hard 90/180-degree examples than a purely uniform angle.
            angle_degrees = (rng.choice((0, 90, 180, 270)) + rng.uniform(-18, 18)
                             if rng.random() < .7 else rng.uniform(-180, 180))
            angle = math.radians(angle_degrees)
            turn = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
            if rng.random() < .15:
                # Close-up: the card nearly fills the frame, corners close to its edges. Capped at 2.2x so a small
                # card in the photo is not blown up into a blur no phone close-up has.
                focus = points.mean(axis=0)
                card = np.ptp((points - focus) @ turn.T, axis=0)
                scale = min(2.2, rng.uniform(.85, 1.) * min(width / card[0], height / card[1]))
                shift = np.zeros(2)
            else:
                focus = np.array([(width - 1) / 2, (height - 1) / 2])
                scale = rng.uniform(0.72, 1.15)
                shift = np.array([rng.uniform(-0.1, 0.1) * width, rng.uniform(-0.1, 0.1) * height])
            centre = np.array([[1, 0, -focus[0]], [0, 1, -focus[1]], [0, 0, 1.]])
            rotation = np.array([[scale * turn[0, 0], scale * turn[0, 1], 0],
                                 [scale * turn[1, 0], scale * turn[1, 1], 0],
                                 [rng.uniform(-0.14, 0.14) / width, rng.uniform(-0.14, 0.14) / height, 1.]])
            position = np.array([[1, 0, (width - 1) / 2 + shift[0]],
                                 [0, 1, (height - 1) / 2 + shift[1]], [0, 0, 1.]])
            try:
                image, corners = transform_photo(image, corners, position @ rotation @ centre)
                break
            except (ValueError, np.linalg.LinAlgError):
                continue
    return _apply_camera_artifacts(image, rng), corners

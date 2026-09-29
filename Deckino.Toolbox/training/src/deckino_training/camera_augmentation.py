"""Phone-camera degradations for training the artwork embedding on digital art crops.

The artwork model learns from clean Scryfall scans but has to recognize crops cut
from a phone's 480x640 video frame: printed ink under room light, hand-shake and
focus blur, sensor noise and the phone's denoising in dim light, glare from
sleeves and foil, and the frame's low resolution and compression. The earlier
("legacy") training views only had mild brightness/contrast jitter, a light
Gaussian blur and a flat glare band, so the model rarely saw a dark, noisy or
motion-blurred card - exactly where it struggles on the phone.

:class:`CameraDegradation` randomizes each of those effects independently and
in a physically plausible order (the scene, then the lens, then the sensor, then
the phone's processing), so no single synthetic "look" is learned. Whether the
result resembles real frames is checked by ``preview-artwork-augmentation``;
whether it helps is decided only on real photos by ``probe-artwork-camera``.
"""
from __future__ import annotations

import io
import math

import torch
from PIL import Image
from torch import Tensor
from torch.nn import functional as F

# Training recipes recorded in the checkpoint config. "legacy" reproduces the
# transform every model before camera-v1 was trained with.
LEGACY_RECIPE = "legacy"
CAMERA_RECIPE = "camera-v1"
AUGMENTATION_RECIPES = (LEGACY_RECIPE, CAMERA_RECIPE)
DEFAULT_RECIPE = CAMERA_RECIPE

LUMA = (0.299, 0.587, 0.114)


class CameraDegradation:
    """Degrade a [3, H, W] float RGB tensor in [0, 1] the way a phone camera does.

    ``probability`` is the chance a view is degraded at all; the rest stay clean
    so clean scans (what the prototypes are built from) keep mapping close by.
    Pass ``generator`` for reproducible previews; training uses the global RNG,
    which the DataLoader seeds per worker.
    """

    def __init__(self, probability: float = 0.85, generator: torch.Generator | None = None) -> None:
        self.probability = probability
        self.generator = generator

    # -- random helpers -------------------------------------------------
    def _uniform(self, low: float, high: float) -> float:
        return low + (high - low) * float(torch.rand((), generator=self.generator))

    def _chance(self, probability: float) -> bool:
        return float(torch.rand((), generator=self.generator)) < probability

    def _randn(self, *shape: int) -> Tensor:
        return torch.randn(*shape, generator=self.generator)

    def __call__(self, image: Tensor) -> Tensor:
        if not self._chance(self.probability):
            return image
        image = image.clone()
        # The scene: a printed card under room light, often behind a sleeve.
        if self._chance(0.7):
            image = self._printed(image)
        if self._chance(0.5):
            image = self._haze(image)
        if self._chance(0.35):
            image = self._glare(image)
        # The light and the lens.
        if self._chance(0.6):
            image = self._white_balance(image)
        gain = 1.0
        if self._chance(0.7):
            image, gain = self._exposure(image)
        if self._chance(0.3):
            image = self._vignette(image)
        if self._chance(0.6):
            image = self._blur(image)
        # The sensor and the phone's processing. Dim light means more gain, so more noise.
        if self._chance(0.6):
            image = self._noise(image, gain)
            if self._chance(0.5):
                image = self._chroma_denoise(image)
        # Real crops are soft: the art box is only ~150-250 px of a VGA frame.
        if self._chance(0.8):
            image = self._resolution(image)
        if self._chance(0.2):
            image = self._sharpen(image)
        image = image.clamp(0, 1)
        if self._chance(0.5):
            image = self._jpeg(image)
        return image

    # -- the scene ------------------------------------------------------
    def _printed(self, image: Tensor) -> Tensor:
        """Ink on paper: lifted blacks, dimmer whites, less saturation, faint paper texture."""
        black, white = self._uniform(0.03, 0.15), self._uniform(0.85, 1.0)
        image = black + (white - black) * image
        luma = _luma(image)
        image = luma + (image - luma) * self._uniform(0.9, 1.15)
        height, width = image.shape[1:]
        texture = F.interpolate(self._randn(1, 1, max(2, height // 12), max(2, width // 12)),
                                size=(height, width), mode="bilinear", align_corners=False)[0]
        return image * (1 + texture * self._uniform(0.01, 0.035))

    def _haze(self, image: Tensor) -> Tensor:
        """A sleeve, top-loader or smudged lens: veiling light that lowers contrast."""
        level = self._uniform(0.55, 0.95)
        amount = self._uniform(0.05, 0.35)
        return image * (1 - amount) + level * amount

    def _glare(self, image: Tensor) -> Tensor:
        """A soft specular highlight or a broad sleeve sheen; strong ones blow out to white."""
        _, height, width = image.shape
        y = torch.linspace(0, 1, height).view(height, 1)
        x = torch.linspace(0, 1, width).view(1, width)
        if self._chance(0.6):
            cx, cy = self._uniform(-0.1, 1.1), self._uniform(-0.1, 1.1)
            sx, sy = self._uniform(0.06, 0.35), self._uniform(0.06, 0.35)
            angle = self._uniform(0, math.pi)
            dx, dy = x - cx, y - cy
            u = dx * math.cos(angle) + dy * math.sin(angle)
            v = -dx * math.sin(angle) + dy * math.cos(angle)
            mask = torch.exp(-0.5 * ((u / sx) ** 2 + (v / sy) ** 2))
            strength = self._uniform(0.3, 1.1)
        else:
            angle = self._uniform(0, 2 * math.pi)
            ramp = (x * math.cos(angle) + y * math.sin(angle))
            ramp = (ramp - ramp.min()) / (ramp.max() - ramp.min() + 1e-6)
            mask = ramp ** self._uniform(1.5, 4.0)
            strength = self._uniform(0.08, 0.35)
        mask = (mask * strength).unsqueeze(0)
        # Glare is added light that also washes out colour underneath it.
        luma = _luma(image)
        washed = luma + (image - luma) * (1 - mask.clamp(0, 1) * 0.7)
        return washed + mask

    # -- light and lens -------------------------------------------------
    def _white_balance(self, image: Tensor) -> Tensor:
        """Warm tungsten to cool daylight, with a slight green/magenta tint."""
        temperature = self._uniform(-0.22, 0.22)
        tint = self._uniform(-0.07, 0.07)
        gains = torch.tensor([1 + temperature, 1 + tint, 1 - temperature]).view(3, 1, 1)
        return image * gains / gains.mean()

    def _exposure(self, image: Tensor) -> tuple[Tensor, float]:
        """Mostly underexposure (dim rooms), sometimes over; returns the sensor gain it implies."""
        # Real crops are mostly well or over-exposed; a third of views practise dim rooms.
        low, high = (0.22, 0.7) if self._chance(0.3) else (0.8, 1.9)
        exposure = math.exp(self._uniform(math.log(low), math.log(high)))
        gamma = self._uniform(0.8, 1.25)
        image = (image.clamp(min=0) * exposure).clamp(0, 1) ** gamma
        # A phone brightens a dark scene with gain; the dimmer the scene, the higher the gain.
        return image, max(1.0, 1 / exposure)

    def _vignette(self, image: Tensor) -> Tensor:
        _, height, width = image.shape
        y = torch.linspace(-1, 1, height).view(height, 1)
        x = torch.linspace(-1, 1, width).view(1, width)
        radius = (x ** 2 + y ** 2) / 2
        return image * (1 - self._uniform(0.1, 0.4) * radius).unsqueeze(0)

    def _blur(self, image: Tensor) -> Tensor:
        """Hand-shake (motion), missed focus (defocus disk) or general softness (Gaussian)."""
        kind = float(torch.rand((), generator=self.generator))
        if kind < 0.45:
            kernel = _motion_kernel(self._uniform(3, 13), self._uniform(0, math.pi))
        elif kind < 0.75:
            kernel = _disk_kernel(self._uniform(1.0, 3.5))
        else:
            kernel = _gaussian_kernel(self._uniform(0.5, 1.8))
        return _convolve(image, kernel)

    # -- sensor and processing -----------------------------------------
    def _noise(self, image: Tensor, gain: float) -> Tensor:
        """Shot noise (grows with signal), read noise, and blotchy low-frequency colour noise."""
        _, height, width = image.shape
        shot = self._uniform(0.005, 0.025) * math.sqrt(gain)
        read = self._uniform(0.002, 0.012) * gain
        noisy = image + self._randn(3, height, width) * (shot * image.clamp(min=0).sqrt() + read)
        chroma = F.interpolate(self._randn(1, 3, max(2, height // 4), max(2, width // 4)),
                               size=(height, width), mode="bilinear", align_corners=False)[0]
        return noisy + chroma * self._uniform(0.002, 0.012) * gain

    def _chroma_denoise(self, image: Tensor) -> Tensor:
        """The phone's noise reduction: smears colour detail while keeping luminance edges."""
        luma = _luma(image)
        colour = _convolve(image - luma, _gaussian_kernel(self._uniform(0.8, 2.0)))
        luma = _convolve(luma, _gaussian_kernel(self._uniform(0.3, 0.8)))
        return luma + colour

    def _resolution(self, image: Tensor) -> Tensor:
        """The art box covers only part of a VGA frame: lose detail, then scale back up."""
        _, height, width = image.shape
        factor = self._uniform(0.25, 0.75)
        small = F.interpolate(image.unsqueeze(0), scale_factor=factor, mode="bilinear",
                              antialias=True, align_corners=False)
        return F.interpolate(small, size=(height, width), mode="bilinear", align_corners=False)[0]

    def _sharpen(self, image: Tensor) -> Tensor:
        """Phone sharpening, which leaves halos around edges."""
        blurred = _convolve(image, _gaussian_kernel(self._uniform(0.8, 1.6)))
        return image + (image - blurred) * self._uniform(0.2, 0.8)

    def _jpeg(self, image: Tensor) -> Tensor:
        pixels = (image.permute(1, 2, 0) * 255).round().to(torch.uint8).numpy()
        buffer = io.BytesIO()
        Image.fromarray(pixels).save(buffer, "JPEG", quality=int(self._uniform(30, 92)))
        buffer.seek(0)
        with Image.open(buffer) as decoded:
            array = torch.frombuffer(bytearray(decoded.convert("RGB").tobytes()), dtype=torch.uint8)
        return array.view(image.shape[1], image.shape[2], 3).permute(2, 0, 1).float() / 255


def _luma(image: Tensor) -> Tensor:
    weights = torch.tensor(LUMA, dtype=image.dtype).view(3, 1, 1)
    return (image * weights).sum(0, keepdim=True)


def _convolve(image: Tensor, kernel: Tensor) -> Tensor:
    """Per-channel 2D convolution with reflected borders."""
    channels = image.shape[0]
    size = kernel.shape[-1]
    weight = kernel.to(image.dtype).expand(channels, 1, size, size)
    padded = F.pad(image.unsqueeze(0), (size // 2,) * 4, mode="reflect")
    return F.conv2d(padded, weight, groups=channels)[0]


def _gaussian_kernel(sigma: float) -> Tensor:
    radius = max(1, int(math.ceil(sigma * 3)))
    steps = torch.arange(-radius, radius + 1, dtype=torch.float32)
    line = torch.exp(-0.5 * (steps / sigma) ** 2)
    kernel = line[:, None] * line[None, :]
    return (kernel / kernel.sum()).view(1, 1, *kernel.shape)


def _disk_kernel(radius: float) -> Tensor:
    size = int(math.ceil(radius)) * 2 + 1
    steps = torch.arange(size, dtype=torch.float32) - size // 2
    distance = (steps[:, None] ** 2 + steps[None, :] ** 2).sqrt()
    # Anti-aliased disk edge.
    kernel = (radius + 0.5 - distance).clamp(0, 1)
    return (kernel / kernel.sum()).view(1, 1, size, size)


def _motion_kernel(length: float, angle: float) -> Tensor:
    size = int(math.ceil(length)) | 1
    kernel = torch.zeros(size, size)
    centre = size // 2
    samples = max(2, size * 4)
    for step in torch.linspace(-length / 2, length / 2, samples).tolist():
        x = centre + step * math.cos(angle)
        y = centre + step * math.sin(angle)
        # Bilinear splat keeps short and diagonal streaks smooth.
        left, top = int(math.floor(x)), int(math.floor(y))
        for dy in (0, 1):
            for dx in (0, 1):
                column, row = left + dx, top + dy
                if 0 <= column < size and 0 <= row < size:
                    kernel[row, column] += (1 - abs(x - column)) * (1 - abs(y - row))
    return (kernel / kernel.sum()).view(1, 1, size, size)

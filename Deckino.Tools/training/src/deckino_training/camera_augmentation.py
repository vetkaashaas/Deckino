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
the phone's processing), so no single synthetic "look" is learned. It works on a
whole batch at once, on whatever device the batch is on: training runs it on the
GPU, because on the CPU it took a third of every DataLoader worker's time. Whether
the result resembles real frames is checked by ``preview-artwork-augmentation``;
whether it helps is decided only on real photos by ``probe-artwork-camera``.
"""
from __future__ import annotations

import math

import torch
from torch import Tensor
from torch.nn import functional as F

# Training recipes recorded in the checkpoint config. "legacy" reproduces the
# transform every model before camera-v1 was trained with.
LEGACY_RECIPE = "legacy"
CAMERA_RECIPE = "camera-v1"
# camera-v1 scan views plus crops of the real camera photos labelled in the Toolbox (artwork_real_photos.py).
CAMERA_REAL_RECIPE = "camera-real-v1"
AUGMENTATION_RECIPES = (LEGACY_RECIPE, CAMERA_RECIPE, CAMERA_REAL_RECIPE)
DEFAULT_RECIPE = CAMERA_RECIPE

LUMA = (0.299, 0.587, 0.114)
# Every blur kernel is drawn on this grid: a 13 px motion streak, a 3.5 px defocus disk, a Gaussian up to sigma 2.
KERNEL_SIZE = 13
# libjpeg's standard quantization tables (JPEG Annex K), which PIL scales by quality.
JPEG_LUMA_TABLE = (
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
)
JPEG_CHROMA_TABLE = (17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
                     47, 66, 99, 99, 99, 99, 99, 99) + (99,) * 32


class CameraDegradation:
    """Degrade a batch of [N, 3, H, W] uint8 RGB views the way a phone camera does; returns float RGB in [0, 1].

    Every view draws its own effects and strengths. ``probability`` is the chance a view is degraded at all; the
    rest stay clean so clean scans (what the prototypes are built from) keep mapping close by. Occlusions (fingers,
    sleeve edges, stickers) land on any view, as noise patches outside [0, 1]. Uses the global RNG of the batch's
    device.
    """

    def __init__(self, probability: float = 0.85) -> None:
        self.probability = probability

    def __call__(self, images: Tensor) -> Tensor:
        image = images.float() / 255
        degraded = _chance(image, self.probability)

        def pick(probability: float) -> Tensor:
            return (degraded & _chance(image, probability)).view(-1, 1, 1, 1)

        # Each effect runs on the whole batch and is kept for the views that drew it: on a GPU that is far cheaper
        # than splitting the batch.
        # The scene: a printed card under room light, often behind a sleeve.
        image = torch.where(pick(0.7), _printed(image), image)
        image = torch.where(pick(0.5), _haze(image), image)
        image = torch.where(pick(0.35), _glare(image), image)
        # The light and the lens.
        image = torch.where(pick(0.6), _white_balance(image), image)
        exposed, gain = _exposure(image)
        chosen = pick(0.7)
        image = torch.where(chosen, exposed, image)
        gain = torch.where(chosen, gain, 1.0)
        image = torch.where(pick(0.3), _vignette(image), image)
        image = torch.where(pick(0.6), _blur(image), image)
        # The sensor and the phone's processing. Dim light means more gain, so more noise.
        chosen = pick(0.6)
        image = torch.where(chosen, _noise(image, gain), image)
        image = torch.where(chosen & _chance(image, 0.5).view(-1, 1, 1, 1), _chroma_denoise(image), image)
        # Real crops are soft: the art box is only ~150-250 px of a VGA frame.
        image = torch.where(pick(0.8), _resolution(image), image)
        image = torch.where(pick(0.2), _sharpen(image), image)
        image = image.clamp(0, 1)
        image = torch.where(pick(0.5), _jpeg(image), image)
        return _occlude(image)


def _uniform(like: Tensor, low: float, high: float) -> Tensor:
    """One value per view, shaped to broadcast over [N, C, H, W]."""
    return low + (high - low) * torch.rand(like.shape[0], 1, 1, 1, device=like.device)


def _chance(like: Tensor, probability: float) -> Tensor:
    return torch.rand(like.shape[0], device=like.device) < probability


def _grid(like: Tensor, low: float, high: float) -> tuple[Tensor, Tensor]:
    """Row and column coordinates spanning [low, high], shaped [1, 1, H, 1] and [1, 1, 1, W]."""
    height, width = like.shape[-2:]
    y = torch.linspace(low, high, height, device=like.device).view(1, 1, height, 1)
    x = torch.linspace(low, high, width, device=like.device).view(1, 1, 1, width)
    return y, x


def _luma(image: Tensor) -> Tensor:
    return (image * image.new_tensor(LUMA).view(1, 3, 1, 1)).sum(1, keepdim=True)


# -- the scene -------------------------------------------------------------
def _printed(image: Tensor) -> Tensor:
    """Ink on paper: lifted blacks, dimmer whites, less saturation, faint paper texture."""
    black, white = _uniform(image, 0.03, 0.15), _uniform(image, 0.85, 1.0)
    image = black + (white - black) * image
    luma = _luma(image)
    image = luma + (image - luma) * _uniform(image, 0.9, 1.15)
    count, _, height, width = image.shape
    texture = F.interpolate(torch.randn(count, 1, max(2, height // 12), max(2, width // 12), device=image.device),
                            size=(height, width), mode="bilinear", align_corners=False)
    return image * (1 + texture * _uniform(image, 0.01, 0.035))


def _haze(image: Tensor) -> Tensor:
    """A sleeve, top-loader or smudged lens: veiling light that lowers contrast."""
    level = _uniform(image, 0.55, 0.95)
    amount = _uniform(image, 0.05, 0.35)
    return image * (1 - amount) + level * amount


def _glare(image: Tensor) -> Tensor:
    """A soft specular highlight or a broad sleeve sheen; strong ones blow out to white."""
    y, x = _grid(image, 0, 1)
    # A highlight: a rotated Gaussian spot.
    cx, cy = _uniform(image, -0.1, 1.1), _uniform(image, -0.1, 1.1)
    sx, sy = _uniform(image, 0.06, 0.35), _uniform(image, 0.06, 0.35)
    angle = _uniform(image, 0, math.pi)
    dx, dy = x - cx, y - cy
    u = dx * angle.cos() + dy * angle.sin()
    v = -dx * angle.sin() + dy * angle.cos()
    spot = torch.exp(-0.5 * ((u / sx) ** 2 + (v / sy) ** 2)) * _uniform(image, 0.3, 1.1)
    # A sheen: a ramp across the card.
    angle = _uniform(image, 0, 2 * math.pi)
    ramp = x * angle.cos() + y * angle.sin()
    low, high = ramp.amin((2, 3), keepdim=True), ramp.amax((2, 3), keepdim=True)
    sheen = ((ramp - low) / (high - low + 1e-6)) ** _uniform(image, 1.5, 4.0) * _uniform(image, 0.08, 0.35)
    mask = torch.where(_chance(image, 0.6).view(-1, 1, 1, 1), spot, sheen)
    # Glare is added light that also washes out colour underneath it.
    luma = _luma(image)
    washed = luma + (image - luma) * (1 - mask.clamp(0, 1) * 0.7)
    return washed + mask


# -- light and lens ----------------------------------------------------------
def _white_balance(image: Tensor) -> Tensor:
    """Warm tungsten to cool daylight, with a slight green/magenta tint."""
    temperature = _uniform(image, -0.22, 0.22)
    tint = _uniform(image, -0.07, 0.07)
    gains = torch.cat((1 + temperature, 1 + tint, 1 - temperature), dim=1)
    return image * gains / gains.mean(1, keepdim=True)


def _exposure(image: Tensor) -> tuple[Tensor, Tensor]:
    """Mostly underexposure (dim rooms), sometimes over; returns the sensor gain it implies."""
    # Real crops are mostly well or over-exposed; a third of views practise dim rooms.
    dim = _chance(image, 0.3).view(-1, 1, 1, 1)
    low = torch.where(dim, math.log(0.22), math.log(0.8))
    high = torch.where(dim, math.log(0.7), math.log(1.9))
    exposure = (low + (high - low) * torch.rand_like(low)).exp()
    image = (image.clamp(min=0) * exposure).clamp(0, 1) ** _uniform(image, 0.8, 1.25)
    # A phone brightens a dark scene with gain; the dimmer the scene, the higher the gain.
    return image, (1 / exposure).clamp(min=1)


def _vignette(image: Tensor) -> Tensor:
    y, x = _grid(image, -1, 1)
    radius = (x ** 2 + y ** 2) / 2
    return image * (1 - _uniform(image, 0.1, 0.4) * radius)


def _blur(image: Tensor) -> Tensor:
    """Hand-shake (motion), missed focus (defocus disk) or general softness (Gaussian)."""
    kind = torch.rand(image.shape[0], 1, 1, device=image.device)
    motion = _motion_kernels(_uniform(image, 3, 13), _uniform(image, 0, math.pi))
    defocus = _disk_kernels(_uniform(image, 1.0, 3.5))
    soft = _gaussian_kernels(_uniform(image, 0.5, 1.8))
    kernels = torch.where(kind < 0.45, motion, torch.where(kind < 0.75, defocus, soft))
    return _convolve(image, kernels)


# -- sensor and processing -------------------------------------------------
def _noise(image: Tensor, gain: Tensor) -> Tensor:
    """Shot noise (grows with signal), read noise, and blotchy low-frequency colour noise."""
    count, _, height, width = image.shape
    shot = _uniform(image, 0.005, 0.025) * gain.sqrt()
    read = _uniform(image, 0.002, 0.012) * gain
    noisy = image + torch.randn_like(image) * (shot * image.clamp(min=0).sqrt() + read)
    chroma = F.interpolate(torch.randn(count, 3, max(2, height // 4), max(2, width // 4), device=image.device),
                           size=(height, width), mode="bilinear", align_corners=False)
    return noisy + chroma * _uniform(image, 0.002, 0.012) * gain


def _chroma_denoise(image: Tensor) -> Tensor:
    """The phone's noise reduction: smears colour detail while keeping luminance edges."""
    luma = _luma(image)
    colour = _convolve(image - luma, _gaussian_kernels(_uniform(image, 0.8, 2.0)))
    luma = _convolve(luma, _gaussian_kernels(_uniform(image, 0.3, 0.8)))
    return luma + colour


def _resolution(image: Tensor) -> Tensor:
    """The art box covers only part of a VGA frame: lose detail, then scale back up."""
    height, width = image.shape[-2:]
    # Scales in sixteenths (0.25 to 0.75), so the batch takes one resize per scale, not one per view.
    sixteenths = torch.randint(4, 13, (image.shape[0],))
    result = torch.empty_like(image)
    for step in sixteenths.unique().tolist():
        views = (sixteenths == step).nonzero().view(-1).to(image.device)
        small = F.interpolate(image[views], scale_factor=step / 16, mode="bilinear", antialias=True,
                              align_corners=False)
        result[views] = F.interpolate(small, size=(height, width), mode="bilinear", align_corners=False)
    return result


def _sharpen(image: Tensor) -> Tensor:
    """Phone sharpening, which leaves halos around edges."""
    blurred = _convolve(image, _gaussian_kernels(_uniform(image, 0.8, 1.6)))
    return image + (image - blurred) * _uniform(image, 0.2, 0.8)


def _jpeg(image: Tensor) -> Tensor:
    """A JPEG round trip at quality 30-91, in tensor maths: libjpeg's colour transform, 4:2:0 chroma, 8x8 DCT and
    quality-scaled tables, as PIL encodes, with bilinear chroma upsampling standing in for libjpeg's."""
    height, width = image.shape[-2:]
    quality = torch.randint(30, 92, (image.shape[0], 1, 1), device=image.device).float()
    scale = torch.where(quality < 50, 5000 / quality, 200 - 2 * quality)

    def table(base: tuple[int, ...]) -> Tensor:
        return ((image.new_tensor(base).view(1, 8, 8) * scale + 50) / 100).floor().clamp(1, 255)

    red, green, blue = (image * 255).round().unbind(1)
    luma = 0.299 * red + 0.587 * green + 0.114 * blue
    chroma = torch.stack((-0.168736 * red - 0.331264 * green + 0.5 * blue,
                          0.5 * red - 0.418688 * green - 0.081312 * blue), 1)
    luma = _quantize_blocks(luma.unsqueeze(1) - 128, table(JPEG_LUMA_TABLE)) + 128
    chroma = _quantize_blocks(F.avg_pool2d(chroma, 2), table(JPEG_CHROMA_TABLE))
    blue_difference, red_difference = F.interpolate(chroma, size=(height, width), mode="bilinear",
                                                    align_corners=False).unbind(1)
    luma = luma[:, 0]
    rgb = torch.stack((luma + 1.402 * red_difference,
                       luma - 0.344136 * blue_difference - 0.714136 * red_difference,
                       luma + 1.772 * blue_difference), 1)
    return rgb.clamp(0, 255).round() / 255


def _quantize_blocks(planes: Tensor, tables: Tensor) -> Tensor:
    """Each 8x8 block through the DCT, rounded to a multiple of its view's table, and back."""
    count, channels, height, width = planes.shape
    padded = F.pad(planes, (0, -width % 8, 0, -height % 8), mode="replicate")
    rows, columns = padded.shape[-2] // 8, padded.shape[-1] // 8
    blocks = padded.view(count, channels, rows, 8, columns, 8).transpose(3, 4)
    steps = torch.arange(8, device=planes.device, dtype=planes.dtype)
    dct = torch.cos((2 * steps[None, :] + 1) * steps[:, None] * math.pi / 16) * 0.5
    dct[0] /= math.sqrt(2)
    tables = tables.view(count, 1, 1, 1, 8, 8)
    coefficients = (dct @ blocks @ dct.T / tables).round() * tables
    blocks = dct.T @ coefficients @ dct
    return blocks.transpose(3, 4).reshape(count, channels, rows * 8, columns * 8)[..., :height, :width]


def _occlude(image: Tensor) -> Tensor:
    """Fingers, sleeve edges and stickers: a patch of noise over 1-8% of an eighth of the views."""
    count, _, height, width = image.shape
    area = _uniform(image, 0.01, 0.08).view(-1) * height * width
    ratio = _uniform(image, math.log(0.2), math.log(4.0)).view(-1).exp()
    patch_height = (area * ratio).sqrt().round().clamp(1, height - 1)
    patch_width = (area / ratio).sqrt().round().clamp(1, width - 1)
    top = (torch.rand(count, device=image.device) * (height - patch_height + 1)).floor()
    left = (torch.rand(count, device=image.device) * (width - patch_width + 1)).floor()
    rows = torch.arange(height, device=image.device).view(1, height, 1)
    columns = torch.arange(width, device=image.device).view(1, 1, width)
    inside = ((rows >= top.view(-1, 1, 1)) & (rows < (top + patch_height).view(-1, 1, 1))
              & (columns >= left.view(-1, 1, 1)) & (columns < (left + patch_width).view(-1, 1, 1)))
    inside = inside.unsqueeze(1) & _chance(image, 0.12).view(-1, 1, 1, 1)
    return torch.where(inside, torch.randn_like(image), image)


# -- blur kernels: [N, KERNEL_SIZE, KERNEL_SIZE], one per view, each summing to 1 --------------------------------
def _kernel_steps(like: Tensor) -> Tensor:
    return torch.arange(KERNEL_SIZE, device=like.device, dtype=torch.float32) - KERNEL_SIZE // 2


def _normalized(kernels: Tensor) -> Tensor:
    return kernels / kernels.sum((1, 2), keepdim=True)


def _gaussian_kernels(sigma: Tensor) -> Tensor:
    steps = _kernel_steps(sigma)
    sigma = sigma.view(-1, 1)
    # Cut at three sigma, as a kernel of that size would be.
    line = torch.exp(-0.5 * (steps / sigma) ** 2) * (steps.abs() <= (sigma * 3).ceil().clamp(min=1))
    return _normalized(line[:, :, None] * line[:, None, :])


def _disk_kernels(radius: Tensor) -> Tensor:
    steps = _kernel_steps(radius)
    distance = (steps[:, None] ** 2 + steps[None, :] ** 2).sqrt()
    # Anti-aliased disk edge.
    return _normalized((radius.view(-1, 1, 1) + 0.5 - distance).clamp(0, 1))


def _motion_kernels(length: Tensor, angle: Tensor) -> Tensor:
    steps = _kernel_steps(length)
    along = torch.linspace(-0.5, 0.5, KERNEL_SIZE * 4, device=length.device) * length.view(-1, 1)
    x = along * angle.view(-1, 1).cos()
    y = along * angle.view(-1, 1).sin()
    # Bilinear splat of points along the streak keeps short and diagonal streaks smooth.
    weight_x = (1 - (x[:, :, None] - steps).abs()).clamp(min=0)
    weight_y = (1 - (y[:, :, None] - steps).abs()).clamp(min=0)
    return _normalized(torch.einsum("nsr,nsc->nrc", weight_y, weight_x))


def _convolve(image: Tensor, kernels: Tensor) -> Tensor:
    """Each view convolved with its own kernel, per channel, with reflected borders."""
    count, channels, height, width = image.shape
    weight = kernels.to(image.dtype).repeat_interleave(channels, 0).unsqueeze(1)
    padded = F.pad(image.reshape(1, count * channels, height, width), (KERNEL_SIZE // 2,) * 4, mode="reflect")
    return F.conv2d(padded, weight, groups=count * channels).view(count, channels, height, width)

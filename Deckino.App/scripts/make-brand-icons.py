"""Builds the app icon, Android adaptive icon layers and splash image from the
client brand files in `Client Files/PNG`. Re-run after the client artwork changes:

    python scripts/make-brand-icons.py [preview.png]
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

APP = Path(__file__).resolve().parents[1]
CLIENT = APP.parents[1] / 'Client Files' / 'PNG'
OUT = APP / 'assets' / 'images'

PURPLE = (0x98, 0x1D, 0xCE)
PINK = (0xDE, 0x41, 0x90)
SIZE = 1024


def shuriken(color_file: str, box: int) -> Image.Image:
    """The client icon cropped to its glyph and scaled to fit a box x box square."""
    glyph = Image.open(CLIENT / color_file).convert('RGBA')
    glyph = glyph.crop(glyph.getbbox())
    scale = box / max(glyph.size)
    return glyph.resize(
        (round(glyph.width * scale), round(glyph.height * scale)), Image.LANCZOS
    )


def centered(glyph: Image.Image, size: int = SIZE) -> Image.Image:
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(
        glyph, ((size - glyph.width) // 2, (size - glyph.height) // 2)
    )
    return canvas


def brand_gradient(size: int = SIZE) -> Image.Image:
    """Diagonal purple -> pink, with a soft light bloom behind the glyph."""
    gradient = Image.new('RGB', (size, size))
    pixels = gradient.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            pixels[x, y] = tuple(
                round(a + (b - a) * t) for a, b in zip(PURPLE, PINK)
            )
    bloom = Image.new('L', (size, size), 0)
    ImageDraw.Draw(bloom).ellipse(
        (size * 0.18, size * 0.14, size * 0.82, size * 0.78), fill=70
    )
    bloom = bloom.filter(ImageFilter.GaussianBlur(size * 0.12))
    white = Image.new('RGB', (size, size), (255, 255, 255))
    return Image.composite(white, gradient, bloom).convert('RGBA')


def soft_shadow(glyph_layer: Image.Image) -> Image.Image:
    alpha = glyph_layer.getchannel('A').filter(ImageFilter.GaussianBlur(18))
    shadow = Image.new('RGBA', glyph_layer.size, (60, 0, 70, 0))
    shadow.putalpha(alpha.point(lambda a: a * 45 // 100))
    return shadow


def main() -> None:
    background = brand_gradient()

    # iOS / store icon: full-bleed gradient with the white shuriken.
    glyph = centered(shuriken('Icon_White.png', round(SIZE * 0.58)))
    icon = background.copy()
    icon.alpha_composite(soft_shadow(glyph), (0, 12))
    icon.alpha_composite(glyph)
    icon.convert('RGB').save(OUT / 'icon.png', optimize=True)

    # Android adaptive layers. The launcher mask keeps the inner ~61% circle, so
    # the glyph (which reaches into its bounding-box corners) stays within 42%.
    background.convert('RGB').save(OUT / 'android-icon-background.png', optimize=True)
    foreground = centered(shuriken('Icon_White.png', round(SIZE * 0.42)))
    layered = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    layered.alpha_composite(soft_shadow(foreground), (0, 10))
    layered.alpha_composite(foreground)
    layered.save(OUT / 'android-icon-foreground.png', optimize=True)
    foreground.save(OUT / 'android-icon-monochrome.png', optimize=True)

    # Splash: white shuriken on the brand purple (Android 12+ splash is a solid
    # colour plus a centred icon, masked to a circle).
    centered(shuriken('Icon_White.png', round(SIZE * 0.62))).save(
        OUT / 'splash-icon.png', optimize=True
    )

    # Optional side-by-side preview for eyeballing the results.
    if len(sys.argv) < 2:
        return
    preview = Image.new('RGBA', (SIZE * 3, SIZE), PURPLE + (255,))
    preview.alpha_composite(icon)
    masked = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, SIZE, SIZE), fill=255)
    adaptive = background.copy()
    adaptive.alpha_composite(layered)
    masked.paste(adaptive, (0, 0), mask)
    preview.alpha_composite(masked, (SIZE, 0))
    preview.alpha_composite(
        Image.open(OUT / 'splash-icon.png').resize((SIZE // 3, SIZE // 3)),
        (SIZE * 2 + SIZE // 3, SIZE // 3),
    )
    preview.save(sys.argv[1])


if __name__ == '__main__':
    main()

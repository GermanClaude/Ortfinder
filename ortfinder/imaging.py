"""Image loading, resizing and the zoom crops that let the model read tiny details."""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

# Long-side limit for images sent to Claude; larger images are downscaled by the API anyway.
MODEL_MAX_SIDE = 1568
# Crops are upscaled to at least this long side so small text becomes legible.
ZOOM_MIN_SIDE = 1024
# Smallest crop (in source pixels) we allow; below this there is nothing left to see.
ZOOM_MIN_SOURCE_PX = 24

_heif_registered = False


def register_heif() -> None:
    """Enable HEIC/HEIF (iPhone photos) if pillow-heif is installed."""
    global _heif_registered
    if _heif_registered:
        return
    _heif_registered = True
    try:
        from pillow_heif import register_heif_opener
    except ImportError:
        return
    register_heif_opener()


def load_image(data: bytes) -> Image.Image:
    """Decode, apply the EXIF orientation and convert to RGB."""
    register_heif()
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        background = Image.new("RGB", img.size, (255, 255, 255))
        rgba = img.convert("RGBA")
        background.paste(rgba, mask=rgba.split()[-1])
        img = background
    return img


def fit(img: Image.Image, max_side: int) -> Image.Image:
    if max(img.size) <= max_side:
        return img
    scale = max_side / max(img.size)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    return img.resize(size, Image.LANCZOS)


def to_jpeg_b64(img: Image.Image, max_side: int = MODEL_MAX_SIDE, quality: int = 90) -> str:
    buf = io.BytesIO()
    fit(img, max_side).save(buf, format="JPEG", quality=quality, optimize=True)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


def image_block(img: Image.Image, max_side: int = MODEL_MAX_SIDE) -> dict:
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": to_jpeg_b64(img, max_side)},
    }


def with_grid(img: Image.Image, divisions: int = 10, max_side: int = 1024) -> Image.Image:
    """Overlay a labelled coordinate grid (0.0-1.0) so the model can aim its zoom requests."""
    base = fit(img, max_side).copy()
    draw = ImageDraw.Draw(base, "RGBA")
    w, h = base.size
    for i in range(1, divisions):
        x = round(w * i / divisions)
        y = round(h * i / divisions)
        draw.line([(x, 0), (x, h)], fill=(255, 0, 80, 140), width=1)
        draw.line([(0, y), (w, y)], fill=(255, 0, 80, 140), width=1)
        label = f"{i / divisions:.1f}"
        for pos in ((x + 2, 2), (2, y + 2)):
            draw.rectangle([pos, (pos[0] + 22, pos[1] + 11)], fill=(0, 0, 0, 150))
            draw.text(pos, label, fill=(255, 255, 255, 255))
    return base


@dataclass(frozen=True)
class ZoomBox:
    x_min: float
    y_min: float
    x_max: float
    y_max: float

    @classmethod
    def normalized(cls, x_min: float, y_min: float, x_max: float, y_max: float) -> "ZoomBox":
        """Clamp to [0, 1] and fix swapped corners."""
        xs = sorted((min(max(float(x_min), 0.0), 1.0), min(max(float(x_max), 0.0), 1.0)))
        ys = sorted((min(max(float(y_min), 0.0), 1.0), min(max(float(y_max), 0.0), 1.0)))
        return cls(xs[0], ys[0], xs[1], ys[1])

    def pixels(self, width: int, height: int) -> tuple[int, int, int, int]:
        """Pixel box, grown around its centre to at least ZOOM_MIN_SOURCE_PX per side."""
        left, right = self._axis(self.x_min, self.x_max, width)
        top, bottom = self._axis(self.y_min, self.y_max, height)
        return left, top, right, bottom

    @staticmethod
    def _axis(lo: float, hi: float, size: int) -> tuple[int, int]:
        start, end = round(lo * size), round(hi * size)
        minimum = min(ZOOM_MIN_SOURCE_PX, size)
        if end - start < minimum:
            centre = (start + end) / 2
            start = round(centre - minimum / 2)
            start = min(max(start, 0), size - minimum)
            end = start + minimum
        return start, end


def zoom(img: Image.Image, box: ZoomBox, enhance: bool = False) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """Crop ``box`` from the full-resolution image and upscale it for reading small details."""
    pixel_box = box.pixels(img.width, img.height)
    crop = img.crop(pixel_box)
    if max(crop.size) < ZOOM_MIN_SIDE:
        scale = ZOOM_MIN_SIDE / max(crop.size)
        crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)
    crop = fit(crop, MODEL_MAX_SIDE)
    if enhance:
        crop = ImageOps.autocontrast(crop, cutoff=1)
        crop = crop.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=2))
        crop = ImageEnhance.Sharpness(crop).enhance(1.3)
    return crop, pixel_box

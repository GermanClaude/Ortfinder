import pytest
from PIL import Image

from ortfinder import imaging


def test_zoombox_clamps_and_sorts():
    box = imaging.ZoomBox.normalized(1.2, 0.8, -0.1, 0.2)
    assert (box.x_min, box.y_min, box.x_max, box.y_max) == (0.0, 0.2, 1.0, 0.8)


def test_tiny_box_grows_to_minimum_and_stays_inside():
    box = imaging.ZoomBox.normalized(0.999, 0.999, 1.0, 1.0)
    left, top, right, bottom = box.pixels(1000, 500)
    assert right - left == imaging.ZOOM_MIN_SOURCE_PX
    assert bottom - top == imaging.ZOOM_MIN_SOURCE_PX
    assert right <= 1000 and bottom <= 500 and left >= 0 and top >= 0


def test_zoom_upscales_small_crops():
    img = Image.new("RGB", (4000, 3000), "gray")
    crop, pixel_box = imaging.zoom(img, imaging.ZoomBox.normalized(0.5, 0.5, 0.52, 0.52), enhance=True)
    assert pixel_box == (2000, 1500, 2080, 1560)
    assert max(crop.size) == imaging.ZOOM_MIN_SIDE
    assert crop.size[0] / crop.size[1] == pytest.approx(80 / 60, rel=0.01)


def test_zoom_caps_large_crops():
    img = Image.new("RGB", (6000, 4000), "gray")
    crop, _ = imaging.zoom(img, imaging.ZoomBox.normalized(0, 0, 1, 1))
    assert max(crop.size) == imaging.MODEL_MAX_SIDE


def test_load_image_applies_exif_orientation():
    import io

    img = Image.new("RGB", (200, 100), "white")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° clockwise on display
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    assert imaging.load_image(buf.getvalue()).size == (100, 200)


def test_rgba_is_flattened():
    import io

    buf = io.BytesIO()
    Image.new("RGBA", (10, 10), (255, 0, 0, 0)).save(buf, "PNG")
    assert imaging.load_image(buf.getvalue()).mode == "RGB"


def test_grid_overlay_keeps_aspect():
    grid = imaging.with_grid(Image.new("RGB", (3000, 1500)), max_side=1024)
    assert grid.size == (1024, 512)

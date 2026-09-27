from conftest import make_jpeg

from ortfinder.metadata import extract_metadata, hints_for_model


def test_gps_is_extracted_with_hemisphere_signs():
    meta = extract_metadata(make_jpeg(gps=(-33.8568, 151.2153)))
    assert meta["has_exif"] is True
    assert meta["gps"]["lat"] == -33.8568
    assert meta["gps"]["lon"] == 151.2153


def test_zero_zero_gps_is_treated_as_missing():
    assert "gps" not in extract_metadata(make_jpeg(gps=(0.0, 0.0)))


def test_image_without_exif(jpeg):
    meta = extract_metadata(jpeg)
    assert "gps" not in meta
    assert meta["camera_make"] == "TestCam"


def test_unreadable_data_reports_error():
    assert "error" in extract_metadata(b"definitely not an image")


def test_hints_never_contain_gps():
    meta = extract_metadata(make_jpeg(gps=(48.1, 11.5), taken_at="2024:06:21 14:30:00"))
    hints = "\n".join(hints_for_model(meta))
    assert "2024:06:21 14:30:00" in hints
    assert "48.1" not in hints and "11.5" not in hints

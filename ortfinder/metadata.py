"""EXIF metadata extraction. Embedded GPS is by far the most precise location source."""

from __future__ import annotations

import io
from typing import Any

from PIL import Image

from .imaging import register_heif

_IFD_EXIF = 0x8769
_IFD_GPS = 0x8825

_TAG_DESCRIPTION = 0x010E
_TAG_MAKE = 0x010F
_TAG_MODEL = 0x0110
_TAG_SOFTWARE = 0x0131
_TAG_DATETIME = 0x0132
_TAG_DATETIME_ORIGINAL = 0x9003
_TAG_OFFSET_TIME_ORIGINAL = 0x9011
_TAG_LENS_MODEL = 0xA434

_GPS_LAT_REF = 1
_GPS_LAT = 2
_GPS_LON_REF = 3
_GPS_LON = 4
_GPS_ALT_REF = 5
_GPS_ALT = 6
_GPS_TIMESTAMP = 7
_GPS_IMG_DIRECTION = 17
_GPS_DATESTAMP = 29


def _to_float(value: Any) -> float:
    if isinstance(value, tuple) and len(value) == 2:
        num, den = value
        return float(num) / float(den) if den else 0.0
    return float(value)


def _dms_to_degrees(dms: Any, ref: Any) -> float | None:
    try:
        parts = [_to_float(v) for v in dms]
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if not parts:
        return None
    while len(parts) < 3:
        parts.append(0.0)
    degrees = parts[0] + parts[1] / 60.0 + parts[2] / 3600.0
    if isinstance(ref, bytes):
        ref = ref.decode("ascii", "ignore")
    if str(ref).strip().upper() in ("S", "W"):
        degrees = -degrees
    return degrees


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    text = str(value).replace("\x00", "").strip()
    return text or None


def _gps_time(gps: dict) -> str | None:
    date = _clean_str(gps.get(_GPS_DATESTAMP))
    stamp = gps.get(_GPS_TIMESTAMP)
    if not date or not stamp:
        return None
    try:
        h, m, s = (_to_float(v) for v in stamp)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return f"{date.replace(':', '-')}T{int(h):02d}:{int(m):02d}:{int(s):02d}Z"


def extract_metadata(data: bytes) -> dict[str, Any]:
    """Return camera, time and GPS information found in the image's EXIF block.

    Keys are only present when the value exists. ``gps`` holds ``lat``/``lon``
    (and optionally ``altitude_m`` / ``direction_deg``) in decimal degrees.
    """
    register_heif()
    result: dict[str, Any] = {}
    try:
        with Image.open(io.BytesIO(data)) as img:
            result["format"] = img.format
            result["width"], result["height"] = img.size
            exif = img.getexif()
    except Exception as exc:  # noqa: BLE001 - any decoder error means "no metadata"
        return {"error": f"Bild konnte nicht gelesen werden: {exc}"}

    if not exif:
        result["has_exif"] = False
        return result
    result["has_exif"] = True

    exif_ifd = exif.get_ifd(_IFD_EXIF)
    for key, tag, source in (
        ("camera_make", _TAG_MAKE, exif),
        ("camera_model", _TAG_MODEL, exif),
        ("software", _TAG_SOFTWARE, exif),
        ("description", _TAG_DESCRIPTION, exif),
        ("lens", _TAG_LENS_MODEL, exif_ifd),
        ("taken_at", _TAG_DATETIME_ORIGINAL, exif_ifd),
        ("utc_offset", _TAG_OFFSET_TIME_ORIGINAL, exif_ifd),
    ):
        value = _clean_str(source.get(tag))
        if value:
            result[key] = value
    if "taken_at" not in result:
        value = _clean_str(exif.get(_TAG_DATETIME))
        if value:
            result["taken_at"] = value

    gps = exif.get_ifd(_IFD_GPS)
    if gps:
        lat = _dms_to_degrees(gps.get(_GPS_LAT, ()), gps.get(_GPS_LAT_REF, "N"))
        lon = _dms_to_degrees(gps.get(_GPS_LON, ()), gps.get(_GPS_LON_REF, "E"))
        # (0, 0) is what some apps write when they have no fix.
        if lat is not None and lon is not None and not (lat == 0 and lon == 0):
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                entry: dict[str, Any] = {"lat": round(lat, 7), "lon": round(lon, 7)}
                if _GPS_ALT in gps:
                    try:
                        alt = _to_float(gps[_GPS_ALT])
                        ref = gps.get(_GPS_ALT_REF, 0)
                        if ref in (1, b"\x01"):
                            alt = -alt
                        entry["altitude_m"] = round(alt, 1)
                    except (TypeError, ValueError, ZeroDivisionError):
                        pass
                if _GPS_IMG_DIRECTION in gps:
                    try:
                        entry["direction_deg"] = round(_to_float(gps[_GPS_IMG_DIRECTION]), 1)
                    except (TypeError, ValueError, ZeroDivisionError):
                        pass
                result["gps"] = entry
        gps_time = _gps_time(gps)
        if gps_time:
            result["gps_time_utc"] = gps_time
    return result


def hints_for_model(metadata: dict[str, Any]) -> list[str]:
    """Non-GPS metadata that is useful context (time for sun/shadow checks, camera model)."""
    hints = []
    if metadata.get("taken_at"):
        stamp = metadata["taken_at"]
        if metadata.get("utc_offset"):
            stamp += f" (UTC-Offset {metadata['utc_offset']})"
        hints.append(f"Aufnahmezeit laut EXIF (Ortszeit der Kamera): {stamp}")
    if metadata.get("gps_time_utc"):
        hints.append(f"GPS-Zeitstempel (UTC): {metadata['gps_time_utc']}")
    camera = " ".join(filter(None, (metadata.get("camera_make"), metadata.get("camera_model"))))
    if camera:
        hints.append(f"Kamera: {camera}")
    if metadata.get("software"):
        hints.append(f"Software: {metadata['software']}")
    if metadata.get("description"):
        hints.append(f"Bildbeschreibung im EXIF: {metadata['description']}")
    return hints

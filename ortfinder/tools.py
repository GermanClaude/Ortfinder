"""Tools the geolocation agent can call, plus their local implementations."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Callable

from PIL import Image

from . import imaging
from .geo import OSMClient, OSMError, sun_position

PRECISION_LEVELS = ["exakt", "strasse", "stadtteil", "stadt", "region", "land", "kontinent", "unbekannt"]
CLUE_CATEGORIES = [
    "text", "sprache", "schild", "strasse", "kennzeichen", "architektur", "vegetation", "landschaft",
    "klima", "sonne", "infrastruktur", "fahrzeug", "marke", "innenraum", "wahrzeichen", "kultur", "sonstiges",
]


def _obj(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


_LOCATION = {
    "name": {"type": "string", "description": "Ortsbezeichnung, so genau wie begründbar"},
    "lat": {"type": "number"},
    "lon": {"type": "number"},
    "radius_km": {"type": "number", "description": "Unsicherheitsradius um den Punkt in km"},
    "confidence": {"type": "number", "description": "Wahrscheinlichkeit 0.0-1.0, dass der Ort im Radius liegt"},
}

SUBMIT_TOOL = "submit_result"

CLIENT_TOOLS: list[dict[str, Any]] = [
    {
        "name": "zoom_image",
        "description": (
            "Schneidet einen Bereich aus dem Originalbild in voller Auflösung aus und vergrößert ihn. "
            "Nutze das für jedes kleine Detail: Schrift, Schilder, Kennzeichen, Logos, Hausnummern, "
            "entfernte Gebäude oder Berge, Pflanzen, Steckdosen, Blick aus Fenstern. Koordinaten sind "
            "Anteile der Bildbreite/-höhe (0.0 = links/oben, 1.0 = rechts/unten), siehe Raster-Bild. "
            "Mehrere Zooms in einer Antwort sind erlaubt und erwünscht."
        ),
        "strict": True,
        "input_schema": _obj({
            "x_min": {"type": "number"},
            "y_min": {"type": "number"},
            "x_max": {"type": "number"},
            "y_max": {"type": "number"},
            "enhance": {"type": "boolean", "description": "Kontrast/Schärfe anheben (hilft bei dunkler oder verwaschener Schrift)"},
            "purpose": {"type": "string", "description": "Was du dort zu erkennen hoffst"},
        }),
    },
    {
        "name": "geocode",
        "description": (
            "Sucht Orte, Straßen, Adressen, Geschäfte oder Wahrzeichen in OpenStreetMap (Nominatim) "
            "und liefert Koordinaten. Beispiele: 'Bäckerei Müller, Bahnhofstraße, Freiburg', "
            "'Hauptstraße 12, 79098 Freiburg', 'Kirche St. Martin Landshut'."
        ),
        "strict": True,
        "input_schema": _obj({
            "query": {"type": "string"},
            "country_codes": {"type": "string", "description": "Kommagetrennte ISO-3166-1 alpha-2 Codes zum Eingrenzen, z.B. 'de,at' - oder leer"},
            "limit": {"type": "integer", "description": "1-10"},
        }),
    },
    {
        "name": "reverse_geocode",
        "description": "Liefert Adresse/Ortsname zu Koordinaten. Nutze es, um einen Kandidatenpunkt zu prüfen.",
        "strict": True,
        "input_schema": _obj({
            "lat": {"type": "number"},
            "lon": {"type": "number"},
            "zoom": {"type": "integer", "description": "3 (Land) bis 18 (Gebäude)"},
        }),
    },
    {
        "name": "overpass_query",
        "description": (
            "Führt eine Overpass-QL-Abfrage auf OpenStreetMap aus, um Hypothesen zu verifizieren oder "
            "Orte mit Merkmals-Kombinationen zu finden (z.B. Apotheke mit Namen X in Stadt Y, "
            "Bushaltestelle namens Z, Straße X nahe Straße Y). Immer mit Gebiets- oder around-Filter "
            "und begrenzter Ausgabe, z.B.:\n"
            '[out:json][timeout:25];area["ISO3166-1"="DE"][admin_level=2]->.a;'
            'nwr["shop"="bakery"]["name"~"Müller",i](area.a);out center 30;\n'
            '[out:json][timeout:25];way["highway"]["name"="Lindenweg"](around:3000,48.13,11.57);out center 20;'
        ),
        "strict": True,
        "input_schema": _obj({
            "query": {"type": "string"},
            "purpose": {"type": "string"},
        }),
    },
    {
        "name": "sun_position",
        "description": (
            "Berechnet Sonnenstand (Azimut ab Norden im Uhrzeigersinn, Höhe) für Ort und UTC-Zeit, "
            "inkl. Schattenrichtung und Schattenlänge pro Meter Objekthöhe. Nützlich, um Schatten im Bild "
            "gegen Kandidatenorte zu prüfen, wenn die Aufnahmezeit bekannt oder eingrenzbar ist."
        ),
        "strict": True,
        "input_schema": _obj({
            "lat": {"type": "number"},
            "lon": {"type": "number"},
            "datetime_utc": {"type": "string", "description": "ISO 8601, z.B. 2024-06-21T14:30:00Z"},
        }),
    },
    {
        "name": SUBMIT_TOOL,
        "description": "Gibt das Endergebnis ab. Genau einmal am Ende aufrufen. Alle Texte auf Deutsch.",
        "strict": True,
        "input_schema": _obj({
            "summary": {"type": "string", "description": "2-5 Sätze: wo, und die entscheidenden Belege"},
            "precision": {"type": "string", "enum": PRECISION_LEVELS},
            "country": {"type": "string"},
            "region": {"type": "string"},
            "city": {"type": "string"},
            "best_guess": _obj(_LOCATION),
            "candidates": {
                "type": "array",
                "description": "Alternative Orte (ohne best_guess), absteigend nach Wahrscheinlichkeit, max. 5",
                "items": _obj({**_LOCATION, "rationale": {"type": "string"}}),
            },
            "clues": {
                "type": "array",
                "description": "Alle verwerteten Hinweise",
                "items": _obj({
                    "category": {"type": "string", "enum": CLUE_CATEGORIES},
                    "description": {"type": "string", "description": "Was im Bild zu sehen ist"},
                    "implication": {"type": "string", "description": "Was das über den Ort verrät"},
                    "strength": {"type": "string", "enum": ["stark", "mittel", "schwach"]},
                    "box": {
                        "type": "array",
                        "items": {"type": "number"},
                        "description": "[x_min, y_min, x_max, y_max] in 0-1 Bildkoordinaten, oder [] wenn nicht lokalisierbar",
                    },
                }),
            },
            "text_found": {"type": "array", "items": {"type": "string"}, "description": "Alle im Bild gelesenen Texte"},
            "verification": {"type": "string", "description": "Was mit Karten-/Websuche bestätigt oder widerlegt wurde"},
        }),
    },
]


def build_tools(web_search: bool, web_search_max_uses: int) -> list[dict[str, Any]]:
    tools = list(CLIENT_TOOLS)
    if web_search:
        tools.append({"type": "web_search_20260209", "name": "web_search", "max_uses": web_search_max_uses})
    return tools


class ToolInputError(ValueError):
    pass


def _num(inp: dict[str, Any], key: str, lo: float | None = None, hi: float | None = None) -> float:
    value = inp.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ToolInputError(f"'{key}' muss eine Zahl sein")
    if (lo is not None and value < lo) or (hi is not None and value > hi):
        raise ToolInputError(f"'{key}' muss zwischen {lo} und {hi} liegen")
    return float(value)


def _str(inp: dict[str, Any], key: str, required: bool = True) -> str:
    value = inp.get(key, "")
    if not isinstance(value, str):
        raise ToolInputError(f"'{key}' muss ein Text sein")
    if required and not value.strip():
        raise ToolInputError(f"'{key}' darf nicht leer sein")
    return value


def _parse_utc(value: str) -> datetime:
    text = value.strip().replace("Z", "+00:00")
    try:
        when = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ToolInputError("'datetime_utc' ist kein ISO-8601-Zeitpunkt") from exc
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(timezone.utc)


def _clamp01(value: Any) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return min(max(v, 0.0), 1.0) if math.isfinite(v) else 0.0


def _clean_location(loc: Any, field: str) -> dict[str, Any]:
    if not isinstance(loc, dict):
        raise ToolInputError(f"'{field}' fehlt")
    lat = _num(loc, "lat", -90, 90)
    lon = _num(loc, "lon", -180, 180)
    radius = loc.get("radius_km")
    radius = float(radius) if isinstance(radius, (int, float)) and math.isfinite(radius) and radius > 0 else 50.0
    cleaned = {
        "name": str(loc.get("name") or "").strip() or "Unbenannter Ort",
        "lat": lat,
        "lon": lon,
        "radius_km": round(min(radius, 20000.0), 3),
        "confidence": round(_clamp01(loc.get("confidence")), 3),
    }
    if "rationale" in loc:
        cleaned["rationale"] = str(loc.get("rationale") or "")
    return cleaned


def validate_submission(inp: dict[str, Any]) -> dict[str, Any]:
    """Check and normalize a submit_result payload. Raises ToolInputError with a fixable message."""
    if not isinstance(inp, dict):
        raise ToolInputError("Eingabe muss ein Objekt sein")
    precision = inp.get("precision")
    if precision not in PRECISION_LEVELS:
        raise ToolInputError(f"'precision' muss einer von {PRECISION_LEVELS} sein")
    result = {
        "summary": _str(inp, "summary"),
        "precision": precision,
        "country": str(inp.get("country") or ""),
        "region": str(inp.get("region") or ""),
        "city": str(inp.get("city") or ""),
        "best_guess": _clean_location(inp.get("best_guess"), "best_guess"),
        "candidates": [],
        "clues": [],
        "text_found": [str(t) for t in inp.get("text_found") or [] if str(t).strip()],
        "verification": str(inp.get("verification") or ""),
    }
    for i, cand in enumerate(inp.get("candidates") or []):
        try:
            result["candidates"].append(_clean_location(cand, f"candidates[{i}]"))
        except ToolInputError:
            continue  # a broken alternative should not block the whole answer
    result["candidates"] = result["candidates"][:5]
    for clue in inp.get("clues") or []:
        if not isinstance(clue, dict):
            continue
        box = clue.get("box") or []
        if isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box):
            zb = imaging.ZoomBox.normalized(*box)
            box = [round(zb.x_min, 4), round(zb.y_min, 4), round(zb.x_max, 4), round(zb.y_max, 4)]
        else:
            box = []
        result["clues"].append({
            "category": clue.get("category") if clue.get("category") in CLUE_CATEGORIES else "sonstiges",
            "description": str(clue.get("description") or ""),
            "implication": str(clue.get("implication") or ""),
            "strength": clue.get("strength") if clue.get("strength") in ("stark", "mittel", "schwach") else "mittel",
            "box": box,
        })
    return result


Emit = Callable[[str, dict[str, Any]], None]


class ToolExecutor:
    """Runs client-side tools against one uploaded image."""

    def __init__(self, image: Image.Image, osm: OSMClient, emit: Emit):
        self.image = image
        self.osm = osm
        self.emit = emit
        self.zoom_count = 0

    def run(self, name: str, inp: Any) -> tuple[list[dict[str, Any]] | str, bool]:
        """Return (tool_result content, is_error)."""
        if not isinstance(inp, dict):
            return json.dumps({"INVALID_INPUT": repr(inp)[:500]}), True
        handler = getattr(self, f"_tool_{name}", None)
        if handler is None:
            return f"Unbekanntes Werkzeug: {name}", True
        try:
            return handler(inp), False
        except ToolInputError as exc:
            return f"Ungültige Eingabe: {exc}", True
        except OSMError as exc:
            return str(exc), True
        except Exception as exc:  # noqa: BLE001 - report network/decoder failures back to the model
            return f"Fehler bei {name}: {type(exc).__name__}: {exc}", True

    def _tool_zoom_image(self, inp: dict[str, Any]) -> list[dict[str, Any]]:
        box = imaging.ZoomBox.normalized(
            _num(inp, "x_min"), _num(inp, "y_min"), _num(inp, "x_max"), _num(inp, "y_max")
        )
        if box.x_max - box.x_min <= 0 or box.y_max - box.y_min <= 0:
            raise ToolInputError("Der Bereich hat keine Fläche (x_max > x_min und y_max > y_min nötig)")
        crop, (left, top, right, bottom) = imaging.zoom(self.image, box, enhance=bool(inp.get("enhance")))
        self.zoom_count += 1
        self.emit("zoom", {
            "index": self.zoom_count,
            "box": [box.x_min, box.y_min, box.x_max, box.y_max],
            "purpose": str(inp.get("purpose") or ""),
            "thumbnail": "data:image/jpeg;base64," + imaging.to_jpeg_b64(crop, max_side=360, quality=80),
        })
        info = (
            f"Ausschnitt x {box.x_min:.3f}-{box.x_max:.3f}, y {box.y_min:.3f}-{box.y_max:.3f} "
            f"= {right - left}x{bottom - top} Originalpixel, vergrößert auf {crop.width}x{crop.height}."
        )
        return [{"type": "text", "text": info}, imaging.image_block(crop)]

    def _tool_geocode(self, inp: dict[str, Any]) -> str:
        limit = inp.get("limit") if isinstance(inp.get("limit"), int) else 5
        results = self.osm.geocode(_str(inp, "query"), _str(inp, "country_codes", required=False), limit)
        if not results:
            return "Keine Treffer. Anders formulieren, Land eingrenzen oder Overpass/Websuche nutzen."
        return json.dumps(results, ensure_ascii=False)

    def _tool_reverse_geocode(self, inp: dict[str, Any]) -> str:
        zoom = inp.get("zoom") if isinstance(inp.get("zoom"), int) else 18
        return json.dumps(self.osm.reverse(_num(inp, "lat", -90, 90), _num(inp, "lon", -180, 180), zoom), ensure_ascii=False)

    def _tool_overpass_query(self, inp: dict[str, Any]) -> str:
        return json.dumps(self.osm.overpass(_str(inp, "query")), ensure_ascii=False)

    def _tool_sun_position(self, inp: dict[str, Any]) -> str:
        when = _parse_utc(_str(inp, "datetime_utc"))
        pos = sun_position(_num(inp, "lat", -90, 90), _num(inp, "lon", -180, 180), when)
        return json.dumps({"datetime_utc": when.isoformat(), **pos})

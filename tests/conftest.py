from __future__ import annotations

import io
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image, ImageDraw

from ortfinder.config import Settings


def make_jpeg(gps: tuple[float, float] | None = None, size=(800, 600), taken_at: str | None = None) -> bytes:
    img = Image.new("RGB", size, (90, 140, 200))
    draw = ImageDraw.Draw(img)
    draw.rectangle([600, 400, 640, 420], fill="white")
    draw.text((602, 404), "Bahnhofstr.", fill="black")
    exif = Image.Exif()
    exif[0x010F] = "TestCam"
    if taken_at:
        exif.get_ifd(0x8769)[0x9003] = taken_at
    if gps:
        lat, lon = gps
        exif.get_ifd(0x8825).update({
            1: "N" if lat >= 0 else "S", 2: (abs(lat), 0.0, 0.0),
            3: "E" if lon >= 0 else "W", 4: (abs(lon), 0.0, 0.0),
        })
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


def settings(**overrides: Any) -> Settings:
    base = dict(
        model="claude-opus-5", effort="high", max_steps=6, web_search=True, web_search_max_uses=5,
        contact="test", nominatim_url="https://nominatim.invalid", overpass_url="https://overpass.invalid",
    )
    base.update(overrides)
    return Settings(**base)


class FakeOSM:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def geocode(self, query: str, country_codes: str = "", limit: int = 5):
        self.calls.append(("geocode", query, country_codes, limit))
        return [{"name": f"{query}, Deutschland", "lat": 47.99, "lon": 7.85, "kind": "highway/residential", "importance": 0.4, "boundingbox": None}]

    def reverse(self, lat: float, lon: float, zoom: int = 18):
        self.calls.append(("reverse", lat, lon, zoom))
        return {"name": "Bahnhofstraße 1, Freiburg", "address": {}, "kind": "building/yes"}

    def overpass(self, query: str):
        self.calls.append(("overpass", query))
        return {"total": 1, "elements": [{"type": "node", "id": 1, "lat": 47.99, "lon": 7.85, "tags": {"name": "Test"}}]}


def tool_use(id_: str, name: str, input_: dict) -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=input_)


def text(t: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=t)


def response(content: list, stop_reason: str) -> SimpleNamespace:
    usage = SimpleNamespace(input_tokens=100, output_tokens=50, cache_read_input_tokens=10, cache_creation_input_tokens=5)
    return SimpleNamespace(content=content, stop_reason=stop_reason, usage=usage)


class FakeClient:
    """Stands in for anthropic.Anthropic(); returns scripted responses and records requests."""

    def __init__(self, responses: list) -> None:
        self._responses = list(responses)
        self.requests: list[dict] = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        # Snapshot messages: the agent keeps appending to the same list.
        self.requests.append({**kwargs, "messages": list(kwargs["messages"])})
        return self._responses.pop(0)


VALID_SUBMISSION = {
    "summary": "Freiburg im Breisgau, Bahnhofstraße.",
    "precision": "strasse",
    "country": "Deutschland",
    "region": "Baden-Württemberg",
    "city": "Freiburg",
    "best_guess": {"name": "Bahnhofstraße, Freiburg", "lat": 47.99, "lon": 7.85, "radius_km": 0.3, "confidence": 0.8},
    "candidates": [{"name": "Offenburg", "lat": 48.47, "lon": 7.94, "radius_km": 5, "confidence": 0.1, "rationale": "ähnlich"}],
    "clues": [{"category": "schild", "description": "Straßenschild", "implication": "Deutschland", "strength": "stark", "box": [0.75, 0.66, 0.8, 0.7]}],
    "text_found": ["Bahnhofstr."],
    "verification": "Straße per geocode bestätigt.",
}


@pytest.fixture
def jpeg() -> bytes:
    return make_jpeg()

"""End-to-end test of the static website (docs/) in a real Chromium.

Gemini, Nominatim and the map tiles are intercepted, so no API key or internet is needed.
Skipped when Playwright/Chromium is not installed.
"""

from __future__ import annotations

import base64
import functools
import glob
import io
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

playwright_api = pytest.importorskip("playwright.sync_api")

DOCS = Path(__file__).resolve().parent.parent / "docs"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
PNG_1X1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")

SUBMISSION = {
    "summary": "Deutsches Straßenschild, per Ortssuche in Freiburg bestätigt.",
    "precision": "strasse",
    "country": "Deutschland",
    "region": "Baden-Württemberg",
    "city": "Freiburg",
    "best_guess": {"name": "Bahnhofstraße, Freiburg", "lat": 47.99, "lon": 7.85, "radius_km": 0.3, "confidence": 0.8},
    "candidates": [{"name": "Offenburg", "lat": 48.47, "lon": 7.94, "radius_km": 5, "confidence": 0.1, "rationale": "ähnliche Beschilderung"}],
    "clues": [
        {"category": "verkehrszeichen", "description": "Straßenschild „Bahnhofstraße“", "implication": "deutschsprachiger Raum", "strength": "stark", "box": [0.68, 0.63, 0.93, 0.73]},
        {"category": "menschen", "description": "Person mit Trikot", "implication": "Fußballverein aus Südbaden", "strength": "mittel", "box": [0.1, 0.5, 0.2, 0.9]},
    ],
    "text_found": ["Bahnhofstraße"],
    "verification": "geocode fand die Bahnhofstraße in Freiburg.",
}


def _interaction(steps, status="requires_action"):
    return {"id": "", "status": status, "steps": steps, "usage": {"total_input_tokens": 3000, "total_output_tokens": 200, "total_thought_tokens": 100, "total_cached_tokens": 0}}


GEMINI_SCRIPT = [
    _interaction([
        {"type": "thought", "signature": "c2ln", "summary": [{"type": "text", "text": "Schild unten rechts – zoomen."}]},
        {"type": "function_call", "id": "c1", "name": "zoom_image", "arguments": {"x_min": 0.66, "y_min": 0.6, "x_max": 0.95, "y_max": 0.76, "enhance": True, "purpose": "Straßenschild lesen"}},
        {"type": "function_call", "id": "c2", "name": "geocode", "arguments": {"query": "Bahnhofstraße Freiburg", "country_codes": "de"}},
    ]),
    _interaction([{"type": "function_call", "id": "c3", "name": "submit_result", "arguments": SUBMISSION}]),
]


def _street_jpeg(path: Path) -> None:
    img = Image.new("RGB", (1600, 1000), (170, 200, 230))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 650, 1600, 1000], fill=(90, 90, 95))
    d.rectangle([1100, 640, 1480, 720], fill="white", outline="black", width=4)
    d.text((1130, 670), "Bahnhofstrasse", fill="black")
    img.save(path, quality=90)


@pytest.fixture(scope="module")
def site_url():
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(DOCS))
    handler.log_message = lambda *a, **k: None
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


@pytest.fixture(scope="module")
def browser():
    with playwright_api.sync_playwright() as p:
        candidates = [os.environ.get("CHROMIUM_PATH")] + sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"))
        try:
            b = p.chromium.launch()
        except Exception:
            path = next((c for c in candidates if c and os.path.exists(c)), None)
            if not path:
                pytest.skip("Chromium für Playwright nicht installiert")
            b = p.chromium.launch(executable_path=path)
        yield b
        b.close()


def _mock_network(page, gemini_bodies: list):
    script = list(GEMINI_SCRIPT)

    def gemini(route):
        gemini_bodies.append(json.loads(route.request.post_data))
        route.fulfill(status=200, content_type="application/json", body=json.dumps(script.pop(0)))

    def nominatim(route):
        if "/reverse" in route.request.url:
            body = {"display_name": "Avenue Gustave Eiffel, Paris, Frankreich", "address": {}, "category": "highway", "type": "residential"}
        else:
            body = [{"display_name": "Bahnhofstraße, Freiburg im Breisgau", "lat": "47.99", "lon": "7.85", "category": "highway", "type": "residential", "importance": 0.3}]
        route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(body))

    page.route("https://generativelanguage.googleapis.com/**", gemini)
    page.route("https://nominatim.openstreetmap.org/**", nominatim)
    page.route("https://tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="image/png", body=PNG_1X1))


def test_website_end_to_end(browser, site_url, tmp_path):
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    gemini_bodies: list[dict] = []
    _mock_network(page, gemini_bodies)

    page.goto(site_url)
    # First visit: the tool (upload area) is up front, with a compact key field; settings stay closed.
    assert page.is_visible("#drop") and page.is_visible("#demo")
    assert page.is_visible("#key-bar")
    assert not page.is_visible("#settings")
    page.fill("#api-key", "123456789012")
    assert "Projektnummer" in page.text_content("#key-hint")
    page.fill("#api-key", "AIza" + "x" * 35)  # older standard key format
    assert "aistudio.google.com" in page.text_content("#key-hint")
    page.fill("#api-key", "AQ.Ab8" + "x" * 45)  # current auth key format
    assert "aistudio.google.com" in page.text_content("#key-hint")
    page.click("#save-key")
    assert not page.is_visible("#key-bar")
    assert "gemini-3.8-flash" in page.text_content("#settings-toggle")

    page.set_input_files("#file", str(street))
    page.wait_for_selector(".answer", timeout=30000)
    assert page.text_content(".answer") == "Bahnhofstraße, Freiburg"
    assert page.locator(".zooms figure").count() == 1
    assert page.locator(".box.clue").count() == 2
    assert page.locator(".leaflet-interactive").count() >= 2
    log = page.text_content("#log")
    assert "Schild unten rechts" in log and "Ortssuche" in log

    first, second = gemini_bodies
    assert first["store"] is False and first["model"] == "gemini-3.8-flash"
    content = first["input"][0]["content"]
    assert [c["type"] for c in content] == ["text", "image", "image"]
    assert base64.b64decode(content[1]["data"])[:2] == b"\xff\xd8"  # real JPEG from the canvas
    zoom_result = next(s for s in second["input"] if s["type"] == "function_result" and s["name"] == "zoom_image")
    zoom_image = Image.open(io.BytesIO(base64.b64decode(zoom_result["result"][1]["data"])))
    assert max(zoom_image.size) >= 1024  # the crop was upscaled for reading small details

    # The key is remembered across reloads (localStorage).
    page.reload()
    assert not page.is_visible("#key-bar")

    # EXIF-only run: GPS from metadata, no Gemini call.
    page.click("#settings-toggle")
    page.uncheck("#use-ai")
    page.click("#save-settings")
    page.set_input_files("#file", str(FIXTURES / "gps.jpg"))
    page.wait_for_selector(".badge.exif", timeout=15000)
    assert "Avenue Gustave Eiffel" in page.text_content("#result")
    assert len(gemini_bodies) == 2

    # HEIC (iPhone): Chromium can't decode it natively, so heic2any converts it; GPS comes from EXIF.
    page.set_input_files("#file", str(FIXTURES / "gps.heic"))
    page.wait_for_function("document.querySelector('#result').textContent.includes('47.990000')", timeout=60000)
    page.wait_for_function("document.querySelector('#photo').naturalWidth === 1600", timeout=60000)
    assert errors == []
    context.close()


def test_root_redirects_to_the_app(site_url):
    """GitHub Pages serving the repository root must land on the app, not on a rendered README."""
    root = DOCS.parent / "index.html"
    assert 'url=docs/' in root.read_text()
    assert (DOCS.parent / ".nojekyll").exists() and (DOCS / ".nojekyll").exists()


def test_example_runs_without_api_key(browser, site_url):
    """'Beispiel ansehen' replays a recorded real analysis, so visitors see the tool working without a key."""
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("https://tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="image/png", body=PNG_1X1))
    page.route("https://generativelanguage.googleapis.com/**", lambda r: (_ for _ in ()).throw(AssertionError("demo must not call Gemini")))
    page.goto(site_url)
    page.click("#demo")
    assert page.is_visible("#demo-banner")
    page.wait_for_selector(".answer", timeout=60000)
    demo = json.loads((DOCS / "demo" / "beispiel.json").read_text())
    assert page.text_content(".answer") == next(e for e in demo["events"] if e["type"] == "result")["data"]["analysis"]["best_guess"]["name"]
    assert "Tatsächlicher Aufnahmeort" in page.text_content("#result")
    assert page.locator(".zooms figure").count() >= 1
    assert page.evaluate("document.querySelector('#photo').naturalWidth") > 0
    assert errors == []
    context.close()

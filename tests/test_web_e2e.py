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
import math
import os
import threading
import urllib.parse
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
    "camera": {"name": "Bahnhofstraße, Freiburg", "lat": 47.99, "lon": 7.85, "radius_km": 0.3, "confidence": 0.8},
    "subject": {"name": "Martinstor", "lat": 47.9925, "lon": 7.8495, "radius_km": 0.05},
    "view": {"bearing_deg": 352, "fov_deg": 65, "distance_m": 280},
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
        {"type": "function_call", "id": "c2b", "name": "mark_hypothesis", "arguments": {"label": "Vermutung: Südbaden", "camera_lat": 47.99, "camera_lon": 7.85, "radius_km": 30}},
        {"type": "function_call", "id": "c2c", "name": "map_view", "arguments": {"lat": 47.99, "lon": 7.85, "zoom": 18, "layer": "satellit", "purpose": "Kreuzung vergleichen"}},
        {"type": "function_call", "id": "c2d", "name": "render_view", "arguments": {"lat": 47.99, "lon": 7.85, "bearing_deg": 352, "fov_deg": 65, "purpose": "Straßenflucht prüfen"}},
        {"type": "function_call", "id": "c2e", "name": "top_view", "arguments": {"camera_lat": 47.99, "camera_lon": 7.85, "bearing_deg": 352, "fov_deg": 65, "pitch_deg": -8, "eye_height_m": 6, "max_distance_m": 300, "purpose": "Straße von oben"}},
        {"type": "function_call", "id": "c2f", "name": "solve_camera", "arguments": {"camera_lat": 47.99, "camera_lon": 7.85, "eye_height_m": 1.6, "points": [
            {"x": 0.2, "y": 0.8, "lat": 47.99020, "lon": 7.84990, "label": "Bordstein links"},
            {"x": 0.8, "y": 0.8, "lat": 47.99020, "lon": 7.85010, "label": "Bordstein rechts"},
            {"x": 0.45, "y": 0.62, "lat": 47.99100, "lon": 7.84995, "label": "Laterne"},
            {"x": 0.6, "y": 0.6, "lat": 47.99150, "lon": 7.85010, "label": "Hausecke"},
        ]}},
        {"type": "function_call", "id": "c2g", "name": "render_view", "arguments": {"lat": 47.99, "lon": 7.85, "bearing_deg": 352, "fov_deg": 65, "texture": "satellit", "purpose": "Luftbild-3D"}},
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


def _scene_json() -> dict:
    """OSM data for a street running north from the camera, lined with houses, a 40 m tower at its end."""
    lat0, lon0 = 47.99, 7.85
    ky = 111195.0
    kx = ky * math.cos(math.radians(lat0))

    def ll(x, y):
        return {"lat": lat0 + y / ky, "lon": lon0 + x / kx}

    def box(i, x0, y0, x1, y1, tags):
        return {"type": "way", "id": i, "tags": tags, "geometry": [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]}

    elements = []
    for n, y in enumerate(range(10, 230, 36)):
        elements.append(box(2 * n + 1, -28, y, -9, y + 28, {"building": "yes", "building:levels": "4"}))
        elements.append(box(2 * n + 2, 9, y, 28, y + 28, {"building": "yes", "height": "15"}))
    elements.append(box(100, -45, 270, -29, 286, {"building": "tower", "height": "40", "name": "Martinstor"}))
    elements.append({"type": "way", "id": 200, "tags": {"highway": "residential"}, "geometry": [ll(0, -20), ll(0, 300)]})
    elements.append({"type": "node", "id": 300, **ll(-6, 40), "tags": {"natural": "tree"}})
    return {"elements": elements}


def _terrain_png() -> bytes:
    """A Terrarium tile of flat ground at 278 m: 278 + 32768 = 129·256 + 22."""
    buf = io.BytesIO()
    Image.new("RGB", (256, 256), (129, 22, 0)).save(buf, format="PNG")
    return buf.getvalue()


def _mock_scene(page, overpass_queries: list | None = None):
    """Overpass (buildings) and the elevation tiles for the 3D reconstruction and the visible area."""
    scene = json.dumps(_scene_json())
    terrain = _terrain_png()

    def overpass(route):
        if overpass_queries is not None:
            overpass_queries.append(route.request.post_data)
        route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=scene)

    page.route("**/api/interpreter", overpass)
    page.route(
        "https://s3.amazonaws.com/elevation-tiles-prod/**",
        lambda r: r.fulfill(status=200, content_type="image/png", headers={"Access-Control-Allow-Origin": "*"}, body=terrain),
    )
    _no_swisstopo(page)


def _no_swisstopo(page):
    """Scenes near Switzerland ask swisstopo for exact heights; the tests keep their synthetic terrain."""
    page.route("https://api3.geo.admin.ch/**", lambda r: r.fulfill(status=404, headers={"Access-Control-Allow-Origin": "*"}, body=""))


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
    # Aerial tiles need a CORS header, otherwise the canvas cannot be exported for the AI.
    page.route(
        "https://server.arcgisonline.com/**",
        lambda r: r.fulfill(status=200, content_type="image/png", headers={"Access-Control-Allow-Origin": "*"}, body=PNG_1X1),
    )
    _mock_scene(page)


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
    # First visit: the tool (upload area) is up front; the default provider (Puter) needs no key.
    assert page.is_visible("#drop") and page.is_visible("#pick")
    assert page.is_visible("#puter-note") and not page.is_visible("#key-bar")
    assert not page.is_visible("#settings")
    assert "Puter" in page.text_content("#settings-toggle")
    # Switch to the own-Gemini-key provider: the key field appears.
    page.click("#settings-toggle")
    page.select_option("#provider", "gemini")
    assert page.is_visible("#key-bar") and not page.is_visible("#puter-note")
    page.click("#save-settings")
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
    answers = page.locator(".answer").all_text_contents()
    assert answers == ["Bahnhofstraße, Freiburg", "Martinstor"]  # standpoint and motif
    assert "Blick nach N" in page.text_content("#result")
    # photo zoom, aerial view, 3D reconstruction, top view, top view from solve_camera, aerial 3D
    assert page.locator(".zooms figure").count() == 6
    assert "Luftbild: Kreuzung vergleichen" in page.text_content(".zooms figure.mapview")
    assert "3D-Nachbau: Straßenflucht prüfen" in page.text_content(".zooms figure.render")
    assert "Draufsicht: Straße von oben" in page.text_content(".zooms")
    log_now = page.text_content("#log")
    assert "Draufsicht: Foto auf das Gelände geklappt, Blick 352°" in log_now
    assert "Rückwärtsschnitt aus 4 Punkten" in log_now
    # After the result: exact visible area on the map and the photo/3D overlay in the result card.
    page.wait_for_selector("#compare-slot .compare img.compare-render", timeout=30000)
    page.wait_for_function("document.querySelector('#log').textContent.includes('Sichtbereich berechnet')", timeout=30000)
    log_text = page.text_content("#log")
    assert "Geländemodell" in log_text and "sichtbar ab" in log_text
    assert page.locator("#compare-slot .compare-slider input").count() == 1
    # The photo laid flat on the map (image overlay) with the side-by-side comparison.
    page.wait_for_selector("#topview-slot img.topview-img", timeout=30000)
    assert page.locator(".leaflet-image-layer").count() == 1
    page.uncheck("#topview-toggle")
    assert page.locator(".leaflet-image-layer").count() == 0
    page.check("#topview-toggle")
    assert page.locator(".leaflet-image-layer").count() == 1
    if os.environ.get("ORTFINDER_SHOTS"):
        page.wait_for_timeout(2500)
        page.screenshot(path=os.path.join(os.environ["ORTFINDER_SHOTS"], "e2e-result.png"), full_page=True)
    assert page.locator(".box.clue").count() == 2
    # Map: camera and subject pins plus view cone / areas.
    assert page.locator(".pin-camera").count() == 1 and page.locator(".pin-subject").count() == 1
    assert page.locator("path.leaflet-interactive").count() >= 3
    # Clue gallery: one card per clue, with a crop from the photo for located clues.
    assert page.locator("#clues-card").is_visible()
    assert page.locator(".clue-card").count() == 2
    assert page.locator(".clue-card img").first.get_attribute("src").startswith("data:image/jpeg")
    log = page.text_content("#log")
    assert "Schild unten rechts" in log and "Ortssuche" in log and "Zwischenstand: Vermutung: Südbaden" in log

    first, second = gemini_bodies
    assert first["store"] is False and first["model"] == "gemini-3.8-flash"
    content = first["input"][0]["content"]
    # One picture: the photo with the 0–1 ruler in a margin (the separate grid image is gone).
    assert [c["type"] for c in content] == ["text", "image"]
    assert base64.b64decode(content[1]["data"])[:2] == b"\xff\xd8"  # real JPEG from the canvas
    ruler = Image.open(io.BytesIO(base64.b64decode(content[1]["data"])))
    assert ruler.size == (1600 + 44, 1000 + 44)
    # Later requests carry only the latest round's pictures; earlier ones become short notes.
    assert sum(1 for c in second["input"][0]["content"] if c["type"] == "image") == 1
    zoom_result = next(s for s in second["input"] if s["type"] == "function_result" and s["name"] == "zoom_image")
    zoom_image = Image.open(io.BytesIO(base64.b64decode(zoom_result["result"][1]["data"])))
    assert max(zoom_image.size) >= 1024  # the crop was upscaled for reading small details
    map_result = next(s for s in second["input"] if s["type"] == "function_result" and s["name"] == "map_view")
    assert "is_error" not in map_result, map_result["result"]
    assert "Luftbild um 47.990000, 7.850000" in map_result["result"][0]["text"]
    assert Image.open(io.BytesIO(base64.b64decode(map_result["result"][1]["data"]))).size == (768, 768)
    render_result = next(s for s in second["input"] if s["type"] == "function_result" and s["name"] == "render_view")
    assert "is_error" not in render_result, render_result["result"]
    render_text = render_result["result"][0]["text"]
    assert "Gebäude sichtbar" in render_text and "Boden am Standpunkt 278 m" in render_text, render_text
    render_image = Image.open(io.BytesIO(base64.b64decode(render_result["result"][1]["data"])))
    assert render_image.size == (768, 480)  # same aspect ratio as the 1600×1000 photo
    top_result = next(s for s in second["input"] if s["type"] == "function_result" and s["name"] == "top_view")
    assert "is_error" not in top_result, top_result["result"]
    top_text = top_result["result"][0]["text"]
    assert "Draufsicht vom Standpunkt 47.990000, 7.850000" in top_text and "Links: das Foto auf den Boden projiziert" in top_text, top_text
    top_image = Image.open(io.BytesIO(base64.b64decode(top_result["result"][1]["data"])))
    assert top_image.size[0] > top_image.size[1]  # two panels side by side
    solve_result = next(s for s in second["input"] if s["type"] == "function_result" and s["name"] == "solve_camera")
    assert "is_error" not in solve_result, solve_result["result"]
    # solve_camera: the pose as JSON plus the top view for that pose (one round fewer).
    assert [b["type"] for b in solve_result["result"]] == ["text", "image"], solve_result["result"]
    solved = json.loads(solve_result["result"][0]["text"])
    assert set(solved) >= {"camera", "view", "rms_pct_of_width", "points", "note"} and len(solved["points"]) == 4
    draped = [s for s in second["input"] if s["type"] == "function_result" and s["name"] == "render_view"][1]
    assert "Luftbild-3D" in draped["result"][0]["text"], draped["result"][0]["text"]

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
    assert 'location.replace("docs/anleitung.html" + location.search + location.hash)' in (DOCS.parent / "anleitung.html").read_text()
    assert (DOCS.parent / ".nojekyll").exists() and (DOCS / ".nojekyll").exists()


def _synthetic_recording() -> dict:
    """Test data in the format of docs/demo/beispiel.json (a real one comes from window.ortfinderLastRun)."""
    thumb = "data:image/png;base64," + base64.b64encode(PNG_1X1).decode()
    result = {"metadata": {"has_exif": False}, "model": "gemini-3.8-flash", "seconds": 42.0, "analysis": SUBMISSION,
              "usage": {"requests": 2, "input_tokens": 6000, "output_tokens": 400, "thought_tokens": 200, "cached_tokens": 0},
              "final": {"source": "visual_analysis", **SUBMISSION["camera"], "precision": "strasse"}}
    return {
        "model": "gemini-3.8-flash", "date": "01.01.2026", "image": "beispiel.jpg",
        "credit": {"text": "Testbild", "url": "https://example.org/"},
        "truth": {"lat": 47.9959, "lon": 7.8522, "label": "Testort"},
        "events": [
            {"t": 0.0, "type": "status", "data": {"message": "Lese Metadaten (EXIF) …"}},
            {"t": 0.2, "type": "step", "data": {"step": 1, "max_steps": 12}},
            {"t": 5.0, "type": "thinking", "data": {"text": "Schild unten rechts prüfen."}},
            {"t": 5.1, "type": "zoom", "data": {"index": 1, "box": [0.66, 0.6, 0.95, 0.76], "purpose": "Straßenschild lesen", "thumbnail": thumb}},
            {"t": 9.0, "type": "tool_call", "data": {"tool": "geocode", "input": {"query": "Bahnhofstraße Freiburg"}}},
            {"t": 9.5, "type": "tool_result", "data": {"tool": "geocode", "is_error": False, "preview": "1 Treffer: Bahnhofstraße"}},
            {"t": 42.0, "type": "result", "data": result},
        ],
    }


def test_example_button_hidden_without_recording(browser, site_url):
    page = browser.new_page()
    page.route("**/demo/beispiel.json", lambda r: r.fulfill(status=404, body="not found"))
    page.goto(site_url)
    page.wait_for_timeout(300)
    assert not page.is_visible("#demo")
    page.close()


def test_example_replays_a_recording_without_api_key(browser, site_url, tmp_path):
    """'Beispiel ansehen' replays a recorded analysis, so visitors see the tool working without a key."""
    photo = tmp_path / "beispiel.jpg"
    _street_jpeg(photo)
    recording = _synthetic_recording()
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    gemini_calls: list[str] = []
    page.route("**/demo/beispiel.json", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(recording)))
    page.route("**/demo/beispiel.jpg", lambda r: r.fulfill(status=200, content_type="image/jpeg", body=photo.read_bytes()))
    page.route("https://tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="image/png", body=PNG_1X1))
    page.route("https://generativelanguage.googleapis.com/**", lambda r: (gemini_calls.append(r.request.url), r.abort()))
    _mock_scene(page)
    page.goto(site_url)
    page.wait_for_selector("#demo", state="visible")
    page.click("#demo")
    page.wait_for_selector("#demo-banner", state="visible", timeout=10000)  # shown once the recording is loaded
    page.wait_for_selector(".answer", timeout=60000)
    assert page.locator(".answer").first.text_content() == "Bahnhofstraße, Freiburg"
    assert "Tatsächlicher Aufnahmeort: Testort" in page.text_content("#result")
    assert page.locator(".clue-card img").count() == 2
    assert page.locator(".zooms figure").count() == 1
    assert "42.0s" in page.text_content("#log")  # original timestamps are kept in the replay
    assert page.evaluate("document.querySelector('#photo').naturalWidth") == 1600
    assert gemini_calls == [] and errors == []
    context.close()


FAKE_PUTER = """
window.__signedIn = window.__signedIn ?? true;
window.puter = {
  auth: { isSignedIn: () => window.__signedIn, signIn: async () => { window.__signInCalls = (window.__signInCalls || 0) + 1; window.__signedIn = true; } },
  ai: {
    chat: async (messages, options) => {
      window.__puterCalls = window.__puterCalls || [];
      window.__puterCalls.push({ messages: JSON.parse(JSON.stringify(messages)), options: { model: options.model, normalize: options.normalize, tools: options.tools.length } });
      return window.__puterScript.shift();
    },
  },
};
"""


def test_default_provider_puter_needs_no_key(browser, site_url, tmp_path):
    """Default mode: Puter.js (no API key). Puter itself is simulated; the page's loop and rendering are real."""
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    script = [
        {"message": {"role": "assistant", "content": "Schild prüfen.", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "zoom_image", "arguments": json.dumps({"x_min": 0.66, "y_min": 0.6, "x_max": 0.95, "y_max": 0.76, "purpose": "Schild"})}},
            {"id": "c2", "type": "function", "function": {"name": "mark_hypothesis", "arguments": json.dumps({"label": "Südbaden", "camera_lat": 47.99, "camera_lon": 7.85, "radius_km": 30})}},
        ]}, "finish_reason": "tool_calls", "usage": {"prompt_tokens": 3000, "completion_tokens": 200}},
        {"message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c3", "type": "function", "function": {"name": "submit_result", "arguments": json.dumps(SUBMISSION)}},
        ]}, "finish_reason": "tool_calls", "usage": {"prompt_tokens": 4000, "completion_tokens": 300}},
    ]
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_init_script(f"window.__puterScript = {json.dumps(script)}; window.__signedIn = false;")
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("https://js.puter.com/v2/", lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE_PUTER))
    page.route("https://tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="image/png", body=PNG_1X1))
    page.route("https://generativelanguage.googleapis.com/**", lambda r: r.abort())
    _mock_scene(page)
    page.goto(site_url)
    page.set_input_files("#file", str(street))
    # Not signed in yet: the analysis pauses on a sign-in button (popups need a real click).
    page.wait_for_selector("#puter-signin", timeout=30000)
    assert page.evaluate("window.__puterCalls") is None
    page.click("#puter-signin")
    page.wait_for_selector(".clue-card", timeout=60000)
    assert page.evaluate("window.__signInCalls") == 1
    assert page.locator(".answer").all_text_contents() == ["Bahnhofstraße, Freiburg", "Martinstor"]
    assert "Puter" in page.text_content("#result")
    assert "Zwischenstand: Südbaden" in page.text_content("#log")
    calls = page.evaluate("window.__puterCalls")
    assert len(calls) == 2
    assert calls[0]["options"] == {"model": "gemini-3.8-flash", "normalize": True, "tools": 18}
    first_user = calls[0]["messages"][1]["content"]
    assert first_user[1]["type"] == "image_url" and first_user[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    roles = [m["role"] for m in calls[1]["messages"]]
    assert roles == ["system", "user", "assistant", "tool", "tool", "user"]  # zoom crop follows as a user image
    assert errors == []
    context.close()


GEMINI_SETTINGS = "localStorage.setItem('ortfinder.settings.v1', JSON.stringify({provider: 'gemini', apiKey: 'AIza' + 'x'.repeat(35), remember: true}));"


def _wait_until(page, condition, timeout_s=30.0):
    for _ in range(int(timeout_s * 10)):
        if condition():
            return
        page.wait_for_timeout(100)
    raise AssertionError("condition not reached in time")


def test_analysis_resumes_after_the_browser_reloads_the_page(browser, site_url, tmp_path):
    """Phones discard pages that are off screen and reload them later: the run continues after the saved round."""
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_init_script(GEMINI_SETTINGS)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    bodies: list[dict] = []
    held = []

    def gemini(route):
        bodies.append(json.loads(route.request.post_data))
        if len(bodies) == 1:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(_interaction([
                {"type": "function_call", "id": "c1", "name": "zoom_image", "arguments": {"x_min": 0.66, "y_min": 0.6, "x_max": 0.95, "y_max": 0.76, "purpose": "Straßenschild lesen"}},
                {"type": "function_call", "id": "c2", "name": "geocode", "arguments": {"query": "Bahnhofstraße Freiburg"}},
            ])))
        elif len(bodies) == 2:
            held.append(route)  # round 2 never answers: the page is "discarded" meanwhile
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(_interaction([
                {"type": "function_call", "id": "c3", "name": "submit_result", "arguments": SUBMISSION},
            ])))

    page.route("https://generativelanguage.googleapis.com/**", gemini)
    page.goto(site_url)
    page.set_input_files("#file", str(street))
    _wait_until(page, lambda: len(bodies) == 2)
    assert "Runde 2" in page.text_content("#log")

    page.reload()  # what the browser does with a discarded tab when the user comes back
    page.wait_for_selector(".answer", timeout=30000)
    assert page.locator(".answer").first.text_content() == "Bahnhofstraße, Freiburg"
    assert len(bodies) == 3
    assert bodies[2]["input"] == bodies[1]["input"], "round 2 is repeated with the saved history"
    assert [s["type"] for s in bodies[2]["input"]] == ["user_input", "function_call", "function_call", "function_result", "function_result"]
    log = page.text_content("#log")
    assert "Unterbrochene Analyse wird nach Runde 1 fortgesetzt" in log
    assert "Zoom #1: Straßenschild lesen" in log, "log and zooms are restored"
    assert page.locator(".zooms figure").count() == 1
    assert page.evaluate("document.querySelector('#photo').naturalWidth") > 0

    # Finished runs are not resumed again.
    page.wait_for_timeout(500)
    page.reload()
    page.wait_for_timeout(1500)
    assert len(bodies) == 3 and not page.is_visible("#workspace")
    assert errors == []
    context.close()


VISIBILITY = """
Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__vis || 'visible'; } });
Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return (window.__vis || 'visible') === 'hidden'; } });
window.__setVisible = (visible) => { window.__vis = visible ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
"""


def test_request_dropped_in_the_background_waits_for_the_page(browser, site_url, tmp_path):
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_init_script(GEMINI_SETTINGS)
    context.add_init_script(VISIBILITY)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    calls: list[str] = []

    def gemini(route):
        calls.append(route.request.url)
        if len(calls) == 1:
            route.abort("connectionreset")  # the phone cut the connection of the hidden page
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(_interaction([
                {"type": "function_call", "id": "c1", "name": "submit_result", "arguments": SUBMISSION},
            ])))

    page.route("https://generativelanguage.googleapis.com/**", gemini)
    page.goto(site_url)
    page.evaluate("window.__setVisible(false)")
    page.set_input_files("#file", str(street))
    page.wait_for_function("document.querySelector('#log').textContent.includes('im Hintergrund')", timeout=30000)
    assert page.title().startswith("(1/10)"), page.title()
    page.wait_for_timeout(3000)
    assert len(calls) == 1, "no retries while hidden"
    assert page.locator(".answer").count() == 0

    page.evaluate("window.__setVisible(true)")
    page.wait_for_selector(".answer", timeout=30000)
    assert len(calls) == 2
    assert page.title() == "Ortfinder"
    assert errors == []
    context.close()


def test_result_in_the_background_is_announced(browser, site_url, tmp_path):
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.grant_permissions(["notifications"], origin=site_url.rstrip("/"))
    context.add_init_script(GEMINI_SETTINGS)
    context.add_init_script(VISIBILITY)
    context.add_init_script("""
      window.__notes = [];
      const orig = ServiceWorkerRegistration.prototype.showNotification;
      ServiceWorkerRegistration.prototype.showNotification = function (title, options) { window.__notes.push([title, options.body]); return orig.call(this, title, options); };
    """)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    page.route("https://generativelanguage.googleapis.com/**", lambda r: r.fulfill(
        status=200, content_type="application/json",
        body=json.dumps(_interaction([{"type": "function_call", "id": "c1", "name": "submit_result", "arguments": SUBMISSION}]))))
    page.goto(site_url)
    page.evaluate("window.__setVisible(false)")
    page.set_input_files("#file", str(street))
    page.wait_for_function("window.__notes.length > 0", timeout=30000)
    assert page.evaluate("window.__notes") == [["Ortfinder", "Ergebnis: Bahnhofstraße, Freiburg"]]
    assert page.title() == "✔ Ortfinder"
    assert not page.is_visible("#notify"), "permission already granted: no button needed"
    page.evaluate("window.__setVisible(true)")
    assert page.title() == "Ortfinder"
    assert errors == []
    context.close()


def _ndjson(message: dict) -> str:
    lines = [{"message": {"role": "assistant", "content": message.get("content", "")}, "done": False}]
    if message.get("tool_calls"):
        lines.append({"message": {"role": "assistant", "content": "", "tool_calls": message["tool_calls"]}, "done": False})
    lines.append({"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop", "prompt_eval_count": 4000, "eval_count": 150})
    return "\n".join(json.dumps(line) for line in lines) + "\n"


def test_own_pc_ollama_provider_and_phone_link(browser, site_url, tmp_path):
    """Third provider: an open model on the user's PC (Ollama), reachable from the phone through a tunnel."""
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    chats: list[dict] = []
    script = [
        {"content": "Ich prüfe das Schild.", "tool_calls": [
            {"id": "c1", "function": {"name": "zoom_image", "arguments": {"x_min": 0.66, "y_min": 0.6, "x_max": 0.95, "y_max": 0.76, "purpose": "Straßenschild lesen"}}},
            {"id": "c2", "function": {"name": "mark_hypothesis", "arguments": {"label": "Südbaden", "camera_lat": 47.99, "camera_lon": 7.85, "radius_km": 30}}},
        ]},
        {"tool_calls": [{"id": "c3", "function": {"name": "submit_result", "arguments": SUBMISSION}}]},
    ]
    cors = {"Access-Control-Allow-Origin": "*"}

    def ollama(route):
        url = route.request.url
        if url.endswith("/api/tags"):
            route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps({"models": [
                {"name": "gemma4:12b", "size": 7_600_000_000, "details": {"parameter_size": "12B"}, "capabilities": ["completion", "vision", "tools"]},
                {"name": "llava:7b", "size": 4_700_000_000, "details": {"parameter_size": "7B"}, "capabilities": ["completion", "vision"]},
            ]}))
        elif url.endswith("/api/chat"):
            chats.append(json.loads(route.request.post_data))
            route.fulfill(status=200, content_type="application/x-ndjson", headers=cors, body=_ndjson(script.pop(0)))
        else:
            route.fulfill(status=404, headers=cors, body="")

    page.route("http://localhost:11434/**", ollama)
    page.route("https://brave-lemon-river.trycloudflare.com/**", ollama)

    # The start script opens Ortfinder on the PC with the connection (and the tunnel for the phone).
    page.goto(site_url + "#ki=http://localhost:11434&modell=gemma4:12b&handy=https://brave-lemon-river.trycloudflare.com")
    page.wait_for_selector("#phone-qr img", timeout=10000)
    assert "#ki=" not in page.url, "the connection data is removed from the address bar"
    assert page.is_visible("#settings") and page.eval_on_selector("#phone-help", "d => d.open")
    assert page.input_value("#provider") == "ollama"
    assert "gemma4:12b · auf deinem PC" in page.text_content("#settings-toggle")
    page.wait_for_function("document.querySelector('#ollama-status').textContent.includes('Verbunden')", timeout=10000)
    options = page.eval_on_selector_all("#ollama-model option", "os => os.map(o => o.value)")
    assert options == ["gemma4:12b"], options  # llava cannot use tools
    phone_link = page.get_attribute("#phone-qr a", "href")
    assert phone_link.endswith("#ki=https%3A%2F%2Fbrave-lemon-river.trycloudflare.com&modell=gemma4%3A12b")
    page.click("#save-settings")

    page.set_input_files("#file", str(street))
    page.wait_for_selector(".answer", timeout=30000)
    assert page.locator(".answer").first.text_content() == "Bahnhofstraße, Freiburg"
    assert "gemma4:12b (eigener PC)" in page.text_content("#result")
    assert len(chats) == 2
    assert chats[0]["model"] == "gemma4:12b" and chats[0]["options"] == {"num_ctx": 32768} and chats[0]["stream"] is True
    # 1600 px photo: overview + grid (detail tiles only come with larger photos).
    assert [m["role"] for m in chats[0]["messages"]] == ["system", "user"]
    assert len(chats[0]["messages"][1]["images"]) == 1  # the photo with its ruler
    assert chats[1]["messages"][-1]["images"], "the zoom crop is sent back as an image"
    assert "Zwischenstand: Südbaden" in page.text_content("#log")

    # The phone opens the QR link: it talks to the PC through the tunnel.
    phone = context.new_page()
    phone.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(phone, [])
    phone.route("https://brave-lemon-river.trycloudflare.com/**", ollama)
    phone.goto(phone_link)
    phone.wait_for_selector("#ollama-note", state="visible")
    assert "https://brave-lemon-river.trycloudflare.com" in phone.text_content("#ollama-note")
    assert not phone.is_visible("#settings")
    assert errors == []
    context.close()


def test_openrouter_sign_in_on_the_phone_then_the_analysis_starts(browser, site_url, tmp_path):
    """Phone only, other quotas used up: sign in at OpenRouter (free models), come back, the photo is analysed."""
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    context.add_init_script("if (!localStorage.getItem('ortfinder.settings.v1')) localStorage.setItem('ortfinder.settings.v1', JSON.stringify({provider: 'openrouter'}));")
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    exchanges: list[dict] = []
    chats: list[dict] = []
    cors = {"Access-Control-Allow-Origin": "*"}

    def openrouter(route):
        url = route.request.url
        if "/auth?" in url:
            # OpenRouter's login page: after signing in it sends the user back with a code.
            callback = url.split("callback_url=")[1].split("&")[0]
            from urllib.parse import unquote
            route.fulfill(status=302, headers={"Location": unquote(callback) + "?code=code-from-openrouter"})
        elif url.endswith("/api/v1/auth/keys"):
            exchanges.append(json.loads(route.request.post_data))
            route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps({"key": "sk-or-v1-phone"}))
        elif url.endswith("/api/v1/models"):
            route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps({"data": [
                {"id": model_id, "name": model_id, "pricing": {"prompt": "0", "completion": "0"},
                 "architecture": {"input_modalities": ["text", "image"]}, "supported_parameters": ["tools"]}
                for model_id in ["qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free"]
            ]}))
        elif url.endswith("/api/v1/chat/completions"):
            chats.append({"auth": route.request.headers.get("authorization"), "body": json.loads(route.request.post_data)})
            # Qwen is overloaded, OpenRouter answered with the fallback model.
            route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps({"model": "google/gemma-4-31b-it:free", "choices": [{"message": {
                "role": "assistant", "content": None,
                "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "submit_result", "arguments": json.dumps(SUBMISSION)}}],
            }, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 3000, "completion_tokens": 200}}))
        else:
            route.fulfill(status=404, headers=cors, body="")

    page.route("https://openrouter.ai/**", openrouter)
    page.goto(site_url)
    assert page.is_visible("#openrouter-note") and "einmalig an" in page.text_content("#openrouter-note")
    page.set_input_files("#file", str(street))
    page.wait_for_selector("#or-signin-run", timeout=20000)
    assert chats == []
    page.click("#or-signin-run")  # → openrouter.ai → back with ?code=…

    page.wait_for_selector(".answer", timeout=30000)
    assert "?code=" not in page.url
    assert page.locator(".answer").first.text_content() == "Bahnhofstraße, Freiburg"
    assert "(OpenRouter)" in page.text_content("#result")
    assert len(exchanges) == 1 and exchanges[0]["code"] == "code-from-openrouter" and exchanges[0]["code_challenge_method"] == "S256"
    assert len(chats) == 1 and chats[0]["auth"] == "Bearer sk-or-v1-phone"
    assert chats[0]["body"]["model"] == "qwen/qwen3.8-27b:free"
    assert chats[0]["body"]["models"] == ["qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free"], "fallback named in the request"
    assert "OpenRouter hat auf google/gemma-4-31b-it:free ausgewichen" in page.text_content("#log")
    first_user = chats[0]["body"]["messages"][1]["content"]
    assert [p["type"] for p in first_user][:2] == ["text", "image_url"], "the photo survived the sign-in redirect"
    assert "kostenlos über OpenRouter" in page.text_content("#settings-toggle")
    stored = page.evaluate("JSON.parse(localStorage.getItem('ortfinder.settings.v1'))")
    assert stored["openrouterKey"] == "sk-or-v1-phone" and stored["provider"] == "openrouter"
    assert errors == []
    context.close()


def _claude_sse(content: list, stop_reason: str = "tool_use", model: str = "claude-opus-5") -> str:
    """A streamed Messages API answer (server-sent events) as api.anthropic.com sends it."""
    events = [("message_start", {"type": "message_start", "message": {
        "id": "msg_1", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": 2500, "output_tokens": 1, "cache_read_input_tokens": 1500, "cache_creation_input_tokens": 500}}})]
    for i, block in enumerate(content):
        if block["type"] == "text":
            events.append(("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}))
            events.append(("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": block["text"]}}))
        elif block["type"] == "thinking":
            events.append(("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}))
            events.append(("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "thinking_delta", "thinking": block["thinking"]}}))
            events.append(("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "signature_delta", "signature": "c2ln"}}))
        else:
            events.append(("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}}))
            events.append(("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}}))
        events.append(("content_block_stop", {"type": "content_block_stop", "index": i}))
    events.append(("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": 180}}))
    events.append(("message_stop", {"type": "message_stop"}))
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events)


def test_claude_provider_with_own_api_key(browser, site_url, tmp_path):
    """Fifth provider: Claude with the visitor's own API key, through the official SDK in the browser."""
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    requests: list[dict] = []
    script = [
        _claude_sse([
            {"type": "thinking", "thinking": "Straßenschild unten rechts."},
            {"type": "text", "text": "Ich lese das Schild."},
            {"type": "tool_use", "id": "t1", "name": "zoom_image", "input": {"x_min": 0.66, "y_min": 0.6, "x_max": 0.95, "y_max": 0.76, "purpose": "Straßenschild lesen"}},
            {"type": "tool_use", "id": "t2", "name": "mark_hypothesis", "input": {"label": "Südbaden", "camera_lat": 47.99, "camera_lon": 7.85, "radius_km": 30}},
        ]),
        _claude_sse([{"type": "tool_use", "id": "t3", "name": "submit_result", "input": SUBMISSION}]),
    ]
    cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"}

    def anthropic(route):
        if route.request.method == "OPTIONS":
            route.fulfill(status=200, headers=cors, body="")
            return
        requests.append({"url": route.request.url, "headers": route.request.headers, "body": json.loads(route.request.post_data)})
        route.fulfill(status=200, content_type="text/event-stream", headers=cors, body=script.pop(0))

    page.route("https://api.anthropic.com/**", anthropic)
    page.goto(site_url)

    # Choose Claude: the key field, the cost note and the step-by-step guide appear.
    page.click("#settings-toggle")
    page.select_option("#provider", "claude")
    assert page.is_visible("#claude-key") and page.is_visible("#remember-key")
    assert not page.is_visible("#or-signin") and not page.is_visible("#ollama-url")
    assert page.eval_on_selector_all("#claude-model option", "os => os.map(o => o.value)") == ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]
    assert "Claude (Anthropic)" in page.text_content("#guide-title")
    page.click("#guide-title")
    assert page.eval_on_selector_all("#guide-tabs .tab", "ts => ts.map(t => t.textContent)") == ["Windows", "macOS", "Android", "iPhone"]
    assert "Strg+V" in page.text_content("#guide-body") and "platform.claude.com" in page.text_content("#guide-body")
    page.click("#guide-tabs .tab:nth-child(4)")
    assert "Einfügen erlauben" in page.text_content("#guide-body")
    assert page.get_attribute("#guide-link", "href") == "anleitung.html#claude/ios"

    # Starting without a key explains what is missing.
    page.click("#save-settings")
    assert "Claude: API-Key fehlt" in page.text_content("#settings-toggle")
    page.click("#settings-toggle")
    page.fill("#claude-key", "nicht-der-key")
    assert "sk-ant-" in page.text_content("#claude-key-hint")
    page.fill("#claude-key", "sk-ant-api03-" + "x" * 40)
    page.click("#save-settings")
    assert "claude-opus-5 · eigener Claude-Key" in page.text_content("#settings-toggle")
    assert page.is_visible("#claude-note")

    page.set_input_files("#file", str(street))
    page.wait_for_selector(".answer", timeout=30000)
    assert page.locator(".answer").first.text_content() == "Bahnhofstraße, Freiburg"
    assert "claude-opus-5" in page.text_content("#result")
    assert "Zwischenstand: Südbaden" in page.text_content("#log")
    assert "Straßenschild unten rechts." in page.text_content("#log")
    assert len(requests) == 2
    first = requests[0]
    assert first["url"] == "https://api.anthropic.com/v1/messages?beta=true"
    assert first["headers"]["x-api-key"] == "sk-ant-api03-" + "x" * 40
    assert first["headers"]["anthropic-dangerous-direct-browser-access"] == "true"
    assert first["headers"]["anthropic-beta"] == "server-side-fallback-2026-07-01"
    body = first["body"]
    assert body["model"] == "claude-opus-5" and body["stream"] is True and body["fallbacks"] == "default"
    assert body["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert len(body["tools"]) == 18 and all(t["eager_input_streaming"] for t in body["tools"])
    first_user = body["messages"][0]["content"]
    assert [b["type"] for b in first_user][:2] == ["text", "image"]
    assert first_user[1]["source"]["media_type"] == "image/jpeg"
    # Second request: the answer is sent back unchanged, both tool results in one message, the zoom as an image.
    second = requests[1]["body"]["messages"]
    assert [m["role"] for m in second] == ["user", "assistant", "user"]
    assert second[1]["content"][0] == {"type": "thinking", "thinking": "Straßenschild unten rechts.", "signature": "c2ln"}
    results = second[2]["content"]
    assert [r["tool_use_id"] for r in results] == ["t1", "t2"]
    assert results[0]["content"][1]["type"] == "image"
    stored = page.evaluate("JSON.parse(localStorage.getItem('ortfinder.settings.v1'))")
    assert stored["provider"] == "claude" and stored["claudeKey"].startswith("sk-ant-api03-")
    assert errors == []
    context.close()


def test_claude_key_is_forgotten_when_not_remembered(browser, site_url):
    context = browser.new_context()
    page = context.new_page()
    page.goto(site_url)
    page.click("#settings-toggle")
    page.select_option("#provider", "claude")
    page.fill("#claude-key", "sk-ant-api03-" + "y" * 40)
    page.uncheck("#remember-key")
    page.click("#save-settings")
    stored = page.evaluate("JSON.parse(localStorage.getItem('ortfinder.settings.v1'))")
    assert stored["claudeKey"] == "" and stored["remember"] is False
    assert "eigener Claude-Key" in page.text_content("#settings-toggle"), "still usable in this visit"
    context.close()


def test_claude_without_key_explains_what_is_missing(browser, site_url, tmp_path):
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context()
    context.add_init_script("localStorage.setItem('ortfinder.settings.v1', JSON.stringify({provider: 'claude'}));")
    page = context.new_page()
    _mock_network(page, [])
    page.route("https://api.anthropic.com/**", lambda r: r.abort())
    page.goto(site_url)
    assert "API-Key" in page.text_content("#claude-note")
    page.set_input_files("#file", str(street))
    page.wait_for_function("document.querySelector('#log').textContent.includes('Für Claude fehlt noch dein API-Key')", timeout=20000)
    assert page.is_visible("#settings") and page.is_visible("#claude-key")
    context.close()


def test_guides_for_every_option_and_device(browser, site_url):
    """Each AI option has a guide per device; on an iPhone the iPhone steps open first."""
    iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1"
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, user_agent=iphone)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(site_url)
    page.click("#settings-toggle")
    for provider, expected in [("puter", "Pop-ups blockieren"), ("gemini", "aistudio.google.com"), ("openrouter", "Authorize"),
                               ("claude", "Buy credits"), ("ollama", "Kamera")]:
        page.select_option("#provider", provider)
        assert page.eval_on_selector("#guide-tabs .tab.active", "t => t.textContent") == "iPhone"
        assert expected in page.text_content("#guide"), provider
    # Tapping a command copies it.
    context.grant_permissions(["clipboard-read", "clipboard-write"], origin=site_url.rstrip("/"))
    page.click("#guide-title")
    page.click("#guide-tabs .tab:nth-child(1)")
    assert page.eval_on_selector("#guide-tabs .tab.active", "t => t.textContent") == "Windows"
    page.click("#guide-body code.copy")
    page.wait_for_selector("#guide-body code.copy.copied")
    assert page.evaluate("navigator.clipboard.readText()") == "winget install Cloudflare.cloudflared"

    # The guides page: all options, shareable address.
    guide = context.new_page()
    guide.on("pageerror", lambda e: errors.append(str(e)))
    guide.goto(site_url + "anleitung.html#gemini/android")
    guide.wait_for_selector("#guide-body li")
    assert guide.text_content("#guide-heading") == "Google Gemini (eigener Key) · Android"
    assert "lange in das Feld tippen" in guide.text_content("#guide-body")
    guide.click("#provider-tabs .tab:has-text('Claude')")
    guide.wait_for_function("document.querySelector('#guide-heading').textContent.startsWith('Claude')")
    assert guide.url.endswith("#claude/android")
    assert "sk-ant-" in guide.text_content("#guide-body")
    guide.click("#device-tabs .tab:has-text('macOS')")
    guide.wait_for_function("document.querySelector('#guide-heading').textContent.endsWith('· macOS')")
    assert "⌘+V" in guide.text_content("#guide-body")
    guide.goto(site_url + "anleitung.html#ollama/windows")
    guide.wait_for_selector("#guide-body code.copy")
    assert guide.get_attribute("#guide-body a[download]", "href") == "ki/ortfinder-ki-windows.bat"
    assert errors == []
    context.close()


def test_gemini_daily_limit_continues_with_the_next_free_model(browser, site_url, tmp_path):
    """Free tier: 20 requests per day and model. Used up → the next free model continues, and is remembered."""
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context()
    context.add_init_script(GEMINI_SETTINGS)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    models: list[str] = []
    daily = {"error": {"message": "Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). Please retry in 58s.", "code": "too_many_requests"}}

    def gemini(route):
        body = json.loads(route.request.post_data)
        models.append(body["model"])
        if body["model"] == "gemini-3.8-flash":
            route.fulfill(status=429, content_type="application/json", body=json.dumps(daily))
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(_interaction([{"type": "function_call", "id": "x", "name": "submit_result", "arguments": SUBMISSION}])))

    page.route("https://generativelanguage.googleapis.com/**", gemini)
    page.goto(site_url)
    page.set_input_files("#file", str(street))
    page.wait_for_selector(".answer", timeout=30000)
    assert models == ["gemini-3.8-flash", "gemini-3.7-flash"]
    assert "Tageslimit von gemini-3.8-flash erreicht – Ortfinder macht mit gemini-3.7-flash weiter" in page.text_content("#log")
    saved = page.evaluate("JSON.parse(localStorage.getItem('ortfinder.gemini.exhausted.v1'))")
    assert saved["models"] == ["gemini-3.8-flash"] and len(saved["day"]) == 10
    # The next photo today starts right away with the model that still has requests left.
    models.clear()
    page.set_input_files("#file", str(street))
    page.wait_for_function("document.querySelectorAll('.answer').length > 0 && document.querySelector('#log').textContent.includes('Fertig')", timeout=30000)
    assert models == ["gemini-3.7-flash"]
    assert errors == []
    context.close()


# ---------- mountain skyline (PeakFinder-like) ----------

MOUNTAIN_CAMERA = (46.40, 9.10)
# Synthetic mountains around the camera: azimuth °, distance m, summit m, width m, name.
MOUNTAINS = [(70, 6000, 2400, 1500, "Testhorn"), (86, 9000, 3000, 2000, "Grosser Probestock"), (101, 5000, 2000, 1000, "Kleines Musterhorn"),
             (116, 15000, 3500, 3000, "Beispielspitz"), (250, 7000, 2600, 1800, "Hinterberg")]
MOUNTAIN_BASE = 600.0


def _mountain_xy():
    lat0, _ = MOUNTAIN_CAMERA
    kx = 111195.0 * math.cos(math.radians(lat0))
    return [(d * math.sin(math.radians(az)), d * math.cos(math.radians(az)), h, w, name) for az, d, h, w, name in MOUNTAINS], kx


def _mountain_elevation(lat, lon):
    peaks, kx = _mountain_xy()
    e = (lon - MOUNTAIN_CAMERA[1]) * kx
    n = (lat - MOUNTAIN_CAMERA[0]) * 111195.0
    z = MOUNTAIN_BASE
    for pe, pn, h, w, _ in peaks:
        d2 = ((e - pe) ** 2 + (n - pn) ** 2) / (w * w)
        if d2 < 25:
            z += (h - MOUNTAIN_BASE) * math.exp(-d2)
    return z


def _mountain_tile(z, x, y, cache={}):
    """Terrarium tile of the synthetic mountains (tiles far from them are flat)."""
    if (z, x, y) in cache:
        return cache[(z, x, y)]
    n = 2 ** z
    lon_of = lambda px: px / (256 * n) * 360 - 180
    lat_of = lambda py: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / (256 * n)))))
    lats = [lat_of(y * 256 + j + 0.5) for j in range(256)]
    lons = [lon_of(x * 256 + i + 0.5) for i in range(256)]
    peaks, kx = _mountain_xy()
    near = any(
        abs((lons[0] + lons[-1]) / 2 - MOUNTAIN_CAMERA[1]) * kx - abs(lons[-1] - lons[0]) * kx / 2 < abs(pe) + 5 * w
        and abs((lats[0] + lats[-1]) / 2 - MOUNTAIN_CAMERA[0]) * 111195 - abs(lats[-1] - lats[0]) * 111195 / 2 < abs(pn) + 5 * w
        for pe, pn, _, w, _ in peaks
    )
    img = Image.new("RGB", (256, 256))
    if near:
        px = img.load()
        for j, la in enumerate(lats):
            for i, lo in enumerate(lons):
                v = _mountain_elevation(la, lo) + 32768
                px[i, j] = (int(v // 256), int(v % 256), int((v % 1) * 256))
    else:
        v = MOUNTAIN_BASE + 32768
        img.paste((int(v // 256), int(v % 256), 0), (0, 0, 256, 256))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    cache[(z, x, y)] = buf.getvalue()
    return cache[(z, x, y)]


def _mountain_peaks_json():
    lat0, lon0 = MOUNTAIN_CAMERA
    peaks, kx = _mountain_xy()
    elements = []
    for i, (pe, pn, _, _, name) in enumerate(peaks):
        lat, lon = lat0 + pn / 111195.0, lon0 + pe / kx
        elements.append({"type": "node", "id": 900 + i, "lat": lat, "lon": lon, "tags": {"natural": "peak", "name": name, "ele": str(round(_mountain_elevation(lat, lon)))}})
    return {"elements": elements}


def test_mountain_skyline_names_the_peaks(browser, site_url, tmp_path):
    """skyline_match: the photo's sky line against the terrain horizon – direction, field of view and peak names."""
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_init_script(GEMINI_SETTINGS)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    overpass_queries: list[str] = []

    def tile(route):
        z, x, y = (int(v) for v in route.request.url.split("?")[0].removesuffix(".png").rsplit("/", 3)[-3:])
        route.fulfill(status=200, content_type="image/png", headers={"Access-Control-Allow-Origin": "*"}, body=_mountain_tile(z, x, y))

    def overpass(route):
        overpass_queries.append(route.request.post_data or "")
        route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(_mountain_peaks_json()))

    page.route("https://s3.amazonaws.com/elevation-tiles-prod/**", tile)
    page.route("**/api/interpreter", overpass)
    _no_swisstopo(page)
    page.route("https://tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="image/png", body=PNG_1X1))
    page.route("https://server.arcgisonline.com/**", lambda r: r.fulfill(status=200, content_type="image/png", headers={"Access-Control-Allow-Origin": "*"}, body=PNG_1X1))
    page.goto(site_url)

    # The photo: rendered from the same terrain model, looking at 88° with a 50° field of view, tilted up 3°.
    truth = {"bearing": 88, "pitch": 3, "roll": 0, "fov": 50}
    data_url = page.evaluate("""async ({ lat, lon, pose }) => {
      const { Terrain } = await import('./js/terrain.js');
      const sk = await import('./js/skyline.js');
      const { makeCamera } = await import('./js/scene3d.js');
      const terrain = new Terrain();
      const dem = await sk.buildDem(terrain, { lat, lon, levels: sk.DEM_FINE, sector: { center: pose.bearing, half: 40 }, shiftM: 0, maxDistM: 60000 });
      const h = sk.traceHorizon(dem, { eyeZ: dem.height(0, 0) + 1.6, az0: pose.bearing - 40, count: 1601, stepDeg: 0.05, maxDistM: 60000 });
      const W = 1200, H = 800;
      const cam = makeCamera({ bearingDeg: pose.bearing, pitchDeg: pose.pitch, rollDeg: pose.roll, fovDeg: pose.fov, width: W, height: H });
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d'); const img = ctx.createImageData(W, H);
      let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const a = (x + 0.5 - W / 2) / cam.fpx, b = (H / 2 - y - 0.5) / cam.fpx;
        const d = [0, 1, 2].map((i) => cam.f[i] + a * cam.r[i] + b * cam.u[i]);
        const hz = sk.horizonAt(h, Math.atan2(d[0], d[1]) * 180 / Math.PI);
        const sky = !hz || Math.atan2(d[2], Math.hypot(d[0], d[1])) * 180 / Math.PI > hz.el;
        const i = (y * W + x) * 4, t = y / H;
        const col = sky ? [90 + 90 * t, 140 + 60 * t, 235] : [60 + 40 * rnd(), 95 + 40 * rnd(), 55 + 30 * rnd()];
        img.data.set([...col, 255], i);
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.92);
    }""", {"lat": MOUNTAIN_CAMERA[0], "lon": MOUNTAIN_CAMERA[1], "pose": truth})
    photo = tmp_path / "berge.jpg"
    photo.write_bytes(base64.b64decode(data_url.split(",")[1]))

    bodies: list[dict] = []
    script = [
        _interaction([{"type": "function_call", "id": "s1", "name": "skyline_match", "arguments": {
            "camera_lat": MOUNTAIN_CAMERA[0], "camera_lon": MOUNTAIN_CAMERA[1], "fov_deg": 55, "purpose": "Bergkette benennen"}}]),
        _interaction([{"type": "function_call", "id": "s2", "name": "submit_result", "arguments": {
            **SUBMISSION, "summary": "Bergkamm eindeutig zugeordnet.", "city": "Testtal",
            "camera": {"name": "Aussichtspunkt Testtal", "lat": MOUNTAIN_CAMERA[0], "lon": MOUNTAIN_CAMERA[1], "radius_km": 0.5, "confidence": 0.9},
            "subject": {"name": "Grosser Probestock", "lat": 46.4056, "lon": 9.2171, "radius_km": 0.3},
            "view": {"bearing_deg": 88, "fov_deg": 50, "distance_m": 9000, "pitch_deg": 3}, "clues": []}}]),
    ]

    def gemini(route):
        bodies.append(json.loads(route.request.post_data))
        route.fulfill(status=200, content_type="application/json", body=json.dumps(script.pop(0)))

    page.route("https://generativelanguage.googleapis.com/**", gemini)
    page.route("https://nominatim.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body="[]"))
    page.set_input_files("#file", str(photo))
    page.wait_for_selector(".answer", timeout=120000)

    # What the AI got back: the pose (all-round search found the direction), the peaks and the labelled photo.
    result = next(s for s in bodies[1]["input"] if s["type"] == "function_result" and s["name"] == "skyline_match")
    assert "is_error" not in result, result["result"]
    assert [b["type"] for b in result["result"]] == ["text", "image"]
    out = json.loads(result["result"][0]["text"])
    assert abs(out["view"]["bearing_deg"] - 88) < 0.5, out["view"]
    assert abs(out["view"]["fov_deg"] - 50) < 1.5 and abs(out["view"]["pitch_deg"] - 3) < 0.5, out["view"]
    assert out["match_confidence"] >= 0.9, out
    names = [p["name"] for p in out["peaks"]]
    assert {"Testhorn", "Grosser Probestock", "Kleines Musterhorn"} <= set(names), names
    assert "Hinterberg" not in names  # behind the camera
    probe = next(p for p in out["peaks"] if p["name"] == "Grosser Probestock")
    assert abs(probe["km"] - 9.0) < 0.2 and abs(probe["bearing_deg"] - 86) < 0.3, probe
    assert out["peak_names"] == "OpenStreetMap"
    assert any('"natural"~' in urllib.parse.unquote_plus(q) for q in overpass_queries)
    labelled = Image.open(io.BytesIO(base64.b64decode(result["result"][1]["data"])))
    assert labelled.size[0] == 1200 and labelled.size[1] < 800  # cropped to the skyline band

    # The user sees it too: log line, snapshot, and the peaks section in the result.
    log = page.text_content("#log")
    assert "Bergkamm-Abgleich: Blick 8" in log and "Grosser Probestock" in log
    assert "Bergkamm: Bergkette benennen" in page.text_content(".zooms")
    page.wait_for_selector("#skyline-slot table.peaks", timeout=30000)
    table = page.text_content("#skyline-slot table.peaks")
    assert "Grosser Probestock" in table and "9,0 km" in table
    lines_before = page.locator("path.leaflet-interactive").count()
    page.check("#skyline-slot input[type=checkbox]")
    assert page.locator("path.leaflet-interactive").count() > lines_before
    if os.environ.get("ORTFINDER_SHOTS"):
        page.wait_for_timeout(1500)
        page.locator("#skyline-slot").screenshot(path=os.path.join(os.environ["ORTFINDER_SHOTS"], "e2e-skyline.png"))
    assert errors == []
    context.close()


def test_hints_image_search_and_feedback_teach_the_next_analysis(browser, site_url, tmp_path):
    """Extra info goes to the AI; the true location measures the error; the AI's lessons go along next time."""
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_init_script(GEMINI_SETTINGS)
    context.add_init_script("window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };")
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    bodies: list[dict] = []
    lesson = "Straßennamensschilder immer zuerst per zoom_image lesen und mit geocode prüfen, bevor Gebäude verglichen werden."

    def gemini(route):
        body = json.loads(route.request.post_data)
        bodies.append(body)
        if "tools" not in body:  # the lesson question: no tools, answer as JSON
            answer = {"id": "", "status": "completed", "steps": [{"type": "model_output", "content": [{"type": "text", "text": json.dumps({"lessons": [lesson]})}]}]}
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(answer))
        route.fulfill(status=200, content_type="application/json", body=json.dumps(_interaction([{"type": "function_call", "id": "x", "name": "submit_result", "arguments": SUBMISSION}])))

    page.route("https://generativelanguage.googleapis.com/**", gemini)
    page.route("**/lessons.json", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"lessons": ["Gemeinsame Testlehre für alle Nutzer, lang genug."]})))
    page.goto(site_url)
    page.click("#hints-box summary")
    page.fill("#hints", "Google Lens findet: Martinstor, Freiburg")
    page.set_input_files("#file", str(street))
    page.wait_for_selector(".answer", timeout=30000)
    intro = bodies[0]["input"][0]["content"][0]["text"]
    assert "Zusatzinfo des Nutzers (ernst nehmen, aber selbst prüfen):\nGoogle Lens findet: Martinstor, Freiburg" in intro
    assert "Gemeinsame Testlehre für alle Nutzer" in intro

    # Reverse image search by hand: the site opens, the photo is (tried to be) copied.
    page.click("#lens-bing")
    assert page.evaluate("window.__opened") == ["https://www.bing.com/visualsearch"]
    assert "Bing" in page.text_content("#lens-hint")
    # Street View / Maps links for checking the spot.
    assert "map_action=pano&viewpoint=47.99,7.85&heading=352" in page.get_attribute("text=🚶 Street View hier", "href")

    # Feedback: the true place as coordinates, a comment, save → error and the AI's lesson.
    page.click("#feedback summary")
    page.fill("#feedback input[type=text]", "47.9959, 7.8522")
    page.click("#feedback >> text=Übernehmen")
    assert "Abweichung der Analyse: 676 m" in page.text_content("#feedback")
    page.fill("#feedback textarea", "Das Schild war gut, die Straße aber falsch.")
    page.click("#feedback >> text=Rückmeldung speichern")
    page.wait_for_selector("#feedback ul.lessons li", timeout=20000)
    fb = page.text_content("#feedback")
    assert "676 m daneben (außerhalb des angegebenen Radius von 300 m)" in fb and lesson in fb
    question = bodies[-1]["input"][0]["content"]
    assert "Wahrer Ort: (ohne Adresse) (47.99590, 7.85220). Abweichung: 676 m." in question[0]["text"]
    assert question[1]["type"] == "image"
    share = page.get_attribute("#feedback a[href*='github.com']", "href")
    assert "issues/new" in share and "nicht+mitgeteilt" in share
    assert len(page.evaluate("JSON.parse(localStorage.getItem('ortfinder.lessons.v1'))")) == 1
    page.click("#settings-toggle")
    page.click("#learn-settings summary")
    assert lesson in page.text_content("#lesson-list") and "1 Rückmeldung" in page.text_content("#lesson-list")
    page.click("#save-settings")

    # The next analysis carries the lesson.
    bodies.clear()
    page.fill("#hints", "")
    page.set_input_files("#file", str(street))
    page.wait_for_function("document.querySelector('#log').textContent.includes('Fertig')", timeout=30000)
    assert f"- {lesson}" in bodies[0]["input"][0]["content"][0]["text"]
    assert errors == []
    context.close()


def test_photo_as_3d_model_from_side_view_to_top_view(browser, site_url, tmp_path):
    """The result offers the photo as a 3D model: terrain + OSM buildings with the photo projected from the camera."""
    street = tmp_path / "street.jpg"
    _street_jpeg(street)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_init_script(GEMINI_SETTINGS)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _mock_network(page, [])
    view = {**SUBMISSION["view"], "pitch_deg": -2, "eye_height_m": 1.6}
    page.route("https://generativelanguage.googleapis.com/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(
        _interaction([{"type": "function_call", "id": "x", "name": "submit_result", "arguments": {**SUBMISSION, "view": view}}]))))
    page.goto(site_url)
    page.set_input_files("#file", str(street))
    page.wait_for_selector("#model-slot button", timeout=30000)
    page.click("#model-slot button")
    page.wait_for_selector("#model-slot canvas", timeout=60000)
    page.wait_for_function("document.querySelector('#model-slot').textContent.includes('Gelände bis')", timeout=30000)
    text = page.text_content("#model-slot")
    assert "Gebäude aus OSM" in text and "Luftbild von Esri" in text
    buildings = int(text.split("Gebäude aus OSM")[0].split(",")[-1].strip())
    assert buildings >= 10, text  # the street's houses from the mocked OSM scene
    shots = {}
    for label in ["📷 Wie das Foto", "↗ Schräg", "⬇ Draufsicht"]:
        page.click(f"#model-slot >> text={label}")
        data = page.evaluate("document.querySelector('#model-slot canvas').toDataURL('image/png')")
        shots[label] = Image.open(io.BytesIO(base64.b64decode(data.split(",")[1]))).convert("RGB")
    for label, img in shots.items():
        colours = img.resize((64, 64)).getcolors(64 * 64)
        assert colours and len(colours) > 20, f"{label}: blank render"
    if os.environ.get("ORTFINDER_SHOTS"):
        for i, img in enumerate(shots.values()):
            img.save(os.path.join(os.environ["ORTFINDER_SHOTS"], f"e2e-model-{i}.png"))
    # Seen from the camera, the model shows the photo: sky blue on top, the grey road below.
    photo_view = shots["📷 Wie das Foto"].resize((50, 50))
    r, g, b = photo_view.getpixel((25, 45))
    assert abs(r - 90) < 30 and abs(g - 90) < 30 and abs(b - 95) < 30, (r, g, b)
    # Photo overlay off: the aerial image (here plain test tiles) instead.
    page.fill("#model-slot input[type=range]", "0")
    page.dispatch_event("#model-slot input[type=range]", "input")
    page.click("#model-slot >> text=▶ Seitenansicht → Draufsicht")
    page.wait_for_timeout(3600)
    assert errors == []
    context.close()

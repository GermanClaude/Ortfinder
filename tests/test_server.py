
from conftest import VALID_SUBMISSION, FakeClient, FakeOSM, make_jpeg, response, settings, tool_use
from fastapi.testclient import TestClient

from ortfinder import server
from ortfinder.agent import Geolocator


def collect_events(client: TestClient, job_id: str) -> list[dict]:
    import json

    events = []
    with client.stream("GET", f"/api/jobs/{job_id}/events") as resp:
        for line in resp.iter_lines():
            if line.startswith("data: "):
                event = json.loads(line[6:])
                events.append(event)
                if event["type"] == "done":
                    break
    return events


def test_full_flow_with_fake_model(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    fake = FakeClient([response([tool_use("t1", "submit_result", VALID_SUBMISSION)], "tool_use")])
    app = server.create_app(Geolocator(settings(), client=fake, osm=FakeOSM()))
    client = TestClient(app)

    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/api/status").json()["api_key"] is True

    res = client.post("/api/locate", files={"file": ("bild.jpg", make_jpeg(), "image/jpeg")})
    assert res.status_code == 200
    job_id = res.json()["job_id"]
    events = collect_events(client, job_id)
    types = [e["type"] for e in events]
    assert types[0] == "image" and types[-1] == "done" and "result" in types
    result = next(e["data"] for e in events if e["type"] == "result")
    assert result["analysis"]["city"] == "Freiburg"

    preview = client.get(f"/api/jobs/{job_id}/preview.jpg")
    assert preview.status_code == 200 and preview.content[:2] == b"\xff\xd8"


def test_without_api_key_only_metadata_is_used(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    fake = FakeClient([])
    client = TestClient(server.create_app(Geolocator(settings(), client=fake, osm=FakeOSM())))
    job_id = client.post("/api/locate", files={"file": ("a.jpg", make_jpeg(gps=(52.5, 13.4)), "image/jpeg")}).json()["job_id"]
    events = collect_events(client, job_id)
    assert any(e["type"] == "warning" for e in events)
    result = next(e["data"] for e in events if e["type"] == "result")
    assert result["final"]["source"] == "exif_gps" and fake.requests == []


def test_model_errors_are_reported(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    class Boom(FakeClient):
        def _create(self, **kwargs):
            raise RuntimeError("kaputt")

    client = TestClient(server.create_app(Geolocator(settings(), client=Boom([]), osm=FakeOSM())))
    job_id = client.post("/api/locate", files={"file": ("a.jpg", make_jpeg(), "image/jpeg")}).json()["job_id"]
    events = collect_events(client, job_id)
    assert {"type": "error", "message": "kaputt"} == {"type": events[-2]["type"], "message": events[-2]["data"]["message"]}


def test_rejects_non_images_and_unknown_jobs():
    client = TestClient(server.create_app(Geolocator(settings(), client=FakeClient([]), osm=FakeOSM())))
    assert client.post("/api/locate", files={"file": ("a.txt", b"hello", "text/plain")}).status_code == 415
    assert client.post("/api/locate", files={"file": ("a.jpg", b"", "image/jpeg")}).status_code == 400
    assert client.get("/api/jobs/nope/events").status_code == 404

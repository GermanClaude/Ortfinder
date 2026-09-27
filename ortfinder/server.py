"""Web interface: upload an image, watch the analysis live, see the result on a map."""

from __future__ import annotations

import asyncio
import io
import json
import os
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import anthropic
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import imaging
from .agent import Geolocator
from .config import load_settings

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_JOBS = 30


def has_api_credentials() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def describe_error(exc: Exception) -> str:
    if isinstance(exc, anthropic.AuthenticationError):
        return "Der Anthropic API-Key ist ungültig."
    if isinstance(exc, anthropic.PermissionDeniedError):
        return "Der API-Key hat keinen Zugriff auf dieses Modell."
    if isinstance(exc, anthropic.NotFoundError):
        return "Modell nicht gefunden - ORTFINDER_MODEL prüfen."
    if isinstance(exc, anthropic.RateLimitError):
        return "Rate-Limit der Anthropic API erreicht. Bitte kurz warten und erneut versuchen."
    if isinstance(exc, anthropic.BadRequestError):
        return f"Anfrage abgelehnt: {exc.message}"
    if isinstance(exc, anthropic.APIStatusError):
        return f"Fehler der Anthropic API (HTTP {exc.status_code}). Bitte später erneut versuchen."
    if isinstance(exc, anthropic.APIConnectionError):
        return "Keine Verbindung zur Anthropic API."
    return str(exc) or type(exc).__name__


class Job:
    def __init__(self) -> None:
        self.id = uuid.uuid4().hex
        self.created = time.time()
        self.events: list[dict[str, Any]] = []
        self.done = False
        self.preview: bytes | None = None
        self._lock = threading.Lock()

    def emit(self, type_: str, data: dict[str, Any]) -> None:
        with self._lock:
            self.events.append({"type": type_, "data": data, "t": round(time.time() - self.created, 2)})

    def events_since(self, index: int) -> list[dict[str, Any]]:
        with self._lock:
            return self.events[index:]


def create_app(geolocator: Geolocator | None = None) -> FastAPI:
    settings = load_settings()
    locator = geolocator or Geolocator(settings)
    jobs: OrderedDict[str, Job] = OrderedDict()
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ortfinder")
    app = FastAPI(title="Ortfinder")
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    def run_job(job: Job, data: bytes, use_ai: bool) -> None:
        try:
            locator.locate(data, emit=job.emit, use_ai=use_ai)
        except Exception as exc:  # noqa: BLE001 - surface every failure to the browser
            job.emit("error", {"message": describe_error(exc)})
        finally:
            job.done = True

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/status")
    def status() -> dict[str, Any]:
        return {
            "api_key": has_api_credentials(),
            "model": settings.model,
            "effort": settings.effort,
            "web_search": settings.web_search,
        }

    @app.post("/api/locate")
    async def locate(file: UploadFile = File(...), use_ai: bool = Form(True)) -> dict[str, Any]:
        data = await file.read(MAX_UPLOAD_BYTES + 1)
        if not data:
            raise HTTPException(400, "Leere Datei.")
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Bild ist größer als 30 MB.")
        try:
            image = imaging.load_image(data)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(415, "Das ist kein lesbares Bild (unterstützt: JPEG, PNG, WebP, HEIC, …).") from exc

        job = Job()
        buf = io.BytesIO()
        imaging.fit(image, 1600).save(buf, format="JPEG", quality=88)
        job.preview = buf.getvalue()
        jobs[job.id] = job
        while len(jobs) > MAX_JOBS:
            jobs.popitem(last=False)

        ai = use_ai and has_api_credentials()
        if use_ai and not ai:
            job.emit("warning", {"message": "Kein ANTHROPIC_API_KEY gesetzt - es werden nur die Metadaten ausgewertet."})
        job.emit("image", {"width": image.width, "height": image.height, "preview": f"/api/jobs/{job.id}/preview.jpg"})
        pool.submit(run_job, job, data, ai)
        return {"job_id": job.id}

    def get_job(job_id: str) -> Job:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "Unbekannter Auftrag.")
        return job

    @app.get("/api/jobs/{job_id}/preview.jpg")
    def preview(job_id: str) -> Response:
        return Response(get_job(job_id).preview or b"", media_type="image/jpeg")

    @app.get("/api/jobs/{job_id}/events")
    async def events(job_id: str) -> StreamingResponse:
        job = get_job(job_id)

        async def stream():
            sent = 0
            last_beat = time.monotonic()
            while True:
                batch = job.events_since(sent)
                for event in batch:
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                sent += len(batch)
                if job.done and sent >= len(job.events):
                    yield 'data: {"type": "done", "data": {}}\n\n'
                    return
                if time.monotonic() - last_beat > 15:
                    yield ": keep-alive\n\n"
                    last_beat = time.monotonic()
                await asyncio.sleep(0.2)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


def main() -> None:
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Ortfinder Weboberfläche starten")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    print(f"Ortfinder läuft auf http://{args.host}:{args.port}")
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

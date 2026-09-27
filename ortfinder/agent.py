"""The geolocation pipeline: EXIF metadata, then a Claude agent that zooms, searches and verifies."""

from __future__ import annotations

import json
import time
from typing import Any, Callable

import anthropic

from . import imaging
from .config import Settings
from .geo import OSMClient, OSMError, haversine_km
from .metadata import extract_metadata, hints_for_model
from .prompts import SYSTEM_PROMPT
from .tools import SUBMIT_TOOL, ToolExecutor, ToolInputError, build_tools, validate_submission

Emit = Callable[[str, dict[str, Any]], None]

FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TOKENS = 16000
MAX_SUBMIT_NUDGES = 2


def _noop(_type: str, _data: dict[str, Any]) -> None:
    pass


def _echo_content(content: list[Any]) -> list[Any]:
    """Assistant content to send back on the next turn.

    After a server-side model fallback, blocks produced before the last ``fallback`` marker
    belong to the declined attempt: only its text is kept, the marker itself is dropped.
    """
    last_fallback = max((i for i, b in enumerate(content) if b.type == "fallback"), default=-1)
    if last_fallback < 0:
        return list(content)
    kept = [b for b in content[:last_fallback] if b.type == "text"]
    return kept + list(content[last_fallback + 1:])


class Geolocator:
    def __init__(self, settings: Settings, client: Any | None = None, osm: OSMClient | None = None):
        self.settings = settings
        self._client = client
        self.osm = osm or OSMClient(settings.user_agent, settings.nominatim_url, settings.overpass_url)

    @property
    def client(self) -> Any:
        if self._client is None:
            self._client = anthropic.Anthropic()
        return self._client

    def locate(self, data: bytes, emit: Emit = _noop, use_ai: bool = True) -> dict[str, Any]:
        started = time.monotonic()
        emit("status", {"message": "Lese Metadaten (EXIF) …"})
        metadata = extract_metadata(data)
        emit("metadata", metadata)
        if "error" in metadata:
            raise ValueError(metadata["error"])

        result: dict[str, Any] = {"metadata": metadata, "model": self.settings.model}
        gps = metadata.get("gps")
        if gps:
            exif_loc = {"lat": gps["lat"], "lon": gps["lon"]}
            try:
                exif_loc["address"] = self.osm.reverse(gps["lat"], gps["lon"]).get("name")
            except (OSMError, OSError) as exc:
                exif_loc["address_error"] = str(exc)
            result["exif_location"] = exif_loc
            emit("exif_location", exif_loc)

        if use_ai:
            image = imaging.load_image(data)
            emit("status", {"message": f"Bild geladen ({image.width}×{image.height}). Starte KI-Analyse …"})
            result["analysis"], result["usage"] = self._run_agent(image, metadata, emit)
            best = result["analysis"]["best_guess"]
            if gps:
                result["exif_vs_analysis_km"] = round(haversine_km(gps["lat"], gps["lon"], best["lat"], best["lon"]), 3)

        result["final"] = self._final_location(result)
        result["seconds"] = round(time.monotonic() - started, 1)
        emit("result", result)
        return result

    @staticmethod
    def _final_location(result: dict[str, Any]) -> dict[str, Any] | None:
        exif = result.get("exif_location")
        if exif:
            return {
                "source": "exif_gps",
                "name": exif.get("address") or "GPS-Position aus den Bild-Metadaten",
                "lat": exif["lat"],
                "lon": exif["lon"],
                "radius_km": 0.05,
                "confidence": 0.99,
                "precision": "exakt",
            }
        analysis = result.get("analysis")
        if analysis:
            return {"source": "visual_analysis", **analysis["best_guess"], "precision": analysis["precision"]}
        return None

    def _initial_message(self, image, metadata: dict[str, Any]) -> dict[str, Any]:
        hints = hints_for_model(metadata)
        intro = [
            f"Bestimme, wo dieses Foto aufgenommen wurde. Originalauflösung: {image.width}×{image.height} Pixel "
            "(zoom_image arbeitet auf dem Original).",
            "Bild 1: das Foto. Bild 2: dasselbe Foto mit Koordinatenraster (0.0-1.0) zum Zielen für zoom_image.",
        ]
        if hints:
            intro.append("Metadaten aus der Datei (GPS-Daten, falls vorhanden, werden dir absichtlich nicht gezeigt):\n- " + "\n- ".join(hints))
        else:
            intro.append("Die Datei enthält keine verwertbaren Metadaten - nur der Bildinhalt zählt.")
        return {
            "role": "user",
            "content": [
                {"type": "text", "text": "\n\n".join(intro)},
                imaging.image_block(image),
                imaging.image_block(imaging.with_grid(image), max_side=1024),
            ],
        }

    def _request(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Any:
        return self.client.beta.messages.create(
            model=self.settings.model,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=tools,
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": self.settings.effort},
            cache_control={"type": "ephemeral"},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )

    def _run_agent(self, image, metadata: dict[str, Any], emit: Emit) -> tuple[dict[str, Any], dict[str, int]]:
        tools = build_tools(self.settings.web_search, self.settings.web_search_max_uses)
        executor = ToolExecutor(image, self.osm, emit)
        messages: list[dict[str, Any]] = [self._initial_message(image, metadata)]
        usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "requests": 0}
        nudges = 0

        for step in range(1, self.settings.max_steps + 1):
            emit("step", {"step": step, "max_steps": self.settings.max_steps})
            response = self._request(messages, tools)
            usage["requests"] += 1
            for key in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                usage[key] += getattr(response.usage, key, 0) or 0
            self._emit_blocks(response, emit)

            if response.stop_reason == "refusal":
                raise RuntimeError("Das Modell hat die Analyse dieses Bildes abgelehnt.")

            messages.append({"role": "assistant", "content": _echo_content(response.content)})
            tool_uses = [b for b in response.content if b.type == "tool_use"]

            if response.stop_reason == "pause_turn":
                continue  # server-side web search paused mid-turn; resend to let it continue

            if response.stop_reason == "max_tokens" and tool_uses:
                # Tool input may be cut off: don't run anything, ask for a shorter retry.
                messages.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": b.id, "is_error": True,
                     "content": "Antwort wurde abgeschnitten (max_tokens). Bitte kürzer erneut aufrufen."}
                    for b in tool_uses
                ]})
                continue

            if not tool_uses:
                nudges += 1
                if nudges > MAX_SUBMIT_NUDGES:
                    break
                messages.append({"role": "user", "content": f"Bitte gib dein Ergebnis jetzt mit `{SUBMIT_TOOL}` ab."})
                continue

            results = []
            submission = None
            for block in tool_uses:
                if block.name == SUBMIT_TOOL:
                    try:
                        submission = validate_submission(block.input)
                        results.append({"type": "tool_result", "tool_use_id": block.id, "content": "Ergebnis übernommen."})
                    except ToolInputError as exc:
                        results.append({"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                                        "content": f"Ergebnis ungültig: {exc}. Bitte korrigiert erneut abgeben."})
                    continue
                emit("tool_call", {"tool": block.name, "input": block.input})
                content, is_error = executor.run(block.name, block.input)
                emit("tool_result", {"tool": block.name, "is_error": is_error, "preview": _preview(content)})
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": content, "is_error": is_error})

            if submission is not None:
                return submission, usage

            remaining = self.settings.max_steps - step
            if remaining <= 2:
                results.append({"type": "text", "text": f"Nur noch {remaining} Runde(n) übrig - gib dein Ergebnis jetzt mit `{SUBMIT_TOOL}` ab."})
            messages.append({"role": "user", "content": results})

        raise RuntimeError("Der Agent hat innerhalb des Schrittlimits kein Ergebnis abgegeben (ORTFINDER_MAX_STEPS erhöhen).")

    @staticmethod
    def _emit_blocks(response: Any, emit: Emit) -> None:
        for block in response.content:
            kind = block.type
            if kind == "thinking" and getattr(block, "thinking", ""):
                emit("thinking", {"text": block.thinking})
            elif kind == "text" and block.text.strip():
                emit("note", {"text": block.text})
            elif kind == "server_tool_use":
                inp = block.input or {}
                if block.name == "web_search":
                    emit("web_search", {"query": str(inp.get("query", ""))})
                elif block.name == "web_fetch":
                    emit("web_search", {"query": str(inp.get("url", "")), "fetch": True})
            elif kind == "web_search_tool_result":
                content = block.content
                if isinstance(content, list):
                    emit("web_results", {"results": [{"title": r.title, "url": r.url} for r in content[:6]]})
                else:
                    emit("web_results", {"error": getattr(content, "error_code", "unbekannt")})
            elif kind == "fallback":
                emit("status", {"message": f"Modellwechsel: {block.from_.model} → {block.to.model}"})


def _preview(content: list[dict[str, Any]] | str) -> str:
    """Short human-readable version of a tool result for the live log."""
    if isinstance(content, str):
        text = content
        try:
            data = json.loads(content)
        except ValueError:
            data = None
        if isinstance(data, list) and data and all(isinstance(d, dict) and "name" in d for d in data):
            text = f"{len(data)} Treffer: " + " | ".join(f"{d['name']} ({d['lat']:.5f}, {d['lon']:.5f})" for d in data[:5])
        elif isinstance(data, dict) and "elements" in data:
            names = [el.get("tags", {}).get("name") or el.get("type") for el in data["elements"][:8]]
            text = f"{data['total']} OSM-Treffer" + (": " + ", ".join(str(n) for n in names) if names else "")
        elif isinstance(data, dict) and "name" in data:
            text = str(data["name"])
    else:
        text = " ".join(c.get("text", "[Bild]") if c.get("type") == "text" else "[Bild]" for c in content)
    return text if len(text) <= 600 else text[:600] + " …"


def summarize(result: dict[str, Any]) -> str:
    """Human-readable German summary for the CLI."""
    lines = []
    final = result.get("final")
    exif = result.get("exif_location")
    if exif:
        lines.append(f"GPS in den Metadaten: {exif['lat']:.6f}, {exif['lon']:.6f}")
        if exif.get("address"):
            lines.append(f"  → {exif['address']}")
    analysis = result.get("analysis")
    if analysis:
        best = analysis["best_guess"]
        lines.append("")
        lines.append(f"Bildanalyse ({analysis['precision']}): {best['name']}")
        lines.append(f"  Koordinaten: {best['lat']:.6f}, {best['lon']:.6f}  (±{best['radius_km']} km, Konfidenz {best['confidence']:.0%})")
        lines.append(f"  https://www.openstreetmap.org/?mlat={best['lat']:.6f}&mlon={best['lon']:.6f}#map=16/{best['lat']:.6f}/{best['lon']:.6f}")
        lines.append("")
        lines.append(analysis["summary"])
        if analysis["candidates"]:
            lines.append("")
            lines.append("Alternativen:")
            for c in analysis["candidates"]:
                lines.append(f"  - {c['name']} ({c['lat']:.4f}, {c['lon']:.4f}, {c['confidence']:.0%})")
        if analysis["clues"]:
            lines.append("")
            lines.append("Hinweise:")
            for c in analysis["clues"]:
                lines.append(f"  [{c['strength']}] {c['description']} → {c['implication']}")
        if "exif_vs_analysis_km" in result:
            lines.append("")
            lines.append(f"Abstand Bildanalyse ↔ echte GPS-Position: {result['exif_vs_analysis_km']} km")
    if not final:
        lines.append("Kein Ort bestimmt.")
    if result.get("usage"):
        u = result["usage"]
        lines.append("")
        lines.append(f"({u['requests']} Anfragen, {u['input_tokens'] + u['cache_read_input_tokens'] + u['cache_creation_input_tokens']} Input-/{u['output_tokens']} Output-Tokens, {result['seconds']} s)")
    return "\n".join(lines)


def to_json(result: dict[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False, indent=2)

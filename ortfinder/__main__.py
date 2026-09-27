"""Kommandozeile: python -m ortfinder BILD [--json]  |  python -m ortfinder --web"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

from .config import EFFORT_LEVELS, load_settings


def _print_event(type_: str, data: dict[str, Any]) -> None:
    line = None
    if type_ in ("status", "warning"):
        line = data["message"]
    elif type_ == "step":
        line = f"── Runde {data['step']}/{data['max_steps']}"
    elif type_ == "thinking":
        line = "💭 " + data["text"].strip().replace("\n", " ")[:300]
    elif type_ == "note":
        line = "📝 " + data["text"].strip().replace("\n", " ")[:300]
    elif type_ == "zoom":
        b = data["box"]
        line = f"🔍 Zoom #{data['index']} [{b[0]:.2f},{b[1]:.2f} – {b[2]:.2f},{b[3]:.2f}] {data['purpose']}"
    elif type_ == "tool_call" and data["tool"] != "zoom_image":
        line = f"🗺️  {data['tool']}: {data['input']}"
    elif type_ == "tool_result" and data["tool"] != "zoom_image":
        line = ("   ⚠ " if data["is_error"] else "   → ") + data["preview"][:200]
    elif type_ == "web_search":
        line = "🌐 Websuche: " + data["query"]
    elif type_ == "exif_location":
        line = f"📍 GPS in den Metadaten gefunden: {data['lat']}, {data['lon']}"
    if line:
        print(line, file=sys.stderr, flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ortfinder", description="Findet heraus, wo ein Foto aufgenommen wurde.")
    parser.add_argument("image", nargs="?", help="Pfad zum Bild")
    parser.add_argument("--web", action="store_true", help="Weboberfläche starten statt ein Bild zu analysieren")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--json", action="store_true", help="Ergebnis als JSON ausgeben")
    parser.add_argument("--only-metadata", action="store_true", help="Nur EXIF auswerten, keine KI")
    parser.add_argument("--no-web-search", action="store_true", help="Websuche des Modells abschalten")
    parser.add_argument("--effort", choices=EFFORT_LEVELS, help="Denkaufwand des Modells")
    parser.add_argument("--model", help="Claude-Modell (Standard: claude-opus-5)")
    parser.add_argument("--quiet", action="store_true", help="Keine Zwischenschritte anzeigen")
    args = parser.parse_args(argv)

    if args.web:
        import uvicorn

        from .server import create_app

        print(f"Ortfinder läuft auf http://127.0.0.1:{args.port}", file=sys.stderr)
        uvicorn.run(create_app(), host="127.0.0.1", port=args.port, log_level="warning")
        return 0
    if not args.image:
        parser.error("Bildpfad angeben oder --web verwenden")

    settings = load_settings()
    if args.no_web_search:
        settings = replace(settings, web_search=False)
    if args.effort:
        settings = replace(settings, effort=args.effort)
    if args.model:
        settings = replace(settings, model=args.model)

    use_ai = not args.only_metadata
    if use_ai and not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        print("Hinweis: Kein ANTHROPIC_API_KEY gesetzt - werte nur die Metadaten aus.", file=sys.stderr)
        use_ai = False

    from .agent import Geolocator, summarize, to_json
    from .server import describe_error

    data = Path(args.image).read_bytes()
    try:
        result = Geolocator(settings).locate(data, emit=(lambda *_: None) if args.quiet else _print_event, use_ai=use_ai)
    except Exception as exc:  # noqa: BLE001
        print(f"Fehler: {describe_error(exc)}", file=sys.stderr)
        return 1
    print(to_json(result) if args.json else "\n" + summarize(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())

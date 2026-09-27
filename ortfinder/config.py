"""Runtime configuration, read from environment variables (optionally a .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader so users don't need python-dotenv. Existing env vars win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.split(" #", 1)[0].strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in ("0", "false", "no", "off", "")


@dataclass(frozen=True)
class Settings:
    model: str
    effort: str
    max_steps: int
    web_search: bool
    web_search_max_uses: int
    contact: str
    nominatim_url: str
    overpass_url: str

    @property
    def user_agent(self) -> str:
        return f"Ortfinder/0.1 (+https://github.com/germanclaude/ortfinder; {self.contact})"


def load_settings() -> Settings:
    _load_dotenv(Path.cwd() / ".env")
    effort = os.environ.get("ORTFINDER_EFFORT", "high").strip().lower()
    if effort not in EFFORT_LEVELS:
        raise ValueError(f"ORTFINDER_EFFORT muss einer von {EFFORT_LEVELS} sein, nicht {effort!r}")
    return Settings(
        model=os.environ.get("ORTFINDER_MODEL", "claude-opus-5").strip(),
        effort=effort,
        max_steps=int(os.environ.get("ORTFINDER_MAX_STEPS", "30")),
        web_search=_flag("ORTFINDER_WEB_SEARCH", True),
        web_search_max_uses=int(os.environ.get("ORTFINDER_WEB_SEARCH_MAX_USES", "10")),
        contact=os.environ.get("ORTFINDER_CONTACT", "no-contact-configured"),
        nominatim_url=os.environ.get("ORTFINDER_NOMINATIM_URL", "https://nominatim.openstreetmap.org"),
        overpass_url=os.environ.get(
            "ORTFINDER_OVERPASS_URL",
            "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,"
            "https://overpass.private.coffee/api/interpreter",
        ),
    )

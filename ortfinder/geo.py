"""OpenStreetMap lookups (Nominatim, Overpass) and small geo helpers."""

from __future__ import annotations

import math
import threading
import time
from datetime import datetime, timezone
from typing import Any

import httpx

EARTH_RADIUS_KM = 6371.0088

_PRIORITY_TAGS = (
    "name", "brand", "operator", "amenity", "shop", "tourism", "leisure", "building", "highway",
    "railway", "public_transport", "historic", "man_made", "natural", "addr:street",
    "addr:housenumber", "addr:postcode", "addr:city", "ref", "website", "denomination",
)
_MAX_TAGS = 16
_MAX_OVERPASS_ELEMENTS = 60


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def sun_position(lat: float, lon: float, when: datetime) -> dict[str, float]:
    """Approximate solar azimuth/elevation (degrees, azimuth clockwise from north).

    Low-precision almanac formulas; good to roughly 0.5 degrees, which is plenty
    for comparing against shadows in a photo.
    """
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    jd = when.timestamp() / 86400.0 + 2440587.5
    n = jd - 2451545.0
    mean_lon = math.radians((280.460 + 0.9856474 * n) % 360)
    mean_anom = math.radians((357.528 + 0.9856003 * n) % 360)
    ecl_lon = mean_lon + math.radians(1.915) * math.sin(mean_anom) + math.radians(0.020) * math.sin(2 * mean_anom)
    obliquity = math.radians(23.439 - 0.0000004 * n)
    ra = math.atan2(math.cos(obliquity) * math.sin(ecl_lon), math.cos(ecl_lon))
    dec = math.asin(math.sin(obliquity) * math.sin(ecl_lon))
    gmst_hours = (18.697374558 + 24.06570982441908 * n) % 24
    hour_angle = math.radians(gmst_hours * 15 + lon) - ra
    phi = math.radians(lat)
    elevation = math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(hour_angle))
    azimuth = math.atan2(-math.sin(hour_angle), math.cos(phi) * math.tan(dec) - math.sin(phi) * math.cos(hour_angle))
    elev_deg = math.degrees(elevation)
    result = {
        "azimuth_deg": round(math.degrees(azimuth) % 360, 1),
        "elevation_deg": round(elev_deg, 1),
    }
    if elev_deg > 0.5:
        # Shadow length of a 1 m tall vertical object, pointing away from the sun.
        result["shadow_length_per_meter"] = round(1 / math.tan(elevation), 2)
        result["shadow_direction_deg"] = round((result["azimuth_deg"] + 180) % 360, 1)
    return result


class OSMError(RuntimeError):
    pass


class OSMClient:
    """Polite client for the public Nominatim and Overpass services (rate limited + cached)."""

    def __init__(self, user_agent: str, nominatim_url: str, overpass_url: str, http: httpx.Client | None = None):
        self._http = http or httpx.Client(timeout=httpx.Timeout(40.0, connect=10.0), headers={"User-Agent": user_agent})
        self._nominatim = nominatim_url.rstrip("/")
        # Comma-separated list: public Overpass instances are often busy, so we fail over.
        self._overpass = [u.strip() for u in overpass_url.split(",") if u.strip()]
        self._lock = threading.Lock()
        self._last_nominatim = 0.0
        self._cache: dict[tuple, Any] = {}

    def _nominatim_get(self, path: str, params: dict[str, Any]) -> Any:
        key = (path, tuple(sorted(params.items())))
        if key in self._cache:
            return self._cache[key]
        with self._lock:
            # Nominatim usage policy: at most one request per second.
            wait = 1.05 - (time.monotonic() - self._last_nominatim)
            if wait > 0:
                time.sleep(wait)
            try:
                resp = self._http.get(f"{self._nominatim}/{path}", params={**params, "format": "jsonv2"})
            except httpx.HTTPError as exc:
                raise OSMError(f"Nominatim nicht erreichbar ({type(exc).__name__})") from exc
            finally:
                self._last_nominatim = time.monotonic()
        if resp.status_code == 429:
            raise OSMError("Nominatim: zu viele Anfragen (HTTP 429). Etwas warten oder Overpass/Websuche nutzen.")
        if resp.status_code != 200:
            raise OSMError(f"Nominatim antwortete mit HTTP {resp.status_code}")
        data = resp.json()
        self._cache[key] = data
        return data

    def geocode(self, query: str, country_codes: str = "", limit: int = 5) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"q": query, "limit": max(1, min(int(limit), 10)), "addressdetails": 1, "accept-language": "de"}
        if country_codes.strip():
            params["countrycodes"] = country_codes.strip().lower()
        data = self._nominatim_get("search", params)
        return [
            {
                "name": item.get("display_name"),
                "lat": float(item["lat"]),
                "lon": float(item["lon"]),
                "kind": f"{item.get('category', item.get('class', ''))}/{item.get('type', '')}",
                "importance": round(float(item.get("importance") or 0), 3),
                "boundingbox": item.get("boundingbox"),
            }
            for item in data
        ]

    def reverse(self, lat: float, lon: float, zoom: int = 18) -> dict[str, Any]:
        data = self._nominatim_get(
            "reverse", {"lat": f"{lat:.7f}", "lon": f"{lon:.7f}", "zoom": max(3, min(int(zoom), 18)), "addressdetails": 1, "accept-language": "de"}
        )
        if "error" in data:
            return {"error": data["error"]}
        return {"name": data.get("display_name"), "address": data.get("address", {}), "kind": f"{data.get('category', '')}/{data.get('type', '')}"}

    def overpass(self, query: str) -> dict[str, Any]:
        query = query.strip()
        if not query.startswith("["):
            query = "[out:json][timeout:25];" + query
        key = ("overpass", query)
        if key in self._cache:
            return self._cache[key]
        problems = []
        for url in self._overpass:
            try:
                resp = self._http.post(url, data={"data": query})
            except httpx.TimeoutException:
                problems.append("Zeitüberschreitung")
                continue
            except httpx.HTTPError as exc:
                problems.append(f"nicht erreichbar ({type(exc).__name__})")
                continue
            if resp.status_code in (429, 502, 503, 504):
                problems.append(f"HTTP {resp.status_code}")
                continue
            if resp.status_code == 400:
                # Syntax errors are the query's fault; another server won't help.
                raise OSMError(f"Overpass-Syntaxfehler: {resp.text[:400]}")
            if resp.status_code != 200:
                problems.append(f"HTTP {resp.status_code}")
                continue
            try:
                data = resp.json()
            except ValueError as exc:
                raise OSMError("Overpass lieferte kein JSON - fehlt [out:json]?") from exc
            result = summarize_overpass(data)
            self._cache[key] = result
            return result
        raise OSMError(
            "Overpass ist gerade nicht verfügbar oder überlastet (" + ", ".join(problems) + "). "
            "Suchgebiet verkleinern (around-Filter statt ganzes Land) oder geocode/Websuche nutzen."
        )


def _pick_tags(tags: dict[str, str]) -> dict[str, str]:
    if len(tags) <= _MAX_TAGS:
        return dict(tags)
    picked = {k: tags[k] for k in _PRIORITY_TAGS if k in tags}
    for k, v in tags.items():
        if len(picked) >= _MAX_TAGS:
            break
        picked.setdefault(k, v)
    return picked


def summarize_overpass(data: dict[str, Any]) -> dict[str, Any]:
    elements = data.get("elements", [])
    summary = []
    for el in elements:
        if el.get("type") == "count":
            summary.append({"count": el.get("tags", {})})
            continue
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        tags = el.get("tags") or {}
        if lat is None and not tags:
            continue  # bare geometry nodes of ways
        item: dict[str, Any] = {"type": el.get("type"), "id": el.get("id")}
        if lat is not None:
            item["lat"], item["lon"] = round(lat, 6), round(lon, 6)
        if tags:
            item["tags"] = _pick_tags(tags)
        summary.append(item)
    result: dict[str, Any] = {"total": len(summary), "elements": summary[:_MAX_OVERPASS_ELEMENTS]}
    if len(summary) > _MAX_OVERPASS_ELEMENTS:
        result["note"] = f"Nur die ersten {_MAX_OVERPASS_ELEMENTS} von {len(summary)} Treffern gezeigt - Abfrage eingrenzen."
    if data.get("remark"):
        result["remark"] = data["remark"]
    return result

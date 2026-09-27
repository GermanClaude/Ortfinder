from datetime import datetime, timezone

import httpx
import pytest

from ortfinder.geo import OSMClient, OSMError, haversine_km, summarize_overpass, sun_position


def test_haversine_berlin_munich():
    assert haversine_km(52.5200, 13.4050, 48.1351, 11.5820) == pytest.approx(504, abs=3)


def test_sun_at_berlin_solstice_noon():
    pos = sun_position(52.52, 13.405, datetime(2024, 6, 21, 11, 10, tzinfo=timezone.utc))
    assert pos["elevation_deg"] == pytest.approx(61, abs=1)
    assert pos["azimuth_deg"] == pytest.approx(180, abs=5)
    assert pos["shadow_direction_deg"] == pytest.approx(0, abs=5) or pos["shadow_direction_deg"] > 355


def test_sun_in_sydney_morning_is_east_and_north():
    # 22:00 UTC = 08:00 AEST, southern hemisphere winter: sun rises in the north-east.
    pos = sun_position(-33.87, 151.21, datetime(2024, 6, 20, 22, 0, tzinfo=timezone.utc))
    assert 0 < pos["elevation_deg"] < 20
    assert 40 < pos["azimuth_deg"] < 90


def test_sun_below_horizon_at_night():
    pos = sun_position(52.52, 13.405, datetime(2024, 12, 21, 23, 0, tzinfo=timezone.utc))
    assert pos["elevation_deg"] < 0
    assert "shadow_length_per_meter" not in pos


def test_overpass_summary_truncates_and_uses_centers():
    data = {"elements": [{"type": "way", "id": i, "center": {"lat": 1.0, "lon": 2.0}, "tags": {"name": f"W{i}"}} for i in range(70)]}
    data["elements"].append({"type": "node", "id": 999, "lat": 1.0, "lon": 2.0})  # bare node without tags is kept
    summary = summarize_overpass(data)
    assert summary["total"] == 71
    assert len(summary["elements"]) == 60
    assert summary["elements"][0] == {"type": "way", "id": 0, "lat": 1.0, "lon": 2.0, "tags": {"name": "W0"}}
    assert "note" in summary


def _client(handler) -> OSMClient:
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return OSMClient("test-agent", "https://nominatim.test", "https://overpass.test/api/interpreter", http=http)


def test_geocode_parses_and_caches():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=[{"display_name": "Freiburg", "lat": "47.99", "lon": "7.85", "category": "boundary", "type": "administrative", "importance": 0.7}])

    osm = _client(handler)
    first = osm.geocode("Freiburg", "de", 3)
    second = osm.geocode("Freiburg", "de", 3)
    assert first == second
    assert first[0]["lat"] == 47.99 and first[0]["kind"] == "boundary/administrative"
    assert len(calls) == 1
    assert calls[0].url.params["countrycodes"] == "de"
    assert calls[0].url.params["format"] == "jsonv2"


def test_overpass_adds_output_header_and_reports_overload():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.content.decode())
        return httpx.Response(429)

    with pytest.raises(OSMError, match="überlastet"):
        _client(handler).overpass('node["name"="X"];out;')
    assert "out%3Ajson" in seen[0] or "[out:json]" in seen[0]


def test_overpass_fails_over_to_next_server_and_reports_syntax_errors():
    hosts = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        if request.url.host == "busy.test":
            return httpx.Response(503)
        if b"broken" in request.content:
            return httpx.Response(400, text="parse error")
        return httpx.Response(200, json={"elements": [{"type": "node", "id": 1, "lat": 1, "lon": 2, "tags": {"name": "A"}}]})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    osm = OSMClient("ua", "https://n.test", "https://busy.test/api, https://ok.test/api", http=http)
    assert osm.overpass("node(1);out;")["total"] == 1
    assert hosts == ["busy.test", "ok.test"]
    with pytest.raises(OSMError, match="Syntaxfehler"):
        osm.overpass("broken")


def test_network_errors_become_osm_errors():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("reset")

    with pytest.raises(OSMError, match="nicht erreichbar"):
        _client(handler).geocode("x")
    with pytest.raises(OSMError, match="nicht erreichbar"):
        _client(handler).overpass("node(1);out;")

import copy
from types import SimpleNamespace

import pytest
from conftest import VALID_SUBMISSION, FakeClient, FakeOSM, make_jpeg, response, settings, text, tool_use

from ortfinder.agent import Geolocator, _echo_content, summarize


def run(responses, data=None, **settings_overrides):
    client = FakeClient(responses)
    osm = FakeOSM()
    events = []
    geo = Geolocator(settings(**settings_overrides), client=client, osm=osm)
    result = geo.locate(data or make_jpeg(), emit=lambda t, d: events.append((t, d)))
    return result, client, osm, events


def test_agent_zooms_searches_and_submits():
    result, client, osm, events = run([
        response([text("Ich sehe ein Schild."), tool_use("t1", "zoom_image", {"x_min": 0.7, "y_min": 0.6, "x_max": 0.85, "y_max": 0.75, "enhance": True, "purpose": "Straßenschild"}),
                  tool_use("t2", "geocode", {"query": "Bahnhofstraße", "country_codes": "de", "limit": 5})], "tool_use"),
        response([tool_use("t3", "submit_result", VALID_SUBMISSION)], "tool_use"),
    ])
    assert result["final"]["source"] == "visual_analysis"
    assert result["final"]["lat"] == 47.99 and result["final"]["precision"] == "strasse"
    assert result["usage"]["requests"] == 2 and result["usage"]["input_tokens"] == 200

    first = client.requests[0]
    assert first["model"] == "claude-opus-5"
    assert first["fallbacks"] == "default" and first["betas"] == ["server-side-fallback-2026-07-01"]
    assert first["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert first["output_config"] == {"effort": "high"}
    images = [b for b in first["messages"][0]["content"] if b["type"] == "image"]
    assert len(images) == 2  # photo + grid

    # Both tool results come back in one user message, in order.
    tool_msg = client.requests[1]["messages"][-1]
    assert tool_msg["role"] == "user"
    assert [r["tool_use_id"] for r in tool_msg["content"]] == ["t1", "t2"]
    assert tool_msg["content"][0]["content"][1]["type"] == "image"
    assert ("geocode", "Bahnhofstraße", "de", 5) in osm.calls

    types = [t for t, _ in events]
    assert types[0] == "status" and "zoom" in types and types[-1] == "result"
    assert "Freiburg" in summarize(result)


def test_exif_gps_wins_and_blind_test_distance_is_reported():
    result, client, osm, _ = run([response([tool_use("t1", "submit_result", VALID_SUBMISSION)], "tool_use")], data=make_jpeg(gps=(48.0, 7.85)))
    assert result["final"]["source"] == "exif_gps"
    assert result["final"]["lat"] == 48.0
    assert result["exif_location"]["address"] == "Bahnhofstraße 1, Freiburg"
    assert result["exif_vs_analysis_km"] == pytest.approx(1.1, abs=0.1)
    # The model must not be told the GPS position.
    first_text = client.requests[0]["messages"][0]["content"][0]["text"]
    assert "48.0" not in first_text and "7.85" not in first_text


def test_metadata_only_mode_makes_no_model_calls():
    client = FakeClient([])
    result = Geolocator(settings(), client=client, osm=FakeOSM()).locate(make_jpeg(gps=(10.0, 20.0)), use_ai=False)
    assert client.requests == []
    assert result["final"]["lat"] == 10.0 and "analysis" not in result


def test_invalid_submission_gets_error_result_then_retry():
    bad = copy.deepcopy(VALID_SUBMISSION)
    bad["precision"] = "irgendwo"
    result, client, _, _ = run([
        response([tool_use("t1", "submit_result", bad)], "tool_use"),
        response([tool_use("t2", "submit_result", VALID_SUBMISSION)], "tool_use"),
    ])
    retry_msg = client.requests[1]["messages"][-1]["content"][0]
    assert retry_msg["is_error"] is True and "precision" in retry_msg["content"]
    assert result["analysis"]["precision"] == "strasse"


def test_end_turn_without_submission_is_nudged():
    result, client, _, _ = run([
        response([text("Ich denke, es ist Freiburg.")], "end_turn"),
        response([tool_use("t1", "submit_result", VALID_SUBMISSION)], "tool_use"),
    ])
    assert "submit_result" in client.requests[1]["messages"][-1]["content"]
    assert result["analysis"]["city"] == "Freiburg"


def test_pause_turn_is_resumed_without_user_message():
    paused = response([SimpleNamespace(type="server_tool_use", id="s1", name="web_search", input={"query": "Bahnhofstraße Freiburg"})], "pause_turn")
    result, client, _, events = run([paused, response([tool_use("t1", "submit_result", VALID_SUBMISSION)], "tool_use")])
    assert client.requests[1]["messages"][-1]["role"] == "assistant"
    assert ("web_search", {"query": "Bahnhofstraße Freiburg"}) in events


def test_truncated_tool_call_is_not_executed():
    _, client, osm, _ = run([
        response([tool_use("t1", "geocode", {"query": "Bahnh"})], "max_tokens"),
        response([tool_use("t2", "submit_result", VALID_SUBMISSION)], "tool_use"),
    ])
    assert osm.calls == []
    assert client.requests[1]["messages"][-1]["content"][0]["is_error"] is True


def test_refusal_raises():
    with pytest.raises(RuntimeError, match="abgelehnt"):
        run([response([], "refusal")])


def test_step_limit_raises_and_warns_model():
    loop = [response([tool_use(f"t{i}", "geocode", {"query": "x", "country_codes": "", "limit": 1})], "tool_use") for i in range(3)]
    with pytest.raises(RuntimeError, match="Schrittlimit"):
        run(loop, max_steps=3)


def test_echo_content_drops_declined_attempt():
    blocks = [
        SimpleNamespace(type="thinking", thinking=""),
        text("Teilantwort"),
        SimpleNamespace(type="tool_use", id="x", name="geocode", input={}),
        SimpleNamespace(type="fallback"),
        text("Neue Antwort"),
    ]
    assert [b.type for b in _echo_content(blocks)] == ["text", "text"]
    assert _echo_content(blocks[:3]) == blocks[:3]

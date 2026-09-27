"""Runs the agent against the real Anthropic SDK with a mocked HTTP transport.

Checks what actually goes over the wire (headers, body shape) and that SDK response
objects - thinking and tool_use blocks - are accepted when echoed back.
"""

import json

import anthropic
import httpx2
from conftest import VALID_SUBMISSION, FakeOSM, make_jpeg, settings

from ortfinder.agent import Geolocator


def _message(content, stop_reason):
    return {
        "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-opus-5",
        "content": content, "stop_reason": stop_reason, "stop_sequence": None,
        "usage": {"input_tokens": 1000, "output_tokens": 200, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 900},
    }


def test_requests_on_the_wire():
    replies = [
        _message([
            {"type": "thinking", "thinking": "Schild prüfen", "signature": "sig-1"},
            {"type": "tool_use", "id": "toolu_1", "name": "geocode", "input": {"query": "Bahnhofstraße", "country_codes": "de", "limit": 3}},
        ], "tool_use"),
        _message([{"type": "tool_use", "id": "toolu_2", "name": "submit_result", "input": VALID_SUBMISSION}], "tool_use"),
    ]
    sent = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append((dict(request.headers), json.loads(request.content)))
        return httpx2.Response(200, json=replies[len(sent) - 1])

    client = anthropic.Anthropic(api_key="test", http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(handler)))
    result = Geolocator(settings(), client=client, osm=FakeOSM()).locate(make_jpeg())

    assert result["analysis"]["city"] == "Freiburg"
    headers, body = sent[0]
    assert "server-side-fallback-2026-07-01" in headers["anthropic-beta"]
    assert body["fallbacks"] == "default"
    assert body["cache_control"] == {"type": "ephemeral"}
    assert body["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert "temperature" not in body and "tool_choice" not in body
    assert {t["name"] for t in body["tools"]} >= {"zoom_image", "geocode", "overpass_query", "submit_result", "web_search"}

    _, second = sent[1]
    assistant = second["messages"][1]
    assert assistant["role"] == "assistant"
    assert assistant["content"][0] == {"type": "thinking", "thinking": "Schild prüfen", "signature": "sig-1"}
    assert assistant["content"][1]["type"] == "tool_use"
    assert second["messages"][2]["content"][0]["tool_use_id"] == "toolu_1"

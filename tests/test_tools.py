import copy
import json

import pytest
from conftest import VALID_SUBMISSION, FakeOSM
from PIL import Image

from ortfinder.tools import CLIENT_TOOLS, ToolExecutor, ToolInputError, build_tools, validate_submission


def test_strict_schemas_require_every_property():
    def check(schema):
        if schema.get("type") == "object":
            assert schema["additionalProperties"] is False
            assert set(schema["required"]) == set(schema["properties"])
            for sub in schema["properties"].values():
                check(sub)
        elif schema.get("type") == "array":
            check(schema["items"])

    for tool in CLIENT_TOOLS:
        assert tool["strict"] is True
        check(tool["input_schema"])


def test_web_search_tool_is_optional():
    assert any(t.get("type") == "web_search_20260209" for t in build_tools(True, 3))
    assert not any("type" in t for t in build_tools(False, 3))


def test_valid_submission_is_normalized():
    raw = copy.deepcopy(VALID_SUBMISSION)
    raw["best_guess"]["confidence"] = 1.7
    raw["clues"][0]["box"] = [0.8, 0.7, 0.75, 0.66]
    raw["clues"].append({"category": "erfunden", "description": "x", "implication": "y", "strength": "sehr", "box": [1, 2]})
    raw["candidates"].append({"name": "kaputt", "lat": 200, "lon": 0, "radius_km": 1, "confidence": 0.1, "rationale": ""})
    result = validate_submission(raw)
    assert result["best_guess"]["confidence"] == 1.0
    assert result["clues"][0]["box"] == [0.75, 0.66, 0.8, 0.7]
    assert result["clues"][1]["category"] == "sonstiges" and result["clues"][1]["box"] == []
    assert [c["name"] for c in result["candidates"]] == ["Offenburg"]


@pytest.mark.parametrize("mutate", [
    lambda s: s.update(precision="ungefähr"),
    lambda s: s["best_guess"].update(lat=95),
    lambda s: s["best_guess"].update(lon="7.8"),
    lambda s: s.update(summary="  "),
    lambda s: s.pop("best_guess"),
])
def test_invalid_submission_is_rejected(mutate):
    raw = copy.deepcopy(VALID_SUBMISSION)
    mutate(raw)
    with pytest.raises(ToolInputError):
        validate_submission(raw)


@pytest.fixture
def executor():
    events = []
    ex = ToolExecutor(Image.new("RGB", (2000, 1000), "gray"), FakeOSM(), lambda t, d: events.append((t, d)))
    ex.events = events
    return ex


def test_zoom_returns_image_and_emits_thumbnail(executor):
    content, is_error = executor.run("zoom_image", {"x_min": 0.1, "y_min": 0.1, "x_max": 0.2, "y_max": 0.3, "enhance": True, "purpose": "Schild"})
    assert not is_error
    assert content[0]["type"] == "text" and "200x200 Originalpixel" in content[0]["text"]
    assert content[1]["type"] == "image" and content[1]["source"]["media_type"] == "image/jpeg"
    event_type, data = executor.events[0]
    assert event_type == "zoom" and data["thumbnail"].startswith("data:image/jpeg;base64,")


def test_zoom_with_empty_area_is_an_error(executor):
    content, is_error = executor.run("zoom_image", {"x_min": 0.5, "y_min": 0.1, "x_max": 0.5, "y_max": 0.3, "enhance": False, "purpose": ""})
    assert is_error and "keine Fläche" in content


def test_geocode_and_bad_input(executor):
    content, is_error = executor.run("geocode", {"query": "Bahnhofstraße Freiburg", "country_codes": "de", "limit": 3})
    assert not is_error and json.loads(content)[0]["lat"] == 47.99
    content, is_error = executor.run("geocode", {"query": "", "country_codes": "", "limit": 3})
    assert is_error


def test_sun_position_tool(executor):
    content, is_error = executor.run("sun_position", {"lat": 52.5, "lon": 13.4, "datetime_utc": "2024-06-21T11:10:00Z"})
    assert not is_error and json.loads(content)["elevation_deg"] > 55


def test_unknown_tool_and_non_dict_input(executor):
    assert executor.run("rm_rf", {})[1] is True
    assert executor.run("geocode", "not a dict")[1] is True

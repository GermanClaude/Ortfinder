import assert from "node:assert/strict";
import { test } from "node:test";

import { VALID_SUBMISSION } from "./fixtures.mjs";
import { FUNCTION_TOOLS, ToolExecutor, ToolInputError, buildTools, normalizeBox, validateSubmission } from "../../docs/js/tools.js";


test("every declared required field exists and google_search is optional", () => {
  for (const tool of FUNCTION_TOOLS) {
    assert.equal(tool.type, "function");
    for (const key of tool.parameters.required) assert.ok(key in tool.parameters.properties, `${tool.name}.${key}`);
  }
  assert.deepEqual(buildTools(true).at(-1), { type: "google_search" });
  assert.ok(!buildTools(false).some((t) => t.type === "google_search"));
});

test("normalizeBox clamps and sorts", () => assert.deepEqual(normalizeBox(1.2, 0.8, -0.1, 0.2), [0, 0.2, 1, 0.8]));

test("valid submissions are normalized", () => {
  const raw = structuredClone(VALID_SUBMISSION);
  raw.camera.confidence = 1.7;
  raw.clues[0].box = [0.8, 0.7, 0.75, 0.66];
  raw.clues.push({ category: "erfunden", description: "x", implication: "y", strength: "sehr", box: [1, 2] });
  raw.candidates.push({ name: "kaputt", lat: 200, lon: 0, radius_km: 1, confidence: 0.1 });
  const r = validateSubmission(raw);
  assert.equal(r.camera.confidence, 1);
  assert.deepEqual(r.subject, { name: "Martinstor", lat: 47.9925, lon: 7.8495, radius_km: 0.05 });
  assert.deepEqual(r.view, { bearing_deg: 350, fov_deg: 65, distance_m: 280 });
  assert.deepEqual(r.clues[0].box, [0.75, 0.66, 0.8, 0.7]);
  assert.equal(r.clues[1].category, "sonstiges");
  assert.deepEqual(r.clues[1].box, []);
  assert.deepEqual(r.candidates.map((c) => c.name), ["Offenburg"]);
});

for (const [label, mutate] of [
  ["precision", (s) => { s.precision = "ungefähr"; }],
  ["lat range", (s) => { s.camera.lat = 95; }],
  ["lon type", (s) => { s.camera.lon = "7.8"; }],
  ["summary", (s) => { s.summary = " "; }],
  ["camera", (s) => { delete s.camera; }],
]) {
  test(`invalid submission is rejected: ${label}`, () => {
    const raw = structuredClone(VALID_SUBMISSION);
    mutate(raw);
    assert.throws(() => validateSubmission(raw), ToolInputError);
  });
}

function executor() {
  const events = [];
  const zoomCalls = [];
  const osm = {
    geocode: async (q, cc, limit) => [{ name: `${q}, Deutschland`, lat: 47.99, lon: 7.85, kind: "highway/residential", importance: 0.4 }],
    reverse: async () => ({ name: "Bahnhofstraße 1, Freiburg" }),
    overpass: async () => ({ total: 0, elements: [] }),
  };
  const ex = new ToolExecutor({
    zoom: async (box, enhance) => {
      zoomCalls.push({ box, enhance });
      return { data: "QUJD", width: 1024, height: 512, sourceWidth: 200, sourceHeight: 100, thumbnail: "data:image/jpeg;base64,QUJD" };
    },
    osm,
    emit: (t, d) => events.push([t, d]),
  });
  return { ex, events, zoomCalls };
}

test("zoom returns text + image and emits a thumbnail", async () => {
  const { ex, events, zoomCalls } = executor();
  const { result, isError } = await ex.run("zoom_image", { x_min: 0.2, y_min: 0.1, x_max: 0.1, y_max: 0.3, enhance: true, purpose: "Schild" });
  assert.equal(isError, false);
  assert.deepEqual(zoomCalls[0], { box: [0.1, 0.1, 0.2, 0.3], enhance: true });
  assert.match(result[0].text, /200x100 Originalpixel/);
  assert.deepEqual(result[1], { type: "image", mime_type: "image/jpeg", data: "QUJD", resolution: "high" });
  assert.equal(events[0][0], "zoom");
});

test("zoom without area, bad input and unknown tools are errors", async () => {
  const { ex } = executor();
  assert.equal((await ex.run("zoom_image", { x_min: 0.5, y_min: 0.1, x_max: 0.5, y_max: 0.3 })).isError, true);
  assert.equal((await ex.run("geocode", { query: "" })).isError, true);
  assert.equal((await ex.run("geocode", "not an object")).isError, true);
  assert.equal((await ex.run("rm_rf", {})).isError, true);
});

test("geocode and sun_position", async () => {
  const { ex } = executor();
  const geo = await ex.run("geocode", { query: "Bahnhofstraße", country_codes: "de" });
  assert.equal(JSON.parse(geo.result)[0].lat, 47.99);
  const sun = await ex.run("sun_position", { lat: 52.5, lon: 13.4, datetime_utc: "2024-06-21T11:10:00" });
  assert.equal(sun.isError, false);
  assert.ok(JSON.parse(sun.result).elevation_deg > 55);
  assert.equal((await ex.run("sun_position", { lat: 52.5, lon: 13.4, datetime_utc: "gestern" })).isError, true);
});

test("zoom limit protects the request size", async () => {
  const { ex } = executor();
  ex.maxZooms = 1;
  const args = { x_min: 0, y_min: 0, x_max: 0.5, y_max: 0.5, purpose: "" };
  assert.equal((await ex.run("zoom_image", args)).isError, false);
  const second = await ex.run("zoom_image", args);
  assert.equal(second.isError, true);
  assert.match(second.result, /Zoom-Limit/);
});

test("view direction is derived from camera → subject when the model leaves it out", () => {
  const raw = structuredClone(VALID_SUBMISSION);
  raw.view = {};
  const r = validateSubmission(raw);
  assert.ok(Math.abs(r.view.bearing_deg - 352.4) < 0.5, `bearing ${r.view.bearing_deg}`);
  assert.ok(Math.abs(r.view.distance_m - 280) < 3, `distance ${r.view.distance_m}`);
  assert.equal(r.view.fov_deg, 65);
  const noSubject = structuredClone(VALID_SUBMISSION);
  noSubject.subject = { name: "x", lat: "?" };
  noSubject.view = {};
  const r2 = validateSubmission(noSubject);
  assert.equal(r2.subject, null);
  assert.equal(r2.view, null);
});

test("mark_hypothesis emits a live map event", async () => {
  const { ex, events } = executor();
  const { result, isError } = await ex.run("mark_hypothesis", { label: "Vermutung: Freiburg", camera_lat: 47.99, camera_lon: 7.85, radius_km: 5, subject_lat: 47.9925, subject_lon: 7.8495 });
  assert.equal(isError, false);
  assert.match(result, /markiert/);
  assert.deepEqual(events.at(-1), ["hypothesis", { label: "Vermutung: Freiburg", camera: { lat: 47.99, lon: 7.85 }, radius_km: 5, subject: { lat: 47.9925, lon: 7.8495 } }]);
  assert.equal((await ex.run("mark_hypothesis", { label: "x", camera_lat: 99, camera_lon: 0, radius_km: 1 })).isError, true);
});

test("bearing_distance and destination_point are inverse", async () => {
  const { ex } = executor();
  const bd = JSON.parse((await ex.run("bearing_distance", { from_lat: 48.0, from_lon: 7.85, to_lat: 48.0, to_lon: 7.86 })).result);
  assert.ok(Math.abs(bd.bearing_deg - 90) < 0.1 && Math.abs(bd.distance_m - 744) < 5, JSON.stringify(bd));
  const dp = JSON.parse((await ex.run("destination_point", { lat: 48.0, lon: 7.85, bearing_deg: 90, distance_m: bd.distance_m })).result);
  assert.ok(Math.abs(dp.lat - 48.0) < 1e-4 && Math.abs(dp.lon - 7.86) < 1e-4, JSON.stringify(dp));
});

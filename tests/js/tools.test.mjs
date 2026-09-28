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
  assert.deepEqual(r.view, { bearing_deg: 350, fov_deg: 65, distance_m: 280, eye_height_m: 1.6, pitch_deg: 0 });
  const high = structuredClone(VALID_SUBMISSION);
  high.view.eye_height_m = 45;
  high.view.pitch_deg = -120;
  assert.deepEqual([validateSubmission(high).view.eye_height_m, validateSubmission(high).view.pitch_deg], [45, -90]);
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

function executor({ withMapView = true } = {}) {
  const events = [];
  const zoomCalls = [];
  const mapCalls = [];
  const osmCalls = [];
  const osm = {
    geocode: async (q, cc, limit) => [{ name: `${q}, Deutschland`, lat: 47.99, lon: 7.85, kind: "highway/residential", importance: 0.4 }],
    reverse: async () => ({ name: "Bahnhofstraße 1, Freiburg" }),
    overpass: async () => ({ total: 0, elements: [] }),
    nearbyFeatures: async (...args) => { osmCalls.push(["nearby", ...args]); return { center: { lat: args[0], lon: args[1] }, radius_m: args[2], total: 0, features: [] }; },
    streetGeometry: async (...args) => { osmCalls.push(["street", ...args]); return { name: args[0], total: 0, ways: [] }; },
  };
  const ex = new ToolExecutor({
    zoom: async (box, enhance) => {
      zoomCalls.push({ box, enhance });
      return { data: "QUJD", width: 1024, height: 512, sourceWidth: 200, sourceHeight: 100, thumbnail: "data:image/jpeg;base64,QUJD" };
    },
    mapView: withMapView
      ? async (opts) => {
        mapCalls.push(opts);
        return { data: "TUFQ", width: 768, height: 768, metersPerPixel: 0.4, spanM: 307, thumbnail: "data:image/jpeg;base64,TUFQ" };
      }
      : undefined,
    renderView: withMapView
      ? async (opts) => {
        mapCalls.push({ render: opts });
        return {
          data: "M0Q=", thumbnail: "data:image/jpeg;base64,M0Q=", note: "",
          stats: { buildings: 12, heights_from_osm_pct: 25, terrain: true, ground_m: 278, building_ahead_m: 41, skyline_distance_m: 5400 },
        };
      }
      : undefined,
    osm,
    emit: (t, d) => events.push([t, d]),
  });
  return { ex, events, zoomCalls, mapCalls, osmCalls };
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

test("map_view returns the aerial image, clamps zoom and emits a thumbnail", async () => {
  const { ex, events, mapCalls } = executor();
  const { result, isError } = await ex.run("map_view", { lat: 47.9925, lon: 7.8495, zoom: 22, layer: "satellit", purpose: "Dächer vergleichen" });
  assert.equal(isError, false);
  assert.deepEqual(mapCalls[0], { lat: 47.9925, lon: 7.8495, zoom: 19, layer: "satellit" });
  assert.match(result[0].text, /Luftbild um 47\.992500, 7\.849500.*307 m breit, 0\.40 m pro Pixel, Norden oben/);
  assert.deepEqual(result[1], { type: "image", mime_type: "image/jpeg", data: "TUFQ", resolution: "high" });
  assert.deepEqual(events.at(-1), ["mapview", { lat: 47.9925, lon: 7.8495, zoom: 19, layer: "satellit", purpose: "Dächer vergleichen", thumbnail: "data:image/jpeg;base64,TUFQ" }]);
  await ex.run("map_view", { lat: 47.9925, lon: 7.8495, zoom: 3, layer: "karte" });
  assert.deepEqual(mapCalls[1], { lat: 47.9925, lon: 7.8495, zoom: 15, layer: "karte" });
});

test("map_view errors: no renderer, bad coordinates, limit", async () => {
  const none = await executor({ withMapView: false }).ex.run("map_view", { lat: 48, lon: 7.8, zoom: 18, layer: "satellit" });
  assert.equal(none.isError, true);
  assert.match(none.result, /nicht verfügbar/);
  const { ex } = executor();
  assert.equal((await ex.run("map_view", { lat: 91, lon: 7.8, zoom: 18, layer: "satellit" })).isError, true);
  ex.maxMapViews = 1;
  assert.equal((await ex.run("map_view", { lat: 48, lon: 7.8, zoom: 18, layer: "satellit" })).isError, false);
  const second = await ex.run("map_view", { lat: 48, lon: 7.8, zoom: 18, layer: "satellit" });
  assert.equal(second.isError, true);
  assert.match(second.result, /Limit/);
});

test("map_view draws the view wedge when a direction is given", async () => {
  const { ex, mapCalls, events } = executor();
  const { result } = await ex.run("map_view", { lat: 48, lon: 7.8, zoom: 18, layer: "satellit", view_bearing_deg: 350, view_fov_deg: 400 });
  assert.deepEqual(mapCalls[0].view, { bearing_deg: 350, fov_deg: 150 });
  assert.match(result[0].text, /Oranger Keil = Sichtfeld 350°/);
  assert.equal(events.at(-1)[0], "mapview");
});

test("render_view normalises the camera and reports what the reconstruction shows", async () => {
  const { ex, mapCalls, events } = executor();
  const { result, isError } = await ex.run("render_view", { lat: 47.9925, lon: 7.8495, bearing_deg: -10, fov_deg: 200, purpose: "Kanten prüfen" });
  assert.equal(isError, false);
  assert.deepEqual(mapCalls[0].render, { lat: 47.9925, lon: 7.8495, bearingDeg: 350, fovDeg: 150, eyeHeight: 1.6, pitchDeg: 0 });
  assert.match(result[0].text, /12 Gebäude sichtbar \(Höhe bei 25 % aus OSM-Angaben/);
  assert.match(result[0].text, /Erstes Gebäude in Blickrichtung \(Bildmitte\): 41 m/);
  assert.match(result[0].text, /Horizont bis 5\.4 km/);
  assert.deepEqual(result[1], { type: "image", mime_type: "image/jpeg", data: "M0Q=", resolution: "high" });
  assert.deepEqual(events.at(-1), ["render", { lat: 47.9925, lon: 7.8495, bearing_deg: 350, fov_deg: 150, purpose: "Kanten prüfen", thumbnail: "data:image/jpeg;base64,M0Q=" }]);
  assert.equal((await ex.run("render_view", { lat: 47.99, lon: 7.85, bearing_deg: 10 })).isError, true, "fov_deg is required");
  const none = await executor({ withMapView: false }).ex.run("render_view", { lat: 47.99, lon: 7.85, bearing_deg: 10, fov_deg: 60 });
  assert.match(none.result, /nicht verfügbar/);
});

test("nearby_features and street_geometry pass through to the OSM client", async () => {
  const { ex, osmCalls } = executor();
  const near = await ex.run("nearby_features", { lat: 47.9925, lon: 7.8495, radius_m: 80 });
  assert.equal(near.isError, false);
  assert.equal(JSON.parse(near.result).radius_m, 80);
  await ex.run("nearby_features", { lat: 47.9925, lon: 7.8495 });
  const street = await ex.run("street_geometry", { name: "Kaiser-Joseph-Straße", lat: 47.9925, lon: 7.8495 });
  assert.equal(JSON.parse(street.result).name, "Kaiser-Joseph-Straße");
  assert.deepEqual(osmCalls, [
    ["nearby", 47.9925, 7.8495, 80],
    ["nearby", 47.9925, 7.8495, 150],
    ["street", "Kaiser-Joseph-Straße", 47.9925, 7.8495, 1500],
  ]);
  assert.equal((await ex.run("street_geometry", { name: "", lat: 47.9925, lon: 7.8495 })).isError, true);
});

test("bearing_distance and destination_point are inverse", async () => {
  const { ex } = executor();
  const bd = JSON.parse((await ex.run("bearing_distance", { from_lat: 48.0, from_lon: 7.85, to_lat: 48.0, to_lon: 7.86 })).result);
  assert.ok(Math.abs(bd.bearing_deg - 90) < 0.1 && Math.abs(bd.distance_m - 744) < 5, JSON.stringify(bd));
  const dp = JSON.parse((await ex.run("destination_point", { lat: 48.0, lon: 7.85, bearing_deg: 90, distance_m: bd.distance_m })).result);
  assert.ok(Math.abs(dp.lat - 48.0) < 1e-4 && Math.abs(dp.lon - 7.86) < 1e-4, JSON.stringify(dp));
});

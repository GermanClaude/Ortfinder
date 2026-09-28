import assert from "node:assert/strict";
import { test } from "node:test";

import { OSMClient, OSMError, bearingDeg, destinationPoint, haversineKm, summarizeOverpass, sunPosition, viewCone } from "../../docs/js/geo.js";

const near = (actual, expected, tol) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} not within ${tol} of ${expected}`);

test("haversine Berlin-München", () => near(haversineKm(52.52, 13.405, 48.1351, 11.582), 504, 3));

test("sun at Berlin solstice noon is high in the south", () => {
  const pos = sunPosition(52.52, 13.405, new Date("2024-06-21T11:10:00Z"));
  near(pos.elevation_deg, 61, 1);
  near(pos.azimuth_deg, 180, 5);
});

test("sun in Sydney winter morning rises north-east", () => {
  const pos = sunPosition(-33.87, 151.21, new Date("2024-06-20T22:00:00Z"));
  assert.ok(pos.elevation_deg > 0 && pos.elevation_deg < 20);
  assert.ok(pos.azimuth_deg > 40 && pos.azimuth_deg < 90);
});

test("sun below horizon at night has no shadow", () => {
  const pos = sunPosition(52.52, 13.405, new Date("2024-12-21T23:00:00Z"));
  assert.ok(pos.elevation_deg < 0);
  assert.equal(pos.shadow_length_per_meter, undefined);
});

test("overpass summary truncates and uses centers", () => {
  const elements = Array.from({ length: 70 }, (_, i) => ({ type: "way", id: i, center: { lat: 1, lon: 2 }, tags: { name: `W${i}` } }));
  const s = summarizeOverpass({ elements });
  assert.equal(s.total, 70);
  assert.equal(s.elements.length, 60);
  assert.deepEqual(s.elements[0], { type: "way", id: 0, lat: 1, lon: 2, tags: { name: "W0" } });
  assert.match(s.note, /60 von 70/);
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("geocode is rate limited, cached and parsed", async () => {
  const calls = [];
  const osm = new OSMClient({
    minIntervalMs: 50,
    fetchImpl: async (url) => {
      calls.push({ url, at: Date.now() });
      return json(200, [{ display_name: "Freiburg", lat: "47.99", lon: "7.85", category: "boundary", type: "administrative", importance: 0.7 }]);
    },
  });
  const [a, b] = await Promise.all([osm.geocode("Freiburg", "DE", 3), osm.geocode("Basel", "", 3)]);
  assert.equal(a[0].lat, 47.99);
  assert.equal(a[0].kind, "boundary/administrative");
  assert.equal(b.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at - calls[0].at >= 45, "requests must be spaced out");
  assert.match(calls[0].url, /countrycodes=de/);
  await osm.geocode("Freiburg", "DE", 3);
  assert.equal(calls.length, 2, "second identical lookup comes from cache");
});

test("overpass fails over and reports syntax errors", async () => {
  const hosts = [];
  const osm = new OSMClient({
    overpassUrls: ["https://busy.test/api", "https://ok.test/api"],
    fetchImpl: async (url, init) => {
      const host = new URL(url).host;
      hosts.push(host);
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      if (host === "busy.test") return new Response("", { status: 503 });
      if (init.body.includes("broken")) return new Response("parse error", { status: 400 });
      assert.ok(decodeURIComponent(init.body).includes("[out:json][timeout:25];"));
      return json(200, { elements: [{ type: "node", id: 1, lat: 1, lon: 2, tags: { name: "A" } }] });
    },
  });
  assert.equal((await osm.overpass("node(1);out;")).total, 1);
  assert.deepEqual(hosts, ["busy.test", "ok.test"]);
  await assert.rejects(osm.overpass("broken"), (err) => err instanceof OSMError && /Syntaxfehler/.test(err.message));
});

test("network failures become OSMError", async () => {
  const osm = new OSMClient({ minIntervalMs: 0, fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(osm.geocode("x"), /nicht erreichbar/);
  await assert.rejects(osm.overpass("node(1);out;"), /nicht verfügbar/);
});

test("bearings, destination points and view cones", () => {
  near(bearingDeg(48, 7.85, 49, 7.85), 0, 0.01);
  near(bearingDeg(48, 7.85, 48, 7.0), 270, 0.5);
  const [lat, lon] = destinationPoint(52.52, 13.405, 180, 10);
  near(haversineKm(52.52, 13.405, lat, lon), 10, 0.001);
  near(bearingDeg(52.52, 13.405, lat, lon), 180, 0.01);
  const cone = viewCone(48, 7.85, 90, 60, 1, 6);
  assert.equal(cone.length, 9);
  assert.deepEqual(cone[0], [48, 7.85]);
  near(bearingDeg(48, 7.85, ...cone[1]), 60, 0.1);
  near(bearingDeg(48, 7.85, ...cone[7]), 120, 0.1);
});

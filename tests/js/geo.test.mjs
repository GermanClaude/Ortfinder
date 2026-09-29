import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OSMClient, OSMError, bearingDeg, closestPointOnLine, describeFeature, destinationPoint, haversineKm, summarizeOverpass, sunPosition, viewCone,
} from "../../docs/js/geo.js";
import { metersPerPixel, scaleBar, tilesFor, worldPixel } from "../../docs/js/mapview.js";

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

test("describeFeature keeps the identifying tags", () => {
  assert.deepEqual(describeFeature({ shop: "bakery", name: "Bäckerei Pfeifer", brand: "Pfeifer", "addr:street": "Bertoldstraße", "addr:housenumber": "5", opening_hours: "Mo-Fr" }), {
    type: "shop=bakery", name: "Bäckerei Pfeifer", brand: "Pfeifer", "addr:street": "Bertoldstraße", "addr:housenumber": "5",
  });
  assert.deepEqual(describeFeature({ highway: "bus_stop", name: "Stadttheater", route_ref: "1;3" }), { type: "highway=bus_stop", name: "Stadttheater", route_ref: "1;3" });
  assert.deepEqual(describeFeature({ foo: "bar" }), { type: "sonstiges" });
});

test("closestPointOnLine projects onto the nearest segment", () => {
  const street = [[48.0, 7.84], [48.0, 7.85], [48.0, 7.86]]; // west → east
  const p = closestPointOnLine(street, 48.001, 7.855);
  near(p.distance_m, 111, 1);
  near(p.lat, 48.0, 1e-6);
  near(p.lon, 7.855, 1e-6);
  assert.equal(p.street_bearing_deg, 90);
  // Beyond the end of the line the end point is the closest point.
  const end = closestPointOnLine(street, 48.0, 7.87);
  near(end.lon, 7.86, 1e-6);
  near(end.distance_m, 745, 3);
});

function overpassClient(elements, queries = []) {
  return new OSMClient({
    overpassUrls: ["https://ok.test/api"],
    fetchImpl: async (url, init) => {
      queries.push(new URLSearchParams(init.body).get("data"));
      return json(200, { elements });
    },
  });
}

test("nearbyFeatures lists named things sorted by distance with direction", async () => {
  const queries = [];
  const osm = overpassClient([
    { type: "way", id: 2, center: { lat: 48.0, lon: 7.851 }, tags: { amenity: "pharmacy", name: "Löwen-Apotheke" } },
    { type: "node", id: 1, lat: 48.0005, lon: 7.85, tags: { shop: "bakery", name: "Bäckerei" } },
    { type: "node", id: 3, lat: 48.0001, lon: 7.85 }, // geometry only
  ], queries);
  const r = await osm.nearbyFeatures(48.0, 7.85, 5);
  assert.equal(r.radius_m, 20, "radius is clamped to at least 20 m");
  assert.match(queries[0], /around:20,48\.000000,7\.850000/);
  assert.deepEqual(r.features.map((f) => [f.name, f.type, f.bearing_deg]), [["Bäckerei", "shop=bakery", 0], ["Löwen-Apotheke", "amenity=pharmacy", 90]]);
  near(r.features[0].distance_m, 56, 1);
  near(r.features[1].distance_m, 74, 1);
  assert.equal(r.total, 2);
});

test("streetGeometry finds the closest point and segment directions", async () => {
  const queries = [];
  const osm = overpassClient([
    { type: "way", id: 7, tags: { highway: "residential", name: 'Am "Tor"', oneway: "yes" }, geometry: [{ lat: 48.0, lon: 7.84 }, { lat: 48.0, lon: 7.85 }, { lat: 48.01, lon: 7.85 }] },
    { type: "way", id: 8, tags: { highway: "residential" }, geometry: [{ lat: 48.0, lon: 7.84 }] }, // no line
  ], queries);
  const r = await osm.streetGeometry('Am "Tor"', 48.0005, 7.845);
  assert.match(queries[0], /\["name"="Am \\"Tor\\""\]\(around:1500,48\.000500,7\.845000\)/);
  assert.equal(r.found, true);
  assert.equal(r.ways.length, 1);
  assert.equal(r.ways[0].oneway, true);
  assert.deepEqual(r.ways[0].segment_bearings_deg, [90, 0]);
  near(r.ways[0].length_m, 745 + 1112, 5);
  assert.equal(r.closest_point.way_id, 7);
  near(r.closest_point.distance_m, 55, 1);
  assert.equal(r.closest_point.street_bearing_deg, 90);
  const none = await overpassClient([]).streetGeometry("Nirgendwo", 48, 7.8);
  assert.equal(none.found, false);
});

test("map tiles: scale, pixel coordinates, tile cover and scale bar", () => {
  near(metersPerPixel(0, 0), 156543.03, 0.01);
  near(metersPerPixel(60, 18), 0.2986, 0.0005);
  assert.deepEqual(worldPixel(0, 0, 0), { x: 128, y: 128 });
  const tiles = tilesFor(0, 0, 1, 256);
  assert.deepEqual(tiles.map((t) => [t.x, t.y, t.dx, t.dy]), [[0, 0, -128, -128], [1, 0, 128, -128], [0, 1, -128, 128], [1, 1, 128, 128]]);
  // Tiles wrap around the date line.
  assert.ok(tilesFor(0, 179.99, 3, 512).some((t) => t.x === 0));
  assert.deepEqual(scaleBar(0.5, 768), { meters: 50, pixels: 100 });
  assert.deepEqual(scaleBar(0.3, 768), { meters: 50, pixels: 50 / 0.3 });
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

test("a server that never answers is left after its time limit; the next one is asked; the total wait is capped", async (t) => {
  const hanging = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  // Node does not wait for AbortSignal.timeout's timer (browsers do): keep the test alive meanwhile.
  const awake = setInterval(() => {}, 1000);
  t.after(() => clearInterval(awake));
  const hosts = [];
  const osm = new OSMClient({
    overpassUrls: ["https://stuck.test/api", "https://ok.test/api"], overpassTimeoutMs: 60, overpassBudgetMs: 1000,
    fetchImpl: async (url, init) => {
      hosts.push(new URL(url).host);
      return new URL(url).host === "stuck.test" ? hanging(init) : json(200, { elements: [] });
    },
  });
  const started = Date.now();
  assert.equal((await osm.overpass("node(1);out;")).total, 0);
  assert.deepEqual(hosts, ["stuck.test", "ok.test"]);
  assert.ok(Date.now() - started < 900);
  // All servers stuck: a clear error within the overall budget instead of waiting for good.
  const stuck = new OSMClient({ overpassUrls: ["https://a.test/api", "https://b.test/api", "https://c.test/api"], overpassTimeoutMs: 80, overpassBudgetMs: 150, fetchImpl: async (u, init) => hanging(init) });
  const t0 = Date.now();
  await assert.rejects(stuck.overpass("node(2);out;"), /keine Antwort nach 0 s.*keine Zeit mehr/);
  assert.ok(Date.now() - t0 < 400, `${Date.now() - t0} ms`);
  const slowNominatim = new OSMClient({ minIntervalMs: 0, nominatimTimeoutMs: 50, fetchImpl: async (u, init) => hanging(init) });
  await assert.rejects(slowNominatim.geocode("x"), /Nominatim nicht erreichbar \(TimeoutError\)/);
});

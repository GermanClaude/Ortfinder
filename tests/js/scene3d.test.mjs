import assert from "node:assert/strict";
import { test } from "node:test";

import { worldPixel } from "../../docs/js/mapview.js";
import { horizontalFov } from "../../docs/js/metadata.js";
import {
  buildingHeights, clipNear, computeVisibleArea, drawView, localProjection, makeCamera, parseLength, parseScene, raySegment, sceneQuery,
} from "../../docs/js/scene3d.js";
import { Terrain, decodeTerrarium, zoomForDistance } from "../../docs/js/terrain.js";

const near = (actual, expected, tol) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} not within ${tol} of ${expected}`);

test("terrarium decoding and zoom bands", () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(129, 44, 128), 300.5);
  assert.deepEqual([zoomForDistance(100), zoomForDistance(5000), zoomForDistance(20000)], [14, 12, 10]);
});

test("terrain samples bilinearly and falls back to coarser tiles", async () => {
  const loads = [];
  const terrain = new Terrain({
    retryDelayMs: 0,
    loadTile: async (z, x, y) => {
      loads.push(`${z}/${x}/${y}`);
      if (z === 14) return null; // unavailable
      // Elevation grows with the pixel column: value = column index.
      return Float32Array.from({ length: 256 * 256 }, (_, i) => (z === 12 ? i % 256 : 500));
    },
  });
  await terrain.prefetchView(47.99, 7.85, 0, 60, 30000);
  assert.ok(loads.some((k) => k.startsWith("14/")) && loads.some((k) => k.startsWith("12/")) && loads.some((k) => k.startsWith("10/")));
  assert.ok(terrain.available);
  const p = worldPixel(47.99, 7.85, 12);
  near(terrain.elevation(47.99, 7.85, 14), p.x - Math.floor(p.x / 256) * 256 - 0.5, 1e-6); // z14 missing → z12
  assert.equal(terrain.elevation(48.2, 7.85, 10), 500);
  assert.equal(terrain.elevation(10, 10, 14), null);
  const before = loads.length;
  await terrain.prefetchView(47.99, 7.85, 0, 60, 30000);
  assert.equal(loads.length, before, "tiles are cached");
  assert.equal(loads.filter((k) => k.startsWith("14/")).length % 2, 0, "failed tiles are retried once");
  const small = new Terrain({ retryDelayMs: 0, loadTile: async (z) => { loads.push(`small${z}`); return null; } });
  await small.prefetchView(47.99, 7.85, 90, 40, 800);
  assert.ok(loads.filter((k) => k.startsWith("small")).every((k) => k === "small14"));
  assert.equal(small.available, false);
});

test("building heights from OSM tags", () => {
  assert.equal(parseLength("12,5 m"), 12.5);
  near(parseLength("40 ft"), 12.19, 0.01);
  assert.equal(parseLength("hoch"), null);
  assert.deepEqual(buildingHeights({ building: "yes", height: "21" }), { height: 21, minHeight: 0, estimated: false });
  const levels = buildingHeights({ building: "apartments", "building:levels": "4", "roof:shape": "gabled" });
  near(levels.height, 4 * 3.1 + 2.5, 1e-9);
  assert.equal(levels.estimated, false);
  assert.deepEqual(buildingHeights({ building: "garage" }), { height: 3, minHeight: 0, estimated: true });
  assert.equal(buildingHeights({ "building:part": "yes", height: "30", min_height: "12" }).minHeight, 12);
});

const square = (lat, lon, dLat, dLon) => [
  { lat, lon }, { lat, lon: lon + dLon }, { lat: lat + dLat, lon: lon + dLon }, { lat: lat + dLat, lon }, { lat, lon },
];

test("parseScene: buildings, parts replace outlines, streets, trees", () => {
  const scene = parseScene({
    elements: [
      { type: "way", id: 1, tags: { building: "church", name: "St. Martin" }, geometry: square(48, 7.8, 0.001, 0.001) },
      { type: "way", id: 2, tags: { "building:part": "yes", height: "60" }, geometry: square(48.0004, 7.8004, 0.0002, 0.0002) },
      { type: "way", id: 3, tags: { building: "yes" }, geometry: square(48.01, 7.8, 0.0001, 0.0001).slice(0, 4) }, // not closed
      { type: "relation", id: 4, tags: { building: "yes", "building:levels": "3" }, members: [{ role: "outer", geometry: square(48.02, 7.8, 0.0002, 0.0002) }, { role: "inner", geometry: square(48.02, 7.8, 0.0001, 0.0001) }] },
      { type: "way", id: 5, tags: { highway: "residential", name: "Hauptstraße" }, geometry: [{ lat: 48, lon: 7.8 }, { lat: 48.001, lon: 7.8 }] },
      { type: "way", id: 6, tags: { highway: "footway" }, geometry: [{ lat: 48, lon: 7.8 }, { lat: 48, lon: 7.801 }] },
      { type: "node", id: 7, lat: 48.0005, lon: 7.7995, tags: { natural: "tree" } },
      { type: "node", id: 8, lat: 48.0005, lon: 7.7995, tags: { amenity: "bench" } },
    ],
  });
  assert.equal(scene.buildings.length, 3);
  const church = scene.buildings.find((b) => b.name === "St. Martin");
  assert.equal(church.hidden, true, "the outline is drawn through its part");
  assert.equal(church.ring.length, 4);
  assert.equal(scene.buildings.find((b) => b.part).height, 60);
  near(scene.buildings.find((b) => !b.part && !b.name).height, 3 * 3.1 + 0.5, 1e-9);
  assert.deepEqual(scene.roads.map((r) => [r.width, r.minor]), [[6, false], [2, true]]);
  assert.deepEqual(scene.trees, [{ lat: 48.0005, lon: 7.7995, height: 9 }]);
});

test("scene queries are snapped so nearby renders share one request", () => {
  assert.equal(sceneQuery(47.9901, 7.8501), sceneQuery(47.9912, 7.8489));
  assert.notEqual(sceneQuery(47.99, 7.85), sceneQuery(48.01, 7.85));
  assert.match(sceneQuery(47.99, 7.85), /way\["building"\]\(around:830,/);
});

test("camera projection and near-plane clipping", () => {
  const cam = makeCamera({ bearingDeg: 0, pitchDeg: 0, fovDeg: 90, width: 800, height: 600 });
  assert.deepEqual(cam.project(cam.toCam([0, 100, 0])), [400, 300]);
  const right = cam.project(cam.toCam([100, 100, 0]));
  near(right[0], 800, 1e-9); // 45° to the right is the right edge of a 90° view
  assert.ok(cam.project(cam.toCam([0, 100, 10]))[1] < 300, "higher points are higher in the picture");
  const east = makeCamera({ bearingDeg: 90, fovDeg: 60, width: 600, height: 400 });
  near(east.toCam([100, 0, 0])[2], 100, 1e-9);
  const down = makeCamera({ bearingDeg: 0, pitchDeg: -30, fovDeg: 60, width: 600, height: 400 });
  near(down.project(down.toCam([0, 100, -100 * Math.tan(Math.PI / 6)]))[1], 200, 1e-6);
  const clipped = clipNear([[0, 0, -1], [0, 0, 1], [1, 0, 1]], 0.5);
  assert.deepEqual(clipped.map((p) => p[2]), [0.5, 1, 1, 0.5]);
  near(raySegment(0, 1, [-5, 10], [5, 10]), 10, 1e-9);
  assert.equal(raySegment(0, 1, [-5, -10], [5, -10]), null);
});

function inPolygon([lat, lon], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ai, oi] = poly[i];
    const [aj, oj] = poly[j];
    if ((oi > lon) !== (oj > lon) && lat < ((aj - ai) * (lon - oi)) / (oj - oi) + ai) inside = !inside;
  }
  return inside;
}
const seen = (area, p) => area.polygons.some((poly) => inPolygon(p, poly));

// A 20 m wide, 9 m high building 20–30 m north of the camera.
const CAM = [48.0, 7.85];
const proj = localProjection(...CAM);
const block = () => {
  const ring = [[-10, 20], [10, 20], [10, 30], [-10, 30]].map(([x, y]) => proj.toLatLon(x, y));
  return { buildings: [{ ring, height: 9, minHeight: 0, estimated: false }], roads: [], trees: [] };
};

test("visible area: the building blocks the view, the frame bounds it", () => {
  const area = computeVisibleArea({ lat: CAM[0], lon: CAM[1], bearingDeg: 0, fovDeg: 60, eyeHeight: 1.6, aspect: 4 / 3, maxDistM: 100, scene: block() });
  assert.equal(area.polygons.length, 1);
  assert.ok(seen(area, proj.toLatLon(0, 15)), "ground in front of the building");
  assert.ok(!seen(area, proj.toLatLon(0, 50)), "ground behind the building");
  assert.ok(seen(area, proj.toLatLon(Math.sin(0.5) * 60, Math.cos(0.5) * 60)), "past the building's edge (28.6°)");
  assert.ok(!seen(area, proj.toLatLon(0, 2)), "too close: below the bottom of the picture");
  assert.ok(!seen(area, proj.toLatLon(60, 30)), "outside the field of view");
  near(area.stats.nearest_m, 1.6 / Math.tan(Math.atan(Math.tan(Math.PI / 6) / (4 / 3))), 0.6);
  assert.equal(area.facades.length, 1);
  assert.ok(area.facades[0].length > 50, "the whole front wall is visible");
  for (const [lat, lon] of area.facades[0]) near(proj.toXY(lat, lon)[1], 20, 0.01);
});

test("visible area from a tower looks over the building", () => {
  const area = computeVisibleArea({ lat: CAM[0], lon: CAM[1], bearingDeg: 0, fovDeg: 60, eyeHeight: 30, pitchDeg: -20, aspect: 4 / 3, maxDistM: 150, scene: block() });
  assert.ok(seen(area, proj.toLatLon(0, 50)), "behind the building is visible from above");
  assert.ok(!seen(area, proj.toLatLon(0, 10)), "right below is outside the picture");
  near(area.stats.nearest_m, 30 / Math.tan((20 * Math.PI) / 180 + Math.atan(Math.tan(Math.PI / 6) / (4 / 3))), 1);
});

test("visible area follows the terrain: a ridge hides the valley behind it", () => {
  // A ridge north of the camera: rises from 0 m (300 m away) to 40 m (400 m), back to 0 m at 420 m.
  const ridge = (y) => (y > 300 && y <= 400 ? (y - 300) * 0.4 : y > 400 && y < 420 ? 40 - (y - 400) * 2 : 0);
  const terrain = { available: true, elevation: (lat) => ridge((lat - CAM[0]) * 111195) };
  const area = computeVisibleArea({ lat: CAM[0], lon: CAM[1], bearingDeg: 0, fovDeg: 30, maxDistM: 2000, scene: null, terrain });
  assert.ok(seen(area, proj.toLatLon(0, 200)));
  assert.ok(seen(area, proj.toLatLon(0, 350)), "front slope of the ridge");
  assert.ok(!seen(area, proj.toLatLon(0, 600)), "valley behind the ridge");
  assert.ok(!seen(area, proj.toLatLon(0, 1900)), "far plain is below the ridge line");
  near(area.stats.farthest_m, 400 / Math.cos((15 * Math.PI) / 180), 8);
  assert.ok(area.stats.terrain);
  // A flat plateau seen from below: only up to its edge.
  const cliff = { available: true, elevation: (lat) => { const y = (lat - CAM[0]) * 111195; return y > 300 && y < 400 ? 40 : 0; } };
  const plateau = computeVisibleArea({ lat: CAM[0], lon: CAM[1], bearingDeg: 0, fovDeg: 30, maxDistM: 2000, scene: null, terrain: cliff });
  assert.ok(!seen(plateau, proj.toLatLon(0, 360)));
});

function mockContext() {
  const calls = { fillRect: 0, fill: 0, ellipse: 0, fillText: [] };
  return {
    calls,
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect: () => { calls.fillRect += 1; },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, arc() {},
    fill: () => { calls.fill += 1; },
    ellipse: () => { calls.ellipse += 1; },
    fillText: (t) => calls.fillText.push(t),
    measureText: (t) => ({ width: t.length * 6 }),
    drawImage: () => { calls.drawImage = (calls.drawImage || 0) + 1; },
  };
}

test("drawView renders the reconstruction and reports what it shows", () => {
  const ctx = mockContext();
  const scene = block();
  scene.trees.push({ lat: proj.toLatLon(5, 10)[0], lon: proj.toLatLon(5, 10)[1], height: 8 });
  scene.roads.push({ points: [proj.toLatLon(0, 0), proj.toLatLon(0, 18)], width: 6, minor: false });
  const stats = drawView(ctx, { width: 640, height: 480, lat: CAM[0], lon: CAM[1], bearingDeg: 0, fovDeg: 60, scene, terrain: null, maxDistM: 2000 });
  assert.deepEqual(stats, { buildings: 1, heights_from_osm_pct: 100, terrain: false, ground_m: 0, building_ahead_m: 20, skyline_distance_m: null });
  assert.equal(ctx.calls.ellipse, 1, "one tree");
  assert.ok(ctx.calls.fill >= 2, "road and front wall");
  assert.ok(ctx.calls.fillText.includes("N"), "compass scale");
  assert.ok(ctx.calls.fillText.some((t) => t.startsWith("3D-Nachbau · 48.00000, 7.85000 · Blick 0°")));
  // Looking away from the building shows no buildings.
  assert.equal(drawView(mockContext(), { width: 320, height: 240, lat: CAM[0], lon: CAM[1], bearingDeg: 180, fovDeg: 60, scene, maxDistM: 500 }).buildings, 0);
});

test("horizontal field of view from the 35 mm-equivalent focal length", () => {
  near(horizontalFov(26, 4032, 3024), 67.3, 0.2); // typical phone main camera, landscape
  near(horizontalFov(26, 3024, 4032), 53.1, 0.2); // portrait
  near(horizontalFov(50, 6000, 4000), 39.6, 0.2); // "normal" lens on 3:2
  assert.equal(horizontalFov(null, 100, 100), null);
});

test("drawView with a draped aerial image: no model terrain or roads, buildings as wireframes", () => {
  const ctx = mockContext();
  const stats = drawView(ctx, {
    width: 400, height: 900, lat: CAM[0], lon: CAM[1], bearingDeg: 0, fovDeg: 40, eyeHeight: 10, scene: block(),
    drape: { canvas: {}, skyline: 12345 },
  });
  assert.equal(ctx.calls.drawImage, 1, "the draped terrain is drawn once, as a picture");
  assert.equal(stats.skyline_distance_m, null, "no terrain model loaded here");
  assert.ok(ctx.calls.fillText.some((t) => t.startsWith("Luftbild-3D")));
  assert.ok(ctx.calls.fillText.includes("Luftbild: Esri · © OpenStreetMap · Gelände: Mapzen/AWS"), "credit on its own line in a narrow image");
});

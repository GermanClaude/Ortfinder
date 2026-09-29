import assert from "node:assert/strict";
import { test } from "node:test";

import { aerialUv, buildingGeometry, cameraBasis, fanTriangles, polarRadii, terrainGeometry, verticalFov, viewExtent } from "../../docs/js/model3d.js";
import { mercatorBox } from "../../docs/js/groundview.js";
import { groundModel } from "../../docs/js/scene3d.js";

const LAT = 46.4;
const LON = 9.1;
const flat = { available: false, elevation: () => null };

test("terrain mesh: fine near the camera, coarse far away, facing up, heights relative to the eye", () => {
  const r = polarRadii(2, 5000, 50);
  assert.ok(Math.abs(r[0] - 2) < 1e-9 && Math.abs(r[49] - 5000) < 1e-6);
  assert.ok(r[1] - r[0] < 0.5 && r[49] - r[48] > 500, "geometric spacing");
  const g = groundModel({ lat: LAT, lon: LON, eyeHeight: 10, terrain: flat });
  const mesh = terrainGeometry({ groundZ: g.groundZ, radius: 5000, rings: 50, segments: 36 });
  assert.equal(mesh.positions.length, 3 * (1 + 50 * 36));
  assert.equal(mesh.indices.length, 3 * 36 + 6 * 36 * 49);
  assert.ok(Math.abs(mesh.positions[1] + 10) < 0.01, "ground 10 m below the eye");
  // Vertex at ring 49, segment 9 (90° = east): x ≈ 5000, z ≈ 0, y lower by earth curvature (~1.7 m at 5 km).
  const k = 1 + 49 * 36 + 9;
  assert.ok(Math.abs(mesh.positions[3 * k] - 5000) < 0.01 && Math.abs(mesh.positions[3 * k + 2]) < 0.01);
  assert.ok(mesh.positions[3 * k + 1] < -11 && mesh.positions[3 * k + 1] > -12.5, `${mesh.positions[3 * k + 1]}`);
  // Triangles face up (normal y > 0) so the terrain is seen from above.
  const p = (i) => [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]];
  for (const t of [0, 3 * 36 + 6 * 100]) {
    const [a, b, c] = [p(mesh.indices[t]), p(mesh.indices[t + 1]), p(mesh.indices[t + 2])];
    const u = b.map((v, i) => v - a[i]);
    const w = c.map((v, i) => v - a[i]);
    assert.ok(u[2] * w[0] - u[0] * w[2] > 0, "normal points up");
  }
  assert.deepEqual([mesh.en[2 * k], Math.round(mesh.en[2 * k + 1])], [mesh.positions[3 * k], 0]);
});

test("buildings: walls without aerial image, roofs with it; far ones left out", () => {
  const g = groundModel({ lat: LAT, lon: LON, eyeHeight: 1.6, terrain: flat });
  const [la, lo] = g.proj.toLatLon(0, 50);
  const d = 10 / 111195;
  const house = { ring: [[la, lo], [la + d, lo], [la + d, lo + d * 1.45], [la, lo + d * 1.45]], height: 9, minHeight: 0 };
  const [fla, flo] = g.proj.toLatLon(0, 5000);
  const far = { ...house, ring: house.ring.map(([a, b]) => [a - la + fla, b - lo + flo]) };
  const geo = buildingGeometry([house, far, { ...house, hidden: true }], g);
  assert.equal(geo.count, 1);
  assert.equal(geo.positions.length / 3, 4 * 4 + 4, "four walls of four corners, one roof");
  assert.equal(geo.indices.length, 4 * 12 + 2 * 6, "walls and roof, both windings");
  assert.ok(Number.isNaN(geo.en[0]) && Number.isFinite(geo.en[2 * 16]), "walls grey, roof from the aerial image");
  const ys = Array.from({ length: geo.positions.length / 3 }, (_, i) => geo.positions[3 * i + 1]);
  assert.ok(Math.abs(Math.min(...ys) + 1.6) < 0.01 && Math.abs(Math.max(...ys) - 7.4) < 0.01, "from the ground to 9 m");
  assert.deepEqual(fanTriangles(5), [[0, 1, 2], [0, 2, 3], [0, 3, 4]]);
});

test("photo camera basis, field of view and the ground the photo shows", () => {
  const east = cameraBasis({ bearingDeg: 90, pitchDeg: 0, rollDeg: 0, fovDeg: 50 });
  assert.deepEqual(east.forward.map((v) => Math.round(v * 1e6) / 1e6 + 0), [1, 0, 0]);
  assert.deepEqual(east.up.map((v) => Math.round(v * 1e6) / 1e6 + 0), [0, 1, 0]);
  const north = cameraBasis({ bearingDeg: 0, pitchDeg: -30, rollDeg: 0, fovDeg: 50 });
  assert.ok(Math.abs(north.forward[1] + 0.5) < 1e-9 && north.forward[2] < 0, "north is −z in three.js, looking down");
  assert.ok(Math.abs(verticalFov(36, 918 / 2040) - 71.66) < 0.02);
  assert.ok(Math.abs(verticalFov(60, 1) - 60) < 1e-9);
  const n = 100;
  const rays = { dist: new Float32Array(n).fill(Infinity), hx: new Float32Array(n), hy: new Float32Array(n) };
  for (let i = 0; i < 50; i++) {
    rays.dist[i] = 100 + i * 10;
    rays.hx[i] = 0;
    rays.hy[i] = 100 + i * 10;
  }
  const ext = viewExtent(rays);
  assert.equal(ext.farthest, 590);
  assert.ok(Math.abs(ext.radius - 619.5) < 0.01);
  assert.ok(ext.center[1] > 200 && ext.center[1] < 300 && ext.span >= 150, JSON.stringify(ext));
  assert.equal(viewExtent({ dist: new Float32Array(4).fill(Infinity), hx: new Float32Array(4), hy: new Float32Array(4) }).radius, 1500);
});

test("aerial texture coordinates: inside the box 0–1, walls marked −1", () => {
  const g = groundModel({ lat: LAT, lon: LON, eyeHeight: 1.6, terrain: flat });
  const corners = [[-500, -500], [500, 500], [-500, 500], [500, -500]].map(([e, n]) => g.proj.toLatLon(e, n));
  const box = mercatorBox(corners, 1024);
  const uv = aerialUv(Float32Array.from([0, 0, 499, 499, NaN, NaN]), g, box);
  assert.ok(Math.abs(uv[0] - 0.5) < 0.01 && Math.abs(uv[1] - 0.5) < 0.01, `${uv[0]} ${uv[1]}`);
  assert.ok(uv[2] > 0.99 && uv[3] > 0.99, "north-east corner: right, top (textures are flipped)");
  assert.deepEqual([uv[4], uv[5]], [-1, -1]);
});

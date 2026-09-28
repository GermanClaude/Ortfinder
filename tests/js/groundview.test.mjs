import assert from "node:assert/strict";
import { test } from "node:test";

import {
  castRays, drapeRays, gridSpacing, groundExtent, imageryZoom, mercatorBox, projectPhotoToMap, tilesForRays,
} from "../../docs/js/groundview.js";
import { latLonFromWorldPixel, worldPixel } from "../../docs/js/mapview.js";
import { groundModel, localProjection, makeCamera } from "../../docs/js/scene3d.js";
import { typicalPhoneFov } from "../../docs/js/metadata.js";

const LAT = 46.62;
const LON = 7.9;
const flat = { available: false, elevation: () => null }; // no terrain: flat ground at the camera's foot

test("sight rays meet flat ground where trigonometry says", () => {
  const g = groundModel({ lat: LAT, lon: LON, eyeHeight: 10, terrain: flat });
  const cam = makeCamera({ bearingDeg: 90, pitchDeg: -30, fovDeg: 60, width: 40, height: 30 });
  const rays = castRays({ cam, g, maxDistM: 5000 });
  // The centre pixel looks 30° down from 10 m: ground at 10 / tan 30° ≈ 17.3 m, due east.
  const i = 15 * 40 + 20;
  const expected = 10 / Math.tan((30 * Math.PI) / 180);
  const along = Math.atan(0.5 / cam.fpx); // half a pixel off the exact centre
  assert.ok(Math.abs(rays.dist[i] - expected) < 0.6, `dist ${rays.dist[i]}`);
  assert.ok(rays.hx[i] > 16 && Math.abs(rays.hy[i]) < 1 + along * 20);
  // Pixels above the horizon see sky.
  const up = makeCamera({ bearingDeg: 0, pitchDeg: 20, fovDeg: 60, width: 20, height: 20 });
  const sky = castRays({ cam: up, g, maxDistM: 5000 });
  assert.equal(sky.dist[0], Infinity);
  assert.ok(Number.isFinite(sky.dist[19 * 20 + 10]));
});

test("a hill hides the ground behind it", () => {
  // A 30 m wall of terrain 200–220 m north of the camera.
  const proj = localProjection(LAT, LON);
  const terrain = { available: true, elevation: (lat, lon) => { const [, n] = proj.toXY(lat, lon); return n > 200 && n < 220 ? 530 : 500; } };
  const g = groundModel({ lat: LAT, lon: LON, eyeHeight: 2, terrain });
  const cam = makeCamera({ bearingDeg: 0, pitchDeg: 0, fovDeg: 40, width: 20, height: 60 });
  const rays = castRays({ cam, g, maxDistM: 3000 });
  const column = Array.from({ length: 60 }, (_, y) => rays.dist[y * 20 + 10]).filter(Number.isFinite);
  assert.ok(column.every((d) => d < 225), "nothing beyond the ridge is visible (the ground behind drops away)");
  assert.ok(column.some((d) => d > 199), "the ridge itself is visible");
});

test("the photo is laid flat: each map pixel takes the colour of the photo pixel that sees it", () => {
  const W = 120;
  const H = 90;
  // Photo: left half red, right half blue.
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(x < W / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * W + x) * 4);
  const g = groundModel({ lat: LAT, lon: LON, eyeHeight: 20, terrain: flat });
  const cam = makeCamera({ bearingDeg: 0, pitchDeg: -25, fovDeg: 50, width: W, height: H });
  const rays = castRays({ cam: makeCamera({ bearingDeg: 0, pitchDeg: -25, fovDeg: 50, width: 60, height: 45 }), g, maxDistM: 500 });
  const ext = groundExtent(rays, { minDistM: 5, maxDistM: 400 });
  assert.ok(ext && ext.minN > 0 && ext.halfSpread > 20 && ext.halfSpread < 60, JSON.stringify(ext));
  const corners = [[ext.minE, ext.minN], [ext.maxE, ext.maxN], [0, 0]].map(([e, n]) => g.proj.toLatLon(e, n));
  const box = mercatorBox(corners, 200);
  const flatPhoto = projectPhotoToMap({ photo: { width: W, height: H, data }, cam, rays, g, box, minDistM: 5, maxDistM: 400 });
  assert.ok(flatPhoto.covered > 1000);
  // West of the viewing line is the left (red) half, east the right (blue) half.
  const at = (dE, dN) => {
    const [la, lo] = g.proj.toLatLon(dE, dN);
    const p = worldPixel(la, lo, box.zoom);
    const i = (Math.floor(p.y - box.y0) * box.width + Math.floor(p.x - box.x0)) * 4;
    return [...flatPhoto.data.slice(i, i + 4)];
  };
  assert.deepEqual(at(-10, 60), [255, 0, 0, 255]);
  assert.deepEqual(at(10, 60), [0, 0, 255, 255]);
  assert.equal(at(0.5, 1)[3], 0, "closer than min_distance stays transparent");
  // Only a region of the photo: the right half alone.
  const right = projectPhotoToMap({ photo: { width: W, height: H, data }, cam, rays, g, box, minDistM: 5, maxDistM: 400, region: [0.5, 0, 1, 1] });
  assert.ok(right.covered < flatPhoto.covered * 0.6);
});

test("Mercator box, grid spacing and imagery zoom", () => {
  const box = mercatorBox([[46.4, 9.1], [46.41, 9.12]], 500);
  assert.equal(Math.max(box.width, box.height), 500);
  const [la, lo] = latLonFromWorldPixel(box.x0, box.y0, box.zoom);
  assert.ok(Math.abs(la - 46.41) < 1e-6 && Math.abs(lo - 9.1) < 1e-6);
  // The far corner moves by less than a pixel (the box has whole pixels).
  assert.ok(Math.abs(box.bounds.south - 46.4) < 5e-5 && Math.abs(box.bounds.east - 9.12) < 5e-5);
  assert.deepEqual([gridSpacing(600), gridSpacing(1300), gridSpacing(90), gridSpacing(14000)], [100, 250, 20, 2500]);
  assert.equal(imageryZoom(46.7, 0.4), 18);
  assert.equal(imageryZoom(46.7, 0.01), 19, "never finer than the imagery exists");
  assert.equal(imageryZoom(46.7, 50), 11);
});

test("draping colours every ray hit from the imagery tiles it needs", () => {
  const g = groundModel({ lat: LAT, lon: LON, eyeHeight: 30, terrain: flat });
  const cam = makeCamera({ bearingDeg: 45, pitchDeg: -10, fovDeg: 60, width: 64, height: 48 });
  const rays = castRays({ cam, g, maxDistM: 20000 });
  const { keys, bias } = tilesForRays({ rays, cam, g, lat0: LAT, maxTiles: 40 });
  assert.ok(keys.length > 0 && keys.length <= 40 && bias <= 0);
  const seen = [];
  const imagery = { color: (lat, lon, z) => { seen.push(z); return [10, 200, 30]; } };
  const rgba = drapeRays({ rays, cam, g, imagery, zoomBias: bias, lat0: LAT });
  const hits = rays.dist.filter(Number.isFinite).length;
  assert.equal(seen.length, hits);
  const bottom = ((47 * 64) + 32) * 4;
  assert.deepEqual([...rgba.slice(bottom, bottom + 4)].map((v) => Math.round(v / 20)), [1, 10, 2, 13], "near ground: imagery colour, opaque");
  assert.equal(rgba[3], 0, "sky stays transparent");
  assert.ok(Math.max(...seen) > Math.min(...seen), "near ground uses finer tiles than far ground");
});

test("typical phone field of view from the aspect ratio", () => {
  assert.equal(typicalPhoneFov(918, 2040), 36);
  assert.equal(typicalPhoneFov(3000, 4000), 56.8);
  assert.equal(typicalPhoneFov(4000, 3000), 71.6);
  assert.equal(typicalPhoneFov(0, 10), null);
});

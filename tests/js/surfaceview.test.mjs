import assert from "node:assert/strict";
import { test } from "node:test";

import { makeCamera } from "../../docs/js/scene3d.js";
import { cleanSurfaces, flatTopView, groundPoint, pitchFromHorizon, reliableRange, surfaceMask, surfaceStats } from "../../docs/js/surfaceview.js";

/** Photo of level ground with 1 m checkerboard squares (and a grey road |E| < 3 m), seen from 1.6 m. */
function groundPhoto({ W = 480, H = 360, fovDeg = 60, pitchDeg = -8, eye = 1.6 } = {}) {
  const cam = makeCamera({ bearingDeg: 0, pitchDeg, rollDeg: 0, fovDeg, width: W, height: H });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const p = groundPoint(cam, eye, u + 0.5, v + 0.5);
      const k = (v * W + u) * 4;
      if (!p) {
        data.set([150, 190, 240, 255], k); // sky
        continue;
      }
      const road = Math.abs(p[0]) < 3;
      const dark = (Math.floor(p[0]) + Math.floor(p[1])) % 2 !== 0;
      data.set(road ? [90, 90, 95, 255] : dark ? [40, 110, 40, 255] : [200, 220, 120, 255], k);
    }
  }
  return { photo: { width: W, height: H, data }, cam };
}

test("tilt from the horizon, and how far the top view can be trusted", () => {
  const W = 480;
  const H = 360;
  const fpx = W / 2 / Math.tan(30 * Math.PI / 180);
  const horizonY = 0.5 - (fpx * Math.tan(8 * Math.PI / 180)) / H; // looking 8° down: horizon above the middle
  assert.ok(Math.abs(pitchFromHorizon(horizonY, { fovDeg: 60, width: W, height: H }) + 8) < 1e-9);
  // A phone photo (4000×3000, 66°) from eye height: about 50 m with a known horizon, much less with a guessed tilt.
  const phone = reliableRange({ eyeHeight: 1.6, fovDeg: 66, width: 4000, height: 3000 });
  assert.ok(phone.metres > 40 && phone.metres < 70, JSON.stringify(phone));
  const guessed = reliableRange({ eyeHeight: 1.6, fovDeg: 66, width: 4000, height: 3000, source: "geschaetzt" });
  assert.ok(guessed.metres < 6);
  assert.ok(reliableRange({ eyeHeight: 12, fovDeg: 66, width: 4000, height: 3000 }).metres > phone.metres, "higher up, farther");
});

test("the ground laid flat keeps its squares, and the outlined road comes out 6 m wide", () => {
  const { photo, cam } = groundPhoto();
  // The road in the photo: the four ground corners (|E| = 3 m, 4–40 m ahead) projected into the photo.
  const corner = (e, n) => {
    const [u, v] = cam.project(cam.toCam([e, n, -1.6]));
    return [u / photo.width, v / photo.height];
  };
  const surfaces = cleanSurfaces([
    { art: "Asphalt", punkte: [corner(-3, 4), corner(3, 4), corner(3, 40), corner(-3, 40)] },
    { art: "unbekannt", punkte: [[0, 0], [1, 0], [1, 0.1]] },
    { art: "wiese", punkte: [[0, 0]] }, // too few points: dropped
  ]);
  assert.deepEqual(surfaces.map((s) => s.art), ["asphalt", "sonstiges"]);
  const view = flatTopView({ photo, fovDeg: 60, pitchDeg: -8, eyeHeight: 1.6, maxDistM: 30, surfaces: surfaces.slice(0, 1) });
  assert.ok(view);
  assert.ok(view.nearest < 12 && view.farthest > 28, `${view.nearest}–${view.farthest}`);
  // Sample the top view at ground points: the colour must be that of the square there.
  const at = (e, n) => {
    const i = Math.floor((e - view.minE) / view.mPerPx);
    const j = Math.floor((view.maxN - n) / view.mPerPx);
    return Array.from(view.data.slice((j * view.width + i) * 4, (j * view.width + i) * 4 + 3));
  };
  assert.deepEqual(at(5.5, 12.5), [40, 110, 40], "dark square (5+12 odd)");
  assert.deepEqual(at(6.5, 12.5), [200, 220, 120], "light square next to it");
  assert.deepEqual(at(0, 20), [90, 90, 95], "road");
  const [road] = surfaceStats(view, surfaces.slice(0, 1), 25);
  assert.equal(road.art, "asphalt");
  assert.ok(Math.abs(road.width_m - 6) < 0.4, `road ${road.width_m} m`);
  assert.ok(road.near_m >= 3 && road.near_m <= 6);
  // Nothing above the horizon or behind the camera.
  assert.equal(flatTopView({ photo, fovDeg: 60, pitchDeg: 30, eyeHeight: 1.6, maxDistM: 30 }), null);
});

test("surface outlines are filled even-odd, the later one wins", () => {
  const mask = surfaceMask([
    { art: "wiese", punkte: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    { art: "wasser", punkte: [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]] },
  ], 10, 10);
  assert.equal(mask[0], 0);
  assert.equal(mask[9 * 10 + 9], 1);
  assert.equal(mask[2 * 10 + 8], 0);
});

test("plan: the tilt comes from the horizon, else from pitch, else a flagged guess", async () => {
  const { surfacePlan } = await import("../../docs/js/surfaceview.js");
  const a = surfacePlan({ width: 4000, height: 3000, fovDeg: 66, horizonY: 0.45 });
  assert.equal(a.source, "horizont");
  assert.ok(a.pitchDeg < 0, "horizon above the middle: looking down");
  assert.ok(a.reliableM > 20 && a.maxDistM <= 150 && a.maxDistM >= a.reliableM);
  assert.equal(surfacePlan({ width: 4000, height: 3000, fovDeg: 66, pitchDeg: -5 }).source, "neigung");
  const guess = surfacePlan({ width: 4000, height: 3000, fovDeg: 66 });
  assert.equal(guess.source, "geschaetzt");
  assert.equal(guess.maxDistM, 15, "a guessed tilt draws only the near ground");
  assert.equal(surfacePlan({ width: 4000, height: 3000, fovDeg: 66, maxDistM: 90 }).maxDistM, 90);
});

test("the AI's words for surfaces map onto the known kinds", async () => {
  const { surfaceKind } = await import("../../docs/js/surfaceview.js");
  assert.equal(surfaceKind("Asphalt"), "asphalt");
  assert.equal(surfaceKind("Straße (Fahrbahn)"), "asphalt");
  assert.equal(surfaceKind("Rasen"), "wiese");
  assert.equal(surfaceKind("Fluss"), "wasser");
  assert.equal(surfaceKind("Mondgestein"), "sonstiges");
});

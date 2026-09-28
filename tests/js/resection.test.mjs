import assert from "node:assert/strict";
import { test } from "node:test";

import { levenbergMarquardt, solveCamera, solveLinear } from "../../docs/js/resection.js";
import { groundModel, localProjection, makeCamera } from "../../docs/js/scene3d.js";

// A valley floor at 580 m rising to the west (the camera stands on the slope above it).
const terrain = {
  available: true,
  elevation: (lat, lon) => {
    const east = (lon - 7.9) * 111195 * Math.cos((46.62 * Math.PI) / 180);
    return east < 100 ? 580 + Math.min(100 - east, 300) * 0.25 : 580;
  },
};

function synthetic(pose, places, { width = 918, height = 2040 } = {}) {
  const g = groundModel({ lat: pose.lat, lon: pose.lon, eyeHeight: pose.eyeHeight, terrain });
  const cam = makeCamera({ bearingDeg: pose.bearing, pitchDeg: pose.pitch, rollDeg: pose.roll, fovDeg: pose.fov, width, height });
  const proj = localProjection(pose.lat, pose.lon);
  // Places as [distance m, angle from the viewing direction °, height above ground m].
  return places.map(([dist, off, h = 0]) => {
    const a = ((pose.bearing + off) * Math.PI) / 180;
    const east = dist * Math.sin(a);
    const north = dist * Math.cos(a);
    const [lat, lon] = proj.toLatLon(east, north);
    const d = Math.hypot(east, north);
    const [u, v] = cam.project(cam.toCam([east, north, g.groundZ(east, north, d) + h]));
    return { x: u / width, y: v / height, lat, lon, height_m: h };
  });
}

test("linear solver and Levenberg–Marquardt basics", () => {
  assert.deepEqual(solveLinear([[2, 1], [1, 3]], [3, 5]).map((v) => Math.round(v * 1e6) / 1e6), [0.8, 1.4]);
  const fit = levenbergMarquardt(([a, b]) => [a - 3, (b + 1) * 2, a * b + 3], [0, 0], { steps: [1e-4, 1e-4] });
  assert.ok(Math.abs(fit.x[0] - 3) < 1e-3 && Math.abs(fit.x[1] + 1) < 1e-3);
});

test("recovers direction, tilt, roll and field of view from four points", () => {
  const truth = { lat: 46.62, lon: 7.9, eyeHeight: 10, bearing: 83, pitch: -9, roll: 0.6, fov: 38 };
  const places = [[250, -12], [270, 6, 8], [200, 14], [520, 2], [430, -9]];
  const points = synthetic(truth, places);
  assert.ok(points.every((p) => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1), "all points inside the photo");
  const sol = solveCamera({ points, width: 918, height: 2040, lat: truth.lat, lon: truth.lon, eyeHeight: 10, solvePosition: false, terrain });
  // The roll prior (photos are held nearly level) pulls a little towards 0°.
  assert.ok(sol.rms_px < 1, `rms ${sol.rms_px}`);
  assert.ok(Math.abs(sol.view.bearing_deg - 83) < 0.1, `bearing ${sol.view.bearing_deg}`);
  assert.ok(Math.abs(sol.view.pitch_deg + 9) < 0.1, `pitch ${sol.view.pitch_deg}`);
  assert.ok(Math.abs(sol.view.roll_deg - 0.6) < 0.2, `roll ${sol.view.roll_deg}`);
  assert.ok(Math.abs(sol.view.fov_deg - 38) < 0.2, `fov ${sol.view.fov_deg}`);
});

test("also finds the standpoint when it was assumed 40 m off", () => {
  const truth = { lat: 46.62, lon: 7.9, eyeHeight: 10, bearing: 80, pitch: -8, roll: 0, fov: 40 };
  const places = [[250, -12], [270, 6, 8], [200, 14], [520, 2], [430, -9], [120, 5], [650, -4, 5]];
  const points = synthetic(truth, places);
  const proj = localProjection(truth.lat, truth.lon);
  const [lat, lon] = proj.toLatLon(-30, 25); // wrong start: 39 m away
  const sol = solveCamera({ points, width: 918, height: 2040, lat, lon, eyeHeight: 6, solvePosition: true, terrain });
  const [e, n] = proj.toXY(sol.camera.lat, sol.camera.lon);
  assert.ok(Math.hypot(e, n) < 3, `camera off by ${Math.hypot(e, n).toFixed(1)} m`);
  assert.ok(Math.abs(sol.camera.eye_height_m - 10) < 2, `eye ${sol.camera.eye_height_m}`);
  assert.ok(Math.abs(sol.view.bearing_deg - 80) < 0.5 && sol.rms_px < 2);
});

test("a wrong point shows up with a large error", () => {
  const truth = { lat: 46.62, lon: 7.9, eyeHeight: 10, bearing: 83, pitch: -9, roll: 0, fov: 38 };
  const points = synthetic(truth, [[250, -12], [270, 6], [200, 14], [520, 2], [430, -9]]);
  points[2] = { ...points[2], x: points[2].x + 0.2 }; // mismatched
  const sol = solveCamera({ points, width: 918, height: 2040, lat: truth.lat, lon: truth.lon, eyeHeight: 10, solvePosition: false, solveHeight: false, terrain });
  const worst = sol.points.reduce((a, b) => (b.error_px > a.error_px ? b : a));
  assert.equal(worst.index, 3);
  assert.throws(() => solveCamera({ points: points.slice(0, 2), width: 918, height: 2040, lat: 0, lon: 0 }), /Mindestens 3/);
});

test("points in a narrow cluster: the standpoint is only moved when that clearly explains them better", () => {
  const truth = { lat: 46.62, lon: 7.9, eyeHeight: 10, bearing: 81, pitch: -5, roll: 0, fov: 36 };
  const places = [[230, -6], [240, 3], [260, 8], [480, -4], [520, 5], [560, 1]];
  const points = synthetic(truth, places);
  // Assumed standpoint 15 m too far north: holding it fixed would need a tilted horizon.
  const proj = localProjection(truth.lat, truth.lon);
  const [lat, lon] = proj.toLatLon(0, 15);
  const sol = solveCamera({ points, width: 918, height: 2040, lat, lon, eyeHeight: 10, terrain });
  assert.equal(sol.position_by_fit, true);
  const [e, n] = proj.toXY(sol.camera.lat, sol.camera.lon);
  assert.ok(Math.hypot(e, n) < 6, `camera off by ${Math.hypot(e, n).toFixed(1)} m`);
  assert.ok(Math.abs(sol.view.roll_deg) < 1 && sol.rms_pct < 0.5);
  // Right standpoint: nothing to move.
  const exact = solveCamera({ points, width: 918, height: 2040, lat: truth.lat, lon: truth.lon, eyeHeight: 10, terrain });
  assert.equal(exact.position_by_fit, undefined);
  assert.ok(exact.rms_px < 1);
});

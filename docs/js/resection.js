// Camera resection ("Rückwärtsschnitt"): from a few points that can be seen both in the photo and on the
// map, compute where the camera stood and how it was pointed – viewing direction, tilt, roll, field of view
// and position – by least squares (Levenberg–Marquardt) on the pinhole model plus the terrain model.

import { groundModel, makeCamera } from "./scene3d.js";

const DEG = Math.PI / 180;

/** Solve A·x = b (small dense system, Gaussian elimination with partial pivoting). */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Minimise the sum of squared residuals(params) with Levenberg–Marquardt and numeric derivatives.
 * `steps` are the finite-difference sizes per parameter.
 */
export function levenbergMarquardt(residuals, start, { steps, iterations = 80 } = {}) {
  let x = [...start];
  let r = residuals(x);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-2;
  for (let it = 0; it < iterations; it++) {
    const J = x.map((_, j) => {
      const xp = [...x];
      xp[j] += steps[j];
      return residuals(xp).map((v, i) => (v - r[i]) / steps[j]);
    });
    const n = x.length;
    const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
    const Jtr = J.map((col) => col.reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)));
      const dx = solveLinear(A, Jtr.map((v) => -v));
      if (!dx) break;
      const xn = x.map((v, j) => v + dx[j]);
      const rn = residuals(xn);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        const gain = cost - cn;
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 3, 1e-7);
        improved = true;
        if (gain < 1e-10 * (1 + cost)) it = iterations;
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { x, cost, residuals: r };
}

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * Where does each map point appear in the photo for a given pose?
 * points: [{ lat, lon, height_m }], pose: { e, n (m from the reference), eyeHeight, bearing, pitch, roll, fov }.
 */
function makeProjector({ lat, lon, terrain, width, height, points }) {
  const g0 = groundModel({ lat, lon, eyeHeight: 0, terrain });
  // Ground elevation (absolute) and local position of every point, relative to the reference position.
  const pts = points.map((p) => {
    const [x, y] = g0.proj.toXY(p.lat, p.lon);
    const d = Math.hypot(x, y);
    const ground = g0.groundZ(x, y, Math.max(d, 1)) + g0.eyeZ + g0.drop(Math.max(d, 1)); // back to absolute
    return { x, y, z: ground + (p.height_m || 0) };
  });
  return (pose) => {
    const [la, lo] = g0.proj.toLatLon(pose.e, pose.n);
    const g = groundModel({ lat: la, lon: lo, eyeHeight: pose.eyeHeight, terrain });
    const cam = makeCamera({ bearingDeg: pose.bearing, pitchDeg: pose.pitch, rollDeg: pose.roll, fovDeg: pose.fov, width, height });
    return pts.map((p) => {
      const dx = p.x - pose.e;
      const dy = p.y - pose.n;
      const d = Math.hypot(dx, dy);
      const c = cam.toCam([dx, dy, p.z - g.eyeZ - g.drop(d)]);
      if (c[2] <= 0.5) return null; // behind the camera
      return cam.project(c);
    });
  };
}

/**
 * How well can the points fix the standpoint? Points spread over a wide angle and at clearly different
 * distances pin it down; a tight cluster far away only fixes the direction.
 */
export function pointGeometry(points, lat, lon) {
  const k = Math.cos(lat * DEG) * 111195;
  const polar = points.map((p) => {
    const e = (p.lon - lon) * k;
    const n = (p.lat - lat) * 111195;
    return { az: Math.atan2(e, n) / DEG, d: Math.hypot(e, n) };
  });
  const ref = polar[0].az;
  const offs = polar.map((p) => wrap180(p.az - ref));
  const spreadDeg = Math.max(...offs) - Math.min(...offs);
  const ds = polar.map((p) => p.d);
  const depthRatio = Math.max(...ds) / Math.max(1, Math.min(...ds));
  return { spreadDeg, depthRatio, strong: points.length >= 5 && spreadDeg >= 25 && depthRatio >= 2 };
}

/**
 * Solve the camera pose from photo↔map correspondences.
 * points: [{ x, y } in 0–1 photo coordinates, lat, lon, height_m (above ground, default 0)]
 * Start: lat/lon/eyeHeight (the assumed standpoint), fovDeg (fixed when fixFov, e.g. from EXIF).
 * solveHeight: fit the eye height too (default with ≥ 4 points).
 * solvePosition: also move the standpoint (default only when the points' geometry allows it; kept near
 * the start by positionSigmaM, the uncertainty of the assumed standpoint).
 */
export function solveCamera({
  points, width, height, lat, lon, eyeHeight = 1.6, fovDeg = null, fixFov = false, solvePosition = null, solveHeight = null,
  positionSigmaM = 25, heightSigmaM = 15, rollSigmaDeg = 1.5, terrain = null,
}) {
  if (points.length < 3) throw new Error("Mindestens 3 Punkte nötig (besser 4–8, gut über das Bild verteilt).");
  const geometry = pointGeometry(points, lat, lon);
  const project = makeProjector({ lat, lon, terrain, width, height, points });
  const g0 = groundModel({ lat, lon, eyeHeight: 0, terrain });
  const local = points.map((p) => g0.proj.toXY(p.lat, p.lon));
  const obs = points.map((p) => [p.x * width, p.y * height]);
  const scale = 1000 / width; // residuals in thousandths of the image width

  // Start values: look at the points' mean direction, tilt towards their mean depression.
  const azs = local.map(([x, y]) => Math.atan2(x, y) / DEG);
  const ref = azs[0];
  const meanAz = ref + azs.reduce((s, a) => s + wrap180(a - ref), 0) / azs.length;
  const fovStarts = fixFov && fovDeg ? [fovDeg] : [...new Set([fovDeg, 35, 50, 65, 80].filter(Boolean))];

  const fit = (movePosition, moveHeight) => {
    // Parameters: bearing, pitch, roll, fov, [eye height], [east, north].
    const unpack = (v) => ({
      bearing: v[0], pitch: v[1], roll: v[2], fov: fixFov && fovDeg ? fovDeg : v[3],
      eyeHeight: moveHeight ? v[4] : eyeHeight, e: movePosition ? v[5] : 0, n: movePosition ? v[6] : 0,
    });
    const residuals = (v) => {
      const pose = unpack(v);
      if (pose.fov < 5 || pose.fov > 150 || pose.eyeHeight < 0.2) return obs.flatMap(() => [1e4, 1e4]);
      const pred = project(pose);
      const r = pred.flatMap((p, i) => (p ? [(p[0] - obs[i][0]) * scale, (p[1] - obs[i][1]) * scale] : [1e3, 1e3]));
      // Weak priors keep the standpoint near the assumed one unless the points clearly say otherwise.
      if (moveHeight) r.push(((v[4] - eyeHeight) / heightSigmaM) * 5);
      if (movePosition) r.push((v[5] / positionSigmaM) * 5, (v[6] / positionSigmaM) * 5);
      // A given field of view (e.g. the typical phone value) is a good guess; without one anything goes.
      if (!(fixFov && fovDeg)) r.push(fovDeg ? ((v[3] - fovDeg) / 8) * 3 : ((v[3] - 60) / 60) * 2);
      // Photos are almost always held nearly level; a few points alone cannot tell roll from a wrong standpoint.
      r.push((v[2] / rollSigmaDeg) * 5);
      return r;
    };
    let best = null;
    for (const fov0 of fovStarts) {
      for (const pitch0 of [-5, -20, 5]) {
        const start = [meanAz, pitch0, 0, fov0, ...(moveHeight ? [eyeHeight] : []), ...(movePosition ? [0, 0] : [])];
        const steps = [0.02, 0.02, 0.02, 0.02, ...(moveHeight ? [0.05] : []), ...(movePosition ? [0.05, 0.05] : [])];
        const f = levenbergMarquardt(residuals, start, { steps });
        if (!best || f.cost < best.cost) best = f;
      }
    }
    const pose = unpack(best.x);
    const pred = project(pose);
    const errors = pred.map((p, i) => (p ? Math.hypot(p[0] - obs[i][0], p[1] - obs[i][1]) : Infinity));
    const rms = Math.sqrt(errors.reduce((s, e) => s + (Number.isFinite(e) ? e * e : 1e8), 0) / errors.length);
    const [camLat, camLon] = g0.proj.toLatLon(pose.e, pose.n);
    return {
      camera: { lat: camLat, lon: camLon, eye_height_m: pose.eyeHeight, moved_m: Math.hypot(pose.e, pose.n), east_m: pose.e, north_m: pose.n },
      view: { bearing_deg: ((pose.bearing % 360) + 360) % 360, pitch_deg: pose.pitch, roll_deg: pose.roll, fov_deg: pose.fov },
      points: points.map((p, i) => ({
        index: i + 1,
        error_px: Number.isFinite(errors[i]) ? errors[i] : null,
        error_pct: Number.isFinite(errors[i]) ? (100 * errors[i]) / width : null,
        predicted: pred[i] ? { x: pred[i][0] / width, y: pred[i][1] / height } : null,
      })),
      rms_px: rms,
      rms_pct: (100 * rms) / width,
      solved_position: movePosition,
      solved_height: moveHeight,
      geometry,
    };
  };

  const movePosition = solvePosition ?? geometry.strong;
  const result = fit(movePosition, movePosition || (solveHeight ?? points.length >= 4));
  // Points in a narrow cluster cannot pin the standpoint down on their own – but when holding it fixed
  // leaves clearly worse errors, a standpoint within the stated uncertainty explains the photo better.
  if (solvePosition == null && !movePosition && points.length >= 4) {
    const moved = fit(true, true);
    if (moved.rms_px < 0.75 * result.rms_px && moved.camera.moved_m <= 2 * positionSigmaM) return { ...moved, position_by_fit: true };
  }
  return result;
}

/** Browser: load the terrain around the standpoint and the points, then solve. */
export async function solveCameraWithTerrain({ terrain, ...opts }) {
  const lats = [opts.lat, ...opts.points.map((p) => p.lat)];
  const lons = [opts.lon, ...opts.points.map((p) => p.lon)];
  const pad = 0.004;
  const box = [Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad];
  // Fine tiles where possible; coarse ones everywhere as a fallback.
  await Promise.all([terrain.prefetchBox(...box, 14), terrain.prefetchBox(...box, 12)]).catch(() => {});
  return solveCamera({ ...opts, terrain });
}

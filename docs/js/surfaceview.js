// Top view from the photo alone, before the place is known: the visible ground laid flat (level ground in
// front of the camera assumed), with a metre grid and the surfaces the AI outlined in the photo (asphalt,
// meadow, water …) in colour – so shapes, widths and angles can be compared with aerial images.
// How far it can be trusted is computed, not guessed: the photo's resolution on the ground and how exactly
// the horizon (the camera's tilt) is known. Plain functions (tested in Node); the drawing is in groundview.js.

import { makeCamera } from "./scene3d.js";

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Surface kinds and their colours (RGB). */
export const SURFACES = {
  asphalt: [70, 72, 80], pflaster: [176, 120, 88], beton: [190, 190, 184], schotter: [186, 170, 132], erde: [139, 98, 58],
  sand: [228, 204, 142], wiese: [96, 176, 72], acker: [206, 172, 60], wald: [30, 112, 52], wasser: [40, 124, 224],
  schnee: [236, 242, 250], gleis: [128, 84, 128], gehweg: [210, 204, 194], markierung: [255, 255, 255], sonstiges: [232, 90, 200],
};
export const SURFACE_NAMES = Object.keys(SURFACES);
// Other words the AI may use for them.
const SYNONYMS = {
  strasse: "asphalt", straße: "asphalt", fahrbahn: "asphalt", teer: "asphalt", parkplatz: "asphalt", kopfsteinpflaster: "pflaster",
  platten: "pflaster", rasen: "wiese", gras: "wiese", weide: "wiese", feld: "acker", baeume: "wald", bäume: "wald", hecke: "wald",
  see: "wasser", fluss: "wasser", bach: "wasser", meer: "wasser", kies: "schotter", feldweg: "erde", weg: "gehweg", fußweg: "gehweg",
  fussweg: "gehweg", bürgersteig: "gehweg", trottoir: "gehweg", schiene: "gleis", gleise: "gleis", eis: "schnee", strand: "sand",
};

/** The known kind for a word the AI used (lower case, first word), else "sonstiges". */
export function surfaceKind(word) {
  const w = String(word || "").toLowerCase().trim().split(/[\s,/(-]+/)[0];
  return SURFACES[w] ? w : SYNONYMS[w] || "sonstiges";
}

/** Camera tilt from where the horizon crosses the middle of the photo (0 = top, 1 = bottom). */
export function pitchFromHorizon(horizonY, { fovDeg, width, height, rollDeg = 0 }) {
  const fpx = width / 2 / Math.tan((clamp(fovDeg, 1, 170) * DEG) / 2);
  return Math.atan(((horizonY - 0.5) * height * Math.cos(rollDeg * DEG)) / fpx) / DEG;
}

/**
 * Up to where the flat top view holds (metres): the ground must still be resolved to about half a metre per
 * photo pixel, and an error of the tilt must change the scale by less than 15 %. A known horizon pins the
 * tilt to about 0.4 % of the image height; a given pitch to about 1.5°; a guess to 3°.
 */
export function reliableRange({ eyeHeight, fovDeg, width, height, source = "horizont" }) {
  const fpx = width / 2 / Math.tan((clamp(fovDeg, 1, 170) * DEG) / 2);
  const tiltError = source === "horizont" ? Math.max((0.004 * height) / fpx, 0.1 * DEG) : source === "neigung" ? 1.5 * DEG : 3 * DEG;
  const byResolution = Math.sqrt(0.5 * eyeHeight * fpx);
  const byTilt = (0.15 * eyeHeight) / tiltError;
  return { metres: Math.max(3, Math.min(byResolution, byTilt)), byResolution, byTilt, tiltErrorDeg: tiltError / DEG };
}

/** Which surface each pixel of a w×h grid over the photo belongs to (index into `surfaces`, −1 = none); later outlines win. */
export function surfaceMask(surfaces, w, h) {
  const mask = new Int8Array(w * h).fill(-1);
  surfaces.forEach((s, k) => {
    const pts = s.punkte.map(([x, y]) => [x * w, y * h]);
    if (pts.length < 3) return;
    const ys = pts.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[i + 1] - 0.5)); x++) mask[y * w + x] = k;
      }
    }
  });
  return mask;
}

/** Ground point (metres right of / ahead of the camera) seen at photo pixel (u, v), or null above the horizon. */
export function groundPoint(cam, eyeHeight, u, v) {
  const a = (u - cam.width / 2) / cam.fpx;
  const b = (cam.height / 2 - v) / cam.fpx;
  const d = [0, 1, 2].map((i) => cam.f[i] + a * cam.r[i] + b * cam.u[i]);
  if (d[2] >= -1e-6) return null;
  const t = eyeHeight / -d[2];
  return [d[0] * t, d[1] * t];
}

/**
 * Lay the photo flat. photo: { width, height, data (RGBA) }; camera looking "north" (up in the result),
 * standing at (0, 0). Returns the extent, and per output pixel the colour (RGBA, transparent where the photo
 * shows no ground) and the surface index. mPerPx is chosen so the longer side has `panel` pixels.
 */
export function flatTopView({ photo, fovDeg, pitchDeg = 0, rollDeg = 0, eyeHeight = 1.6, minDistM = 0, maxDistM = 60, surfaces = [], panel = 560 }) {
  const { width: W, height: H, data: src } = photo;
  const cam = makeCamera({ bearingDeg: 0, pitchDeg, rollDeg, fovDeg, width: W, height: H });
  // Extent: the ground points of a coarse grid over the photo.
  let minE = Infinity;
  let maxE = -Infinity;
  let maxN = 0;
  let minN = Infinity;
  // Rays beyond maxDistM (or above the horizon) count as reaching maxDistM in their direction.
  let groundSeen = false;
  for (let gy = 0; gy <= 40; gy++) {
    for (let gx = 0; gx <= 40; gx++) {
      const u = (gx / 40) * W;
      const v = (gy / 40) * H;
      let p = groundPoint(cam, eyeHeight, u, v);
      if (p) groundSeen = true;
      if (!p || Math.hypot(p[0], p[1]) > maxDistM) {
        const a = (u - W / 2) / cam.fpx;
        const b = (H / 2 - v) / cam.fpx;
        const dx = cam.f[0] + a * cam.r[0] + b * cam.u[0];
        const dy = cam.f[1] + a * cam.r[1] + b * cam.u[1];
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        p = [(dx / len) * maxDistM, (dy / len) * maxDistM];
      }
      if (Math.hypot(p[0], p[1]) < minDistM || p[1] <= 0) continue;
      minE = Math.min(minE, p[0]);
      maxE = Math.max(maxE, p[0]);
      minN = Math.min(minN, p[1]);
      maxN = Math.max(maxN, p[1]);
    }
  }
  if (!groundSeen) return null;
  if (!(maxN > 0) || !(maxE > minE)) return null;
  // Room for the camera at the bottom, a little margin around.
  const pad = 0.04 * Math.max(maxE - minE, maxN);
  minE -= pad;
  maxE += pad;
  maxN += pad;
  minN = Math.min(0, minN) - pad;
  const mPerPx = Math.max(maxE - minE, maxN - minN) / panel;
  const width = Math.max(1, Math.round((maxE - minE) / mPerPx));
  const height = Math.max(1, Math.round((maxN - minN) / mPerPx));
  const mw = Math.min(W, 480);
  const mh = Math.max(1, Math.round((mw * H) / W));
  const mask = surfaces.length ? surfaceMask(surfaces, mw, mh) : null;
  const data = new Uint8ClampedArray(width * height * 4);
  const cls = new Int8Array(width * height).fill(-1);
  let covered = 0;
  let nearest = Infinity;
  let farthest = 0;
  for (let j = 0; j < height; j++) {
    const n = maxN - (j + 0.5) * mPerPx;
    for (let i = 0; i < width; i++) {
      const e = minE + (i + 0.5) * mPerPx;
      const s = Math.hypot(e, n);
      if (s > maxDistM || s < minDistM) continue;
      const c = cam.toCam([e, n, -eyeHeight]);
      if (c[2] <= 0.05) continue;
      const [u, v] = cam.project(c);
      if (u < 0 || u >= W || v < 0 || v >= H) continue;
      const k = (j * width + i) * 4;
      const si = (Math.floor(v) * W + Math.floor(u)) * 4;
      data[k] = src[si];
      data[k + 1] = src[si + 1];
      data[k + 2] = src[si + 2];
      data[k + 3] = 255;
      if (mask) cls[j * width + i] = mask[Math.min(mh - 1, Math.floor((v / H) * mh)) * mw + Math.min(mw - 1, Math.floor((u / W) * mw))];
      covered += 1;
      nearest = Math.min(nearest, s);
      farthest = Math.max(farthest, s);
    }
  }
  if (!covered) return null;
  return { width, height, data, cls, mPerPx, minE, maxE, minN, maxN, nearest, farthest, cam };
}

/**
 * Per surface: area and distance range in the top view, and its width across the view (median over the rows
 * inside `upToM` metres) – e.g. how wide a road is.
 */
export function surfaceStats(view, surfaces, upToM = Infinity) {
  return surfaces.map((s, k) => {
    let px = 0;
    let near = Infinity;
    let far = 0;
    const widths = [];
    for (let j = 0; j < view.height; j++) {
      const n = view.maxN - (j + 0.5) * view.mPerPx;
      let row = 0;
      for (let i = 0; i < view.width; i++) {
        if (view.cls[j * view.width + i] !== k) continue;
        px += 1;
        row += 1;
        const e = view.minE + (i + 0.5) * view.mPerPx;
        const d = Math.hypot(e, n);
        near = Math.min(near, d);
        far = Math.max(far, d);
      }
      if (row && n <= upToM) widths.push(row * view.mPerPx);
    }
    widths.sort((a, b) => a - b);
    return {
      art: s.art,
      area_m2: Math.round(px * view.mPerPx * view.mPerPx),
      near_m: px ? Math.round(near) : null,
      far_m: px ? Math.round(far) : null,
      width_m: widths.length ? Math.round(widths[Math.floor(widths.length / 2)] * 10) / 10 : null,
    };
  });
}

/** Check and tidy the surfaces the AI sent: known kind, at least three points in 0–1. */
export function cleanSurfaces(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 16).flatMap((s) => {
    const art = surfaceKind(s?.art);
    const pts = Array.isArray(s?.punkte) ? s.punkte.filter((p) => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite)) : [];
    if (pts.length < 3) return [];
    // Corners may lie a little outside the photo (an outline cut by the edge); clamping them would bend the shape.
    return [{ art, punkte: pts.slice(0, 40).map(([x, y]) => [clamp(x, -1, 2), clamp(y, -1, 2)]) }];
  });
}

/**
 * Settings of a top view from the photo: tilt (from horizon_y, else pitch_deg, else a level guess), how far it
 * holds and how far to draw (twice that, 15–150 m, unless given). The photo is projected at ≤ 1600 px.
 */
export function surfacePlan({ width, height, fovDeg, rollDeg = 0, eyeHeight = 1.6, horizonY = null, pitchDeg = null, maxDistM = null }) {
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const source = horizonY != null ? "horizont" : pitchDeg != null ? "neigung" : "geschaetzt";
  const pitch = horizonY != null ? pitchFromHorizon(horizonY, { fovDeg, width, height, rollDeg }) : pitchDeg ?? 0;
  const reliable = reliableRange({ eyeHeight, fovDeg, width: width * scale, height: height * scale, source }).metres;
  return { pitchDeg: pitch, source, reliableM: reliable, maxDistM: maxDistM ?? Math.min(150, Math.max(15, reliable * 2)) };
}

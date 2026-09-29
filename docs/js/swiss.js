// Exact terrain heights for Switzerland from swisstopo (free, no key, CORS): the 2 m terrain model
// swissALTI3D instead of the worldwide model (SRTM-based, 20–100 m off at steep crests). Used for the
// heights of ground points in the resection and for the mountain ridges in the skyline match.

/** Rough box around Switzerland and Liechtenstein (the services answer beyond it, but less exactly). */
export const inSwitzerland = (lat, lon) => lat > 45.8 && lat < 47.85 && lon > 5.9 && lon < 10.55;

/** WGS84 → Swiss LV95 [E, N] (swisstopo's approximate formulas, about 1 m). */
export function wgs84ToLv95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
  const n = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
  return [e, n];
}

/** Swiss LV95 → WGS84 [lat, lon]. */
export function lv95ToWgs84(e, n) {
  const y = (e - 2600000) / 1e6;
  const x = (n - 1200000) / 1e6;
  const l = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const p = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return [(p * 100) / 36, (l * 100) / 36];
}

const API = "https://api3.geo.admin.ch/rest/services";
const heightCache = new Map();

/** Terrain height (m) at one point, or null. */
export async function swissHeight(fetchImpl, lat, lon) {
  const [e, n] = wgs84ToLv95(lat, lon);
  const key = `${e.toFixed(1)},${n.toFixed(1)}`;
  if (heightCache.has(key)) return heightCache.get(key);
  const resp = await fetchImpl(`${API}/height?easting=${e.toFixed(1)}&northing=${n.toFixed(1)}&sr=2056`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const h = parseFloat((await resp.json()).height);
  if (!Number.isFinite(h)) return null;
  heightCache.set(key, h);
  return h;
}

/** Heights for several points (a few requests at a time). */
export async function swissHeights(fetchImpl, points, concurrency = 4) {
  const out = new Array(points.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < points.length) {
      const i = next++;
      out[i] = await swissHeight(fetchImpl, points[i].lat, points[i].lon).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, points.length) }, worker));
  return out;
}

/**
 * Heights along a polyline ([[lat, lon], …]) sampled evenly with nbPoints (max 5000): [{ lat, lon, h }].
 * One request; the 2 m model (DTM2) where available.
 */
export async function swissProfile(fetchImpl, line, nbPoints = 1000) {
  const geom = { type: "LineString", coordinates: line.map(([la, lo]) => wgs84ToLv95(la, lo).map((v) => Math.round(v * 10) / 10)) };
  const resp = await fetchImpl(`${API}/profile.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ geom: JSON.stringify(geom), sr: "2056", nb_points: String(Math.min(5000, Math.max(2, Math.round(nbPoints)))) }).toString(),
  });
  if (!resp.ok) throw new Error(`swisstopo: HTTP ${resp.status}`);
  return parseProfile(await resp.json());
}

/**
 * The terrain model's error near exact heights (samples: [{ lat, lon, h }]) as a function (lat, lon, z) → m
 * to add: the error at each sample, spread by inverse distance weighting (the nearest one dominates) and
 * fading out within rangeM of the nearest one.
 */
export function heightCorrection(terrain, samples, rangeM = 300) {
  const pts = samples.filter((s) => Number.isFinite(s.h));
  // Beyond this box (the samples plus rangeM) nothing changes – a quick exit for the many far samples.
  const pad = rangeM / 111195;
  const box = pts.length && {
    s: Math.min(...pts.map((p) => p.lat)) - pad, n: Math.max(...pts.map((p) => p.lat)) + pad,
    w: Math.min(...pts.map((p) => p.lon)) - 2 * pad, e: Math.max(...pts.map((p) => p.lon)) + 2 * pad,
  };
  const model = (la, lo, z) => (terrain.modelElevation ? terrain.modelElevation(la, lo, z) : terrain.elevation(la, lo, z));
  // The model's error at each sample, per zoom; again when tiles were loaded (a finer tile changes the model).
  const errors = new Map();
  let tiles = -1;
  return (lat, lon, z = 14) => {
    if (!box || lat < box.s || lat > box.n || lon < box.w || lon > box.e) return 0;
    if ((terrain.tiles?.size ?? 0) !== tiles) {
      tiles = terrain.tiles?.size ?? 0;
      errors.clear();
    }
    if (!errors.has(z)) errors.set(z, pts.map((s) => {
      const m = model(s.lat, s.lon, z);
      return m == null ? null : s.h - m;
    }));
    const err = errors.get(z);
    const ky = 111195;
    const kx = ky * Math.cos((lat * Math.PI) / 180);
    let sw = 0;
    let sum = 0;
    let dmin = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (err[i] == null) continue;
      const r2 = ((lon - pts[i].lon) * kx) ** 2 + ((lat - pts[i].lat) * ky) ** 2;
      const w = 1 / (r2 + 25);
      sw += w;
      sum += w * err[i];
      dmin = Math.min(dmin, r2);
    }
    const fade = 1 - Math.sqrt(dmin) / rangeM;
    return sw && fade > 0 ? (sum / sw) * fade : 0;
  };
}

/**
 * Teach the terrain model exact heights: from then on its elevation() is corrected near them, for every
 * view built on it (resection, top view, 3D model, skyline). Returns the number of heights known.
 */
export function addExactHeights(terrain, samples) {
  const known = (terrain.exactHeights ||= []);
  for (const s of samples) {
    if (Number.isFinite(s.h) && !known.some((k) => Math.abs(k.lat - s.lat) < 1e-6 && Math.abs(k.lon - s.lon) < 1e-6)) known.push({ lat: s.lat, lon: s.lon, h: s.h });
  }
  terrain.correction = known.length ? heightCorrection(terrain, known) : null;
  return known.length;
}

/** In Switzerland: fetch the exact heights of these points ([{ lat, lon }]) and teach them to the terrain model. */
export async function learnSwissHeights(terrain, fetchImpl, points) {
  const inside = points.filter((p) => inSwitzerland(p.lat, p.lon));
  if (!fetchImpl || !inside.length) return 0;
  const heights = await swissHeights(fetchImpl, inside).catch(() => []);
  const samples = inside.map((p, i) => ({ lat: p.lat, lon: p.lon, h: heights[i] })).filter((s) => Number.isFinite(s.h));
  return samples.length ? addExactHeights(terrain, samples) : 0;
}

export function parseProfile(json) {
  const out = [];
  for (const p of Array.isArray(json) ? json : []) {
    const h = p.alts?.DTM2 ?? p.alts?.COMB ?? p.alts?.DTM25;
    if (!Number.isFinite(h) || !Number.isFinite(p.easting)) continue;
    const [lat, lon] = lv95ToWgs84(p.easting, p.northing);
    out.push({ lat, lon, h });
  }
  return out;
}

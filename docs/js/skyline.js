// Mountain skylines ("Gipfelfinder", like the PeakFinder app): the line where the sky meets the land in the
// photo is matched against the horizon the terrain model predicts from a standpoint. The match fixes the
// viewing direction, tilt, roll and field of view to a fraction of a degree, tests or improves the
// standpoint (near ridges shift against far ones when the camera moves) and names the visible peaks with
// height, distance and direction. Exact geodesy (WGS84) plus earth curvature and refraction, so it holds
// up to ~200 km. Pure functions first (tested in Node), browser parts at the end.

import { levenbergMarquardt, solveLinear } from "./resection.js";
import { makeCamera, parseLength } from "./scene3d.js";
import { worldPixel } from "./mapview.js";
import { learnSwissHeights } from "./swiss.js";
import { timeoutSignal } from "./geo.js";

const DEG = Math.PI / 180;
const WGS_A = 6378137;
const WGS_E2 = 0.00669437999014;
const EARTH_R = 6371000;
const REFRACTION = 0.87; // light bends a little around the earth: distant terrain appears slightly higher
const TILE = 256;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const wrap360 = (a) => ((a % 360) + 360) % 360;

// ---------- geodesy ----------

/** Meridian and prime-vertical radius of curvature of the WGS84 ellipsoid at latitude phi (radians). */
function radii(phi) {
  const s = Math.sin(phi);
  const w = Math.sqrt(1 - WGS_E2 * s * s);
  return [(WGS_A * (1 - WGS_E2)) / (w * w * w), WGS_A / w];
}

/**
 * Distance (m) and initial azimuth (degrees from north) between two points: Gauss mid-latitude formulas on
 * WGS84, accurate to metres at 200 km. (A flat lat/lon grid is off by up to 0.7° in direction at 150 km.)
 */
export function geoInverse(lat0, lon0, lat1, lon1) {
  const dphi = (lat1 - lat0) * DEG;
  const dlam = wrap180(lon1 - lon0) * DEG;
  const pm = ((lat0 + lat1) / 2) * DEG;
  const [M, N] = radii(pm);
  const x = N * Math.cos(pm) * dlam;
  const y = M * dphi;
  return { distance: Math.hypot(x, y), azimuth: wrap360((Math.atan2(x, y) - (dlam * Math.sin(pm)) / 2) / DEG) };
}

/** The point `distanceM` from (lat0, lon0) along the initial azimuth: [lat, lon]. */
export function geoDirect(lat0, lon0, azimuthDeg, distanceM) {
  const p0 = lat0 * DEG;
  const a0 = azimuthDeg * DEG;
  let dphi = 0;
  let dlam = 0;
  for (let i = 0; i < 3; i++) {
    const pm = p0 + dphi / 2;
    const [M, N] = radii(pm);
    const am = a0 + (dlam * Math.sin(pm)) / 2;
    dphi = (distanceM * Math.cos(am)) / M;
    dlam = (distanceM * Math.sin(am)) / (N * Math.cos(pm));
  }
  return [lat0 + dphi / DEG, lon0 + dlam / DEG];
}

/** How far terrain at distance d sinks below the eye's horizontal plane (earth curvature minus refraction). */
export const dropAt = (d) => ((d * d) / (2 * EARTH_R)) * REFRACTION;

// ---------- terrain grids ----------

/** Grid levels: fine near the centre, coarse far away (grid step ≈ tile pixel size at that zoom). */
export const DEM_FINE = [
  { half: 3000, step: 10, zoom: 14 },
  { half: 15000, step: 30, zoom: 12 },
  { half: 60000, step: 110, zoom: 10 },
  { half: 220000, step: 220, zoom: 9 },
];
/** For the first, all-round search: a quarter of the data, still ~0.1° sharp. */
export const DEM_COARSE = [
  { half: 3000, step: 25, zoom: 13 },
  { half: 15000, step: 70, zoom: 11 },
  { half: 60000, step: 220, zoom: 9 },
  { half: 220000, step: 600, zoom: 8 },
];

/** sector: { center, half } in degrees (null = all round). */
function inSector(sector, az, margin) {
  return !sector || margin >= 180 || Math.abs(wrap180(az - sector.center)) <= sector.half + margin;
}

/** Is a grid cell at local (x, y) metres needed? Near the centre everything (the camera may move by shiftM). */
function cellNeeded(x, y, { sector, shiftM, reach, step }) {
  const r = Math.hypot(x, y);
  if (r > reach) return false;
  const margin = r <= shiftM + 3 * step ? 180 : Math.asin(Math.min(1, (shiftM + 2 * step) / r)) / DEG + 1;
  return inSector(sector, Math.atan2(x, y) / DEG, margin);
}

/**
 * Elevations on square grids in metres east/north of a centre point. The grids are azimuthal equidistant:
 * distance and direction from the centre are exact, so straight lines from the camera are true lines of
 * sight. Only cells inside the viewing sector are filled (plus what a camera moved by shiftM needs).
 * elevation(lat, lon, zoom) → metres or null.
 */
export class LocalDem {
  constructor({ lat, lon, elevation, levels = DEM_FINE, sector = null, shiftM = 0, maxDistM = 200000 }) {
    this.lat = lat;
    this.lon = lon;
    this.levels = [];
    for (const L of levels) {
      const reach = maxDistM + shiftM + 3 * L.step;
      const half = Math.ceil(Math.min(L.half, reach) / L.step) * L.step;
      const n = 2 * Math.round(half / L.step) + 1;
      const data = new Float32Array(n * n).fill(NaN);
      const need = { sector, shiftM, reach, step: L.step };
      let maxZ = -Infinity;
      for (let j = 0; j < n; j++) {
        const y = j * L.step - half;
        for (let i = 0; i < n; i++) {
          const x = i * L.step - half;
          if (!cellNeeded(x, y, need)) continue;
          const [la, lo] = geoDirect(lat, lon, Math.atan2(x, y) / DEG, Math.hypot(x, y));
          const z = elevation(la, lo, L.zoom);
          if (z == null || !Number.isFinite(z)) continue;
          const v = z < -15 ? 0 : z; // Terrarium has sea-floor depths; the visible surface is the water
          data[j * n + i] = v;
          if (v > maxZ) maxZ = v;
        }
      }
      this.levels.push({ step: L.step, zoom: L.zoom, half, n, data, usable: half - 2 * L.step, maxZ });
      if (half >= reach) break;
    }
    // Highest terrain from each level outwards: a sight line above it cannot be blocked any more.
    let far = -Infinity;
    for (let k = this.levels.length - 1; k >= 0; k--) {
      far = Math.max(far, this.levels[k].maxZ);
      this.levels[k].farMax = far;
    }
  }

  /** Index of the grid used at local (x, y). */
  levelAt(x, y) {
    const m = Math.max(Math.abs(x), Math.abs(y));
    for (let k = 0; k < this.levels.length; k++) if (m < this.levels[k].usable) return k;
    return this.levels.length - 1;
  }

  /** Bilinear elevation at local (x, y) metres; NaN outside the filled cells. */
  height(x, y) {
    const m = Math.max(Math.abs(x), Math.abs(y));
    for (const L of this.levels) {
      if (m >= L.usable) continue;
      const fx = (x + L.half) / L.step;
      const fy = (y + L.half) / L.step;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const tx = fx - i;
      const ty = fy - j;
      const k = j * L.n + i;
      const d = L.data;
      const v = (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - ty) + (d[k + L.n] * (1 - tx) + d[k + L.n + 1] * tx) * ty;
      if (v === v) return v;
    }
    return NaN;
  }

  /** Highest grid value within `radius` metres of (x, y) (summits are rounded off in coarse grids). */
  peakHeight(x, y, radius) {
    const L = this.levels[this.levelAt(x, y)];
    const r = Math.max(1, Math.round(radius / L.step));
    let best = NaN;
    const i0 = Math.round((x + L.half) / L.step);
    const j0 = Math.round((y + L.half) / L.step);
    for (let j = j0 - r; j <= j0 + r; j++) {
      for (let i = i0 - r; i <= i0 + r; i++) {
        if (i < 0 || j < 0 || i >= L.n || j >= L.n) continue;
        const v = L.data[j * L.n + i];
        if (v === v && !(v <= best)) best = v;
      }
    }
    return best;
  }

  toLocal(lat, lon) {
    const { distance, azimuth } = geoInverse(this.lat, this.lon, lat, lon);
    return [distance * Math.sin(azimuth * DEG), distance * Math.cos(azimuth * DEG)];
  }

  toLatLon(x, y) {
    return geoDirect(this.lat, this.lon, wrap360(Math.atan2(x, y) / DEG), Math.hypot(x, y));
  }
}

/** Tile keys ("z/x/y") the grids of a LocalDem will read; zooms are lowered where a level would need too many. */
export function demTiles({ lat, lon, levels = DEM_FINE, sector = null, shiftM = 0, maxDistM = 200000, maxTilesPerLevel = 40 }) {
  const out = [];
  const keys = new Set();
  for (const L of levels) {
    const reach = maxDistM + shiftM + 3 * L.step;
    const half = Math.min(L.half, reach);
    let zoom = L.zoom;
    let set;
    for (; zoom >= 6; zoom--) {
      // Probe points closer together than a tile, so no tile the grid touches is missed.
      const tileM = (40075016 * Math.cos(lat * DEG)) / 2 ** zoom;
      const probe = Math.max(L.step, tileM / 4);
      set = new Set();
      for (let y = -half; y <= half + 1e-6; y += probe) {
        for (let x = -half; x <= half + 1e-6; x += probe) {
          if (!cellNeeded(x, y, { sector, shiftM, reach, step: Math.max(L.step, probe) })) continue;
          const [la, lo] = geoDirect(lat, lon, Math.atan2(x, y) / DEG, Math.hypot(x, y));
          const p = worldPixel(la, lo, zoom);
          const n = 2 ** zoom;
          set.add(`${zoom}/${((Math.floor(p.x / TILE) % n) + n) % n}/${Math.floor(p.y / TILE)}`);
        }
      }
      if (set.size <= maxTilesPerLevel) break;
    }
    out.push({ ...L, zoom });
    for (const k of set) keys.add(k);
    if (half >= reach) break;
  }
  return { levels: out, keys: [...keys] };
}

// ---------- horizon from the terrain ----------

/**
 * The horizon seen from a camera at local (e, n) with the eye at absolute height eyeZ: for `count`
 * azimuths from az0 in steps of stepDeg the highest elevation angle (degrees) and its distance. With
 * `ridges`, also the crest lines in front of it (terrain hidden right behind them), as PeakFinder draws.
 */
export function traceHorizon(dem, { e = 0, n = 0, eyeZ, az0, count, stepDeg, minDistM = 60, maxDistM = 200000, ridges = false }) {
  const el = new Float64Array(count).fill(NaN);
  const dist = new Float32Array(count);
  const crests = ridges ? new Array(count) : null;
  const levels = dem.levels;
  for (let i = 0; i < count; i++) {
    const a = (az0 + i * stepDeg) * DEG;
    const dx = Math.sin(a);
    const dy = Math.cos(a);
    let best = -Infinity;
    let bestD = 0;
    let open = false;
    let pending = null;
    const list = ridges ? [] : null;
    for (let s = minDistM; s <= maxDistM;) {
      const x = e + dx * s;
      const y = n + dy * s;
      const L = levels[dem.levelAt(x, y)];
      const z = dem.height(x, y);
      const drop = dropAt(s);
      if (z === z) {
        const t = (z - eyeZ - drop) / s;
        if (t >= best) {
          // A new visible stretch far behind the last one: that one was a ridge with hidden ground behind it.
          if (list && !open && pending && s - pending.d > Math.max(40, pending.d * 0.08)) list.push({ el: Math.atan(pending.t) / DEG, d: pending.d });
          if (!open) pending = null;
          best = t;
          bestD = s;
          open = true;
        } else if (open) {
          pending = { t: best, d: bestD };
          open = false;
        }
      }
      if ((L.farMax - eyeZ - drop) / s < best) break; // nothing further out can rise above this
      s += Math.max(L.step * 0.6, s * 0.004);
    }
    if (best > -Infinity) {
      el[i] = Math.atan(best) / DEG;
      dist[i] = bestD;
    }
    if (crests) crests[i] = list;
  }
  return { az0, stepDeg, count, full: count * stepDeg >= 359.999, el, dist, crests };
}

/** Horizon elevation (deg), its slope (deg per deg of azimuth) and distance at an azimuth, or null. */
export function horizonAt(h, azDeg) {
  const span = h.count * h.stepDeg;
  const rel = h.full ? wrap360(azDeg - h.az0) : wrap180(azDeg - h.az0 - span / 2) + span / 2;
  const f = rel / h.stepDeg;
  let i = Math.floor(f);
  if (!h.full && (i < 0 || i >= h.count - 1)) return null;
  i = ((i % h.count) + h.count) % h.count;
  const j = (i + 1) % h.count;
  const a = h.el[i];
  const b = h.el[j];
  if (!(a === a && b === b)) return null;
  const t = f - Math.floor(f);
  return { el: a + (b - a) * t, slope: (b - a) / h.stepDeg, dist: t < 0.5 ? h.dist[i] : h.dist[j] };
}

// ---------- the skyline in the photo ----------

/** Squared Sobel gradient of channel C at pixel i. */
function sobel2(C, i, W) {
  const gx = C[i - W + 1] + 2 * C[i + 1] + C[i + W + 1] - C[i - W - 1] - 2 * C[i - 1] - C[i + W - 1];
  const gy = C[i + W - 1] + 2 * C[i + W] + C[i + W + 1] - C[i - W - 1] - 2 * C[i - W] - C[i - W + 1];
  return gx * gx + gy * gy;
}

/**
 * Where the sky ends in each column of a photo. pixels: { width, height, data (RGBA) }.
 * Sky is learned from smooth blue or bright-grey pixels in the upper part (its colour changes with
 * height, so per channel a linear model over the rows); then a dynamic programme finds the lowest line
 * with sky above and land below that runs smoothly across the columns. Foreground objects, clouds on
 * the ridge or a lake reflecting the sky give wrong columns – the matching treats those as outliers.
 * Returns { width, height, count, x, y (row, continuous), w (0–1 weight) } for the usable columns.
 */
export function extractSkyline({ width: W, height: H, data }) {
  const N = W * H;
  const R = new Float32Array(N);
  const G = new Float32Array(N);
  const B = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    R[i] = data[4 * i] / 255;
    G[i] = data[4 * i + 1] / 255;
    B[i] = data[4 * i + 2] / 255;
  }
  // Colour gradient (largest Sobel magnitude over the three channels).
  const grad = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      grad[i] = Math.sqrt(Math.max(sobel2(R, i, W), sobel2(G, i, W), sobel2(B, i, W))) / 4;
    }
  }
  // Seeds: smooth, sky-coloured pixels in the upper 60 %.
  const seeds = [];
  for (let y = 1; y < Math.round(H * 0.6); y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (grad[i] > 0.025) continue;
      const r = R[i];
      const g = G[i];
      const b = B[i];
      const v = Math.max(r, g, b);
      const blue = b > r + 0.04 && b >= g - 0.02 && v > 0.3;
      const grey = v > 0.62 && v - Math.min(r, g, b) < 0.1;
      if (blue || grey) seeds.push(i);
    }
  }
  const empty = { width: W, height: H, count: 0, x: new Float32Array(0), y: new Float32Array(0), w: new Float32Array(0), skyPct: 0 };
  if (seeds.length < N * 0.005) return empty;
  // Per channel c(y) = a + b·y, refitted without outliers (sun glare, the odd cloud).
  let use = seeds;
  let model = null;
  for (let pass = 0; pass < 3; pass++) {
    model = [R, G, B].map((C) => {
      let n = 0, sy = 0, sc = 0, syy = 0, syc = 0;
      for (const i of use) {
        const y = Math.floor(i / W);
        n++; sy += y; sc += C[i]; syy += y * y; syc += y * C[i];
      }
      const den = n * syy - sy * sy;
      const b = den > 1e-9 ? (n * syc - sy * sc) / den : 0;
      const a = (sc - b * sy) / n;
      let ss = 0;
      for (const i of use) ss += (C[i] - a - b * Math.floor(i / W)) ** 2;
      return { a, b, sd: Math.max(Math.sqrt(ss / n), 0.03) };
    });
    const keep = use.filter((i) => {
      const y = Math.floor(i / W);
      return [R, G, B].every((C, c) => Math.abs(C[i] - model[c].a - model[c].b * y) < 2.5 * model[c].sd);
    });
    if (keep.length < 50 || keep.length === use.length) break;
    use = keep;
  }
  let ySeedMin = H;
  let ySeedMax = 0;
  for (const i of use) {
    const y = Math.floor(i / W);
    if (y < ySeedMin) ySeedMin = y;
    if (y > ySeedMax) ySeedMax = y;
  }
  const yClampMax = Math.min(H - 1, ySeedMax + 0.15 * H);
  // How much each pixel looks like sky (colour close to the model at its height, and smooth).
  const sky = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const yy = clamp(y, ySeedMin, yClampMax);
    const mu = model.map((m) => m.a + m.b * yy);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d2 = ((R[i] - mu[0]) / model[0].sd) ** 2 + ((G[i] - mu[1]) / model[1].sd) ** 2 + ((B[i] - mu[2]) / model[2].sd) ** 2;
      sky[i] = Math.exp(-d2 / (2 * 3 * 2.5 * 2.5)) / (1 + (grad[i] / 0.06) ** 2);
    }
  }
  // Column prefix sums of skyness.
  const P = new Float32Array(W * (H + 1));
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y < H; y++) {
      P[x * (H + 1) + y] = s;
      s += sky[y * W + x];
    }
    P[x * (H + 1) + H] = s;
  }
  const K = Math.max(3, Math.round(0.04 * H));
  const Lw = Math.max(3, Math.round(0.04 * H));
  const colourStep = (x, b) => {
    // Colour difference across the boundary between rows b-1 and b (2 rows each side).
    if (b < 2 || b > H - 2) return 0;
    const m = (y0) => {
      const i0 = y0 * W + x;
      const i1 = i0 + W;
      return [(R[i0] + R[i1]) / 2, (G[i0] + G[i1]) / 2, (B[i0] + B[i1]) / 2];
    };
    const u = m(b - 2);
    const v = m(b);
    return Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
  };
  // cost(x, b): b = first land row (0 = no sky in this column, H = only sky).
  const cost = new Float32Array(W * (H + 1));
  const parts = new Float32Array(W * (H + 1) * 2); // sky above, land below (for the weights)
  for (let x = 0; x < W; x++) {
    const base = x * (H + 1);
    for (let b = 0; b <= H; b++) {
      let above = 0;
      let below = 0.3;
      let c;
      if (b > 0) {
        const a0 = Math.max(0, b - K);
        above = (P[base + b] - P[base + a0]) / (b - a0);
      }
      if (b < H) {
        const b1 = Math.min(H, b + Lw);
        below = 1 - (P[base + b1] - P[base + b]) / (b1 - b);
      }
      if (b === 0) c = 1.2 - 0.3 * below;
      else c = (1 - above) + (1 - below) - 0.5 * Math.min(1, colourStep(x, b) / 0.2);
      cost[base + b] = c;
      parts[2 * (base + b)] = above;
      parts[2 * (base + b) + 1] = b < H ? below : 0;
    }
  }
  // Dynamic programme across the columns, jumps cost lambda per row (steep flanks stay cheap).
  const lambda = 4 / H;
  const back = new Int16Array(W * (H + 1));
  let prev = cost.slice(0, H + 1);
  const m = new Float32Array(H + 1);
  const arg = new Int16Array(H + 1);
  for (let x = 1; x < W; x++) {
    m[0] = prev[0];
    arg[0] = 0;
    for (let b = 1; b <= H; b++) {
      if (prev[b] <= m[b - 1] + lambda) { m[b] = prev[b]; arg[b] = b; } else { m[b] = m[b - 1] + lambda; arg[b] = arg[b - 1]; }
    }
    for (let b = H - 1; b >= 0; b--) {
      if (m[b + 1] + lambda < m[b]) { m[b] = m[b + 1] + lambda; arg[b] = arg[b + 1]; }
    }
    const cur = new Float32Array(H + 1);
    const base = x * (H + 1);
    for (let b = 0; b <= H; b++) {
      cur[b] = m[b] + cost[base + b];
      back[base + b] = arg[b];
    }
    prev = cur;
  }
  let bEnd = 0;
  for (let b = 1; b <= H; b++) if (prev[b] < prev[bEnd]) bEnd = b;
  const rows = new Int32Array(W);
  rows[W - 1] = bEnd;
  for (let x = W - 1; x > 0; x--) rows[x - 1] = back[x * (H + 1) + rows[x]];
  // Usable columns: clear sky above, land below, not cut off by the top edge; sub-pixel edge position.
  const xs = [];
  const ys = [];
  const ws = [];
  for (let x = 0; x < W; x++) {
    const b = rows[x];
    if (b < Math.max(3, 0.01 * H) || b > H - 3) continue;
    const k = 2 * (x * (H + 1) + b);
    const above = parts[k];
    const below = parts[k + 1];
    const step = colourStep(x, b);
    const w = clamp((above - 0.5) / 0.4, 0, 1) * clamp((below - 0.45) / 0.4, 0, 1) * (0.5 + 0.5 * Math.min(1, step / 0.15));
    if (w < 0.15) continue;
    const d0 = step;
    const dm = colourStep(x, b - 1);
    const dp = colourStep(x, b + 1);
    const den = dm - 2 * d0 + dp;
    const off = den < -1e-6 ? clamp((0.5 * (dm - dp)) / den, -0.5, 0.5) : 0;
    xs.push(x + 0.5);
    ys.push(b + off);
    ws.push(w);
  }
  let skyPix = 0;
  for (let i = 0; i < N; i++) if (sky[i] > 0.5) skyPix++;
  return { width: W, height: H, count: xs.length, x: Float32Array.from(xs), y: Float32Array.from(ys), w: Float32Array.from(ws), skyPct: (100 * skyPix) / N };
}

// ---------- the background, before the place is known ----------

/**
 * What the photo's sky line says about the background without knowing the place: how much of the width has
 * a clear line (coverage 0–1), how far it rises and falls (reliefDeg, 5–95 % range), how jagged it is
 * (roughDeg, mean step between neighbouring columns) and where it lies (meanRow 0–1). null without a line.
 */
export function backgroundRelief(sky, fovDeg) {
  if (!sky || sky.count < 8) return null;
  const ppd = pxPerDeg(sky, fovDeg);
  const ys = Array.from(sky.y).sort((a, b) => a - b);
  const q = (p) => ys[Math.min(ys.length - 1, Math.floor(p * (ys.length - 1)))];
  let rough = 0;
  let n = 0;
  for (let i = 1; i < sky.count; i++) {
    if (sky.x[i] - sky.x[i - 1] > 1.5) continue;
    rough += Math.abs(sky.y[i] - sky.y[i - 1]);
    n += 1;
  }
  return {
    coverage: sky.count / sky.width,
    reliefDeg: (q(0.95) - q(0.05)) / ppd,
    roughDeg: n ? rough / n / ppd : 0,
    meanRow: ys.reduce((s, v) => s + v, 0) / ys.length / sky.height,
  };
}

/** A line of hills or mountains worth matching with the terrain: wide enough, with real rise and fall. */
export const reliefWorthMatching = (r) => Boolean(r && r.coverage >= 0.35 && r.reliefDeg >= 0.6 && r.meanRow < 0.8);

// ---------- matching ----------

/** Robust loss: quadratic for small residuals, logarithmic for outliers (foreground, clouds). */
const rho = (u) => Math.log1p((u * u) / 2);
/** Cost of a column whose direction has no terrain horizon (worse than any fitted column). */
const OUTSIDE = rho(5) + 2;

/**
 * Pixels (of the skyline image) per degree in the image centre. Residuals are compared in pixels, not
 * degrees: otherwise a tiny field of view would shrink every error and fit anything.
 */
export const pxPerDeg = (obs, fov) => (obs.width / 2 / Math.tan((clamp(fov, 1, 170) * DEG) / 2)) * DEG;

/**
 * Viewing direction (azimuth, elevation in degrees) of every skyline column for a pose. pose.k1 (optional)
 * is the lens's radial distortion: phones correct most of it, but far from the image centre a little
 * barrel (k1 < 0 in the photo) can remain.
 */
export function columnDirections(obs, pose) {
  const cam = makeCamera({ bearingDeg: pose.bearing, pitchDeg: pose.pitch, rollDeg: pose.roll, fovDeg: pose.fov, width: obs.width, height: obs.height });
  const az = new Float64Array(obs.count);
  const el = new Float64Array(obs.count);
  const k1 = pose.k1 || 0;
  const half = Math.hypot(obs.width, obs.height) / 2 / cam.fpx; // radius of the image corner, for scaling k1
  for (let k = 0; k < obs.count; k++) {
    let a = (obs.x[k] - obs.width / 2) / cam.fpx;
    let b = (obs.height / 2 - obs.y[k]) / cam.fpx;
    if (k1) {
      // Undo the distortion: the photo shows a point at radius r·(1 + k1·(r/corner)²).
      const s = 1 - k1 * ((a * a + b * b) / (half * half));
      a *= s;
      b *= s;
    }
    const dx = cam.f[0] + a * cam.r[0] + b * cam.u[0];
    const dy = cam.f[1] + a * cam.r[1] + b * cam.u[1];
    const dz = cam.f[2] + a * cam.r[2] + b * cam.u[2];
    az[k] = Math.atan2(dx, dy) / DEG;
    el[k] = Math.atan2(dz, Math.hypot(dx, dy)) / DEG;
  }
  return { az, el };
}

/** Residual per column (degrees, measured across the terrain skyline; NaN where the horizon is unknown). */
export function skylineResiduals(obs, h, pose) {
  const { az, el } = columnDirections(obs, pose);
  const r = new Float64Array(obs.count);
  for (let k = 0; k < obs.count; k++) {
    const hz = horizonAt(h, az[k]);
    r[k] = hz ? (el[k] - hz.el) / Math.sqrt(1 + hz.slope * hz.slope) : NaN;
  }
  return r;
}

/**
 * Typical height error of the free worldwide terrain model at ridges (m). It is mostly SRTM data; in
 * steep rock single crests can be off by 50–100 m.
 */
export const DEM_ERROR_M = 20;

/** Expected angular error (deg) of a terrain skyline point at distance d: the model error seen from there. */
const demSigmaDeg = (d, demErrM) => (demErrM > 0 && d > 0 ? Math.atan2(demErrM, d) / DEG : 0);

/**
 * Residual per column in units of its expected error (NaN where the horizon is unknown). Two parts: the
 * skyline in the photo (sigmaPx pixels) and the terrain model (demErrM metres at the ridge's distance, so
 * near ridges count less exactly than far ones). `pen` is the price of that wider tolerance – the
 * logarithm of the error in the likelihood – so aiming at a vague slope nearby cannot fit "anything".
 */
export function normalizedResiduals(obs, h, pose, sigmaPx, demErrM = DEM_ERROR_M) {
  const { az, el } = columnDirections(obs, pose);
  const sPx = sigmaPx / pxPerDeg(obs, pose.fov);
  const u = new Float64Array(obs.count);
  const dist = new Float64Array(obs.count);
  const pen = new Float64Array(obs.count);
  for (let k = 0; k < obs.count; k++) {
    const hz = horizonAt(h, az[k]);
    if (!hz) {
      u[k] = NaN;
      continue;
    }
    const sDem = demSigmaDeg(hz.dist, demErrM);
    u[k] = (el[k] - hz.el) / Math.sqrt(1 + hz.slope * hz.slope) / Math.hypot(sPx, sDem);
    pen[k] = Math.log(Math.hypot(1, sDem / sPx));
    dist[k] = hz.dist;
  }
  return { u, az, dist, pen };
}

/** Cost of one column: robust misfit plus the price of its tolerance. */
const columnCost = (u, pen) => (u === u ? rho(u) + pen : OUTSIDE);

/** Mean robust cost of a pose (lower is better); sigmaPx = expected error in pixels of the skyline image. */
export function poseCost(obs, h, pose, sigmaPx, demErrM = DEM_ERROR_M) {
  const { u, pen } = normalizedResiduals(obs, h, pose, sigmaPx, demErrM);
  let sum = 0;
  let wsum = 0;
  for (let k = 0; k < obs.count; k++) {
    sum += obs.w[k] * columnCost(u[k], pen[k]);
    wsum += obs.w[k];
  }
  return wsum ? sum / wsum : Infinity;
}

/**
 * About how many independent measurements the skyline holds: terrain-model errors are alike over a few
 * hundred metres of ridge, so near ridges give fewer independent pieces per degree than far ones.
 */
export function effectiveSamples(obs, h, pose, corrM = 400) {
  const { az } = columnDirections(obs, pose);
  const perColumn = pose.fov / obs.width;
  let n = 0;
  for (let k = 0; k < obs.count; k++) {
    const hz = horizonAt(h, az[k]);
    if (hz && hz.dist > 0) n += (perColumn * obs.w[k]) / Math.max(0.3, Math.atan2(corrM, hz.dist) / DEG);
  }
  return clamp(n, 3, 60);
}

function subsample(obs, max) {
  if (obs.count <= max) return obs;
  const step = obs.count / max;
  const pick = Array.from({ length: max }, (_, i) => Math.floor(i * step));
  return { ...obs, count: max, x: Float32Array.from(pick, (i) => obs.x[i]), y: Float32Array.from(pick, (i) => obs.y[i]), w: Float32Array.from(pick, (i) => obs.w[i]) };
}

/**
 * All-round (or sector) search for the orientation: for each field of view and tilt band, every bearing
 * in 0.5° steps; the tilt within the band is found from the most common vertical offset. Returns the best
 * distinct candidates { bearing, pitch, roll: 0, fov, cost } (bearings at least 3° apart).
 */
export function searchOrientation(obs, h, {
  bearingDeg = null, bearingRange = 180, fovDeg = null, fixFov = false, maxPitch = 30, sigmaPx = 3.5, demErrM = DEM_ERROR_M, keep = 6,
} = {}) {
  const o = subsample(obs, 180);
  const fovs = fixFov && fovDeg ? [fovDeg]
    : fovDeg ? [0.72, 0.8, 0.88, 0.95, 1, 1.06, 1.14, 1.24, 1.36].map((k) => clamp(fovDeg * k, 8, 120))
    : [22, 28, 34, 40, 47, 55, 63, 72, 82];
  const full = bearingDeg == null || bearingRange >= 180;
  const bStep = 0.5;
  const nb = full ? Math.round(360 / bStep) : 2 * Math.ceil(bearingRange / bStep) + 1;
  const b0 = full ? 0 : bearingDeg - Math.ceil(bearingRange / bStep) * bStep;
  const bestCost = new Float64Array(nb).fill(Infinity);
  const bestPose = new Array(nb);
  const bin = 0.05;
  const r = new Float64Array(o.count);
  const sc = new Float64Array(o.count);
  const sd = new Float64Array(o.count);
  let wsum = 0;
  for (let k = 0; k < o.count; k++) wsum += o.w[k];
  const hSpan = h.count * h.stepDeg;
  for (const fov of fovs) {
    const sigmaDeg = sigmaPx / pxPerDeg(o, fov);
    const span = 2 + 3 * sigmaDeg;
    const nbins = Math.ceil((2 * span) / bin) + 1;
    const hist = new Float64Array(nbins);
    const pre = new Float64Array(nbins + 1);
    const win = Math.max(1, Math.round(sigmaDeg / bin));
    for (let p0 = -maxPitch; p0 <= maxPitch + 1e-9; p0 += 4) {
      const { az: daz, el } = columnDirections(o, { bearing: 0, pitch: p0, roll: 0, fov });
      for (let bi = 0; bi < nb; bi++) {
        const beta = b0 + bi * bStep;
        hist.fill(0);
        for (let k = 0; k < o.count; k++) {
          // Inline horizonAt (this loop runs millions of times).
          const az = beta + daz[k];
          const rel = h.full ? wrap360(az - h.az0) : wrap180(az - h.az0 - hSpan / 2) + hSpan / 2;
          const f = rel / h.stepDeg;
          let i = Math.floor(f);
          r[k] = NaN;
          if (!h.full && (i < 0 || i >= h.count - 1)) continue;
          i %= h.count;
          const j = (i + 1) % h.count;
          const a = h.el[i];
          const c = h.el[j];
          if (!(a === a && c === c)) continue;
          const slope = (c - a) / h.stepDeg;
          r[k] = el[k] - (a + (c - a) * (f - Math.floor(f)));
          sc[k] = 1 / Math.sqrt(1 + slope * slope);
          sd[k] = demSigmaDeg(h.dist[i], demErrM);
          if (Math.abs(r[k]) < span) hist[Math.floor((r[k] + span) / bin)] += o.w[k] * sc[k];
        }
        // Most common vertical offset within the tilt band: that is where the lines lie on top of each other.
        for (let q = 0; q < nbins; q++) pre[q + 1] = pre[q] + hist[q];
        let bestQ = 0;
        let bestV = -1;
        const q0 = Math.floor((span - 2) / bin);
        const q1 = Math.ceil((span + 2) / bin);
        for (let q = q0; q <= q1; q++) {
          const v = pre[Math.min(nbins, q + win + 1)] - pre[Math.max(0, q - win)];
          if (v > bestV) { bestV = v; bestQ = q; }
        }
        const delta = (bestQ + 0.5) * bin - span;
        let sum = 0;
        for (let k = 0; k < o.count; k++) {
          sum += o.w[k] * (r[k] === r[k] ? rho(((r[k] - delta) * sc[k]) / Math.hypot(sigmaDeg, sd[k])) + Math.log(Math.hypot(1, sd[k] / sigmaDeg)) : OUTSIDE);
        }
        const cost = sum / wsum;
        if (cost < bestCost[bi]) {
          bestCost[bi] = cost;
          bestPose[bi] = { bearing: wrap360(beta), pitch: p0 - delta, roll: 0, fov, cost };
        }
      }
    }
  }
  // Distinct local minima over the bearings.
  const order = [...bestCost.keys()].filter((i) => Number.isFinite(bestCost[i])).sort((a, b) => bestCost[a] - bestCost[b]);
  const picked = [];
  for (const i of order) {
    const p = bestPose[i];
    if (picked.some((q) => Math.abs(wrap180(q.bearing - p.bearing)) < 3)) continue;
    picked.push(p);
    if (picked.length >= keep) break;
  }
  return picked;
}

/**
 * Refine a pose by least squares on the robust residuals (first with a wide, then with the final tolerance).
 * Roll is kept near level unless the skyline says otherwise; a field-of-view hint is a weak prior.
 */
export function refinePose(obs, h, start, {
  sigmaPx, demErrM = DEM_ERROR_M, fovHint = null, fixFov = false, rollSigma = 4, wide = true, iterations = 40,
} = {}) {
  const sw = Array.from(obs.w, (w) => Math.sqrt(w));
  const run = (sigPx, x0) => levenbergMarquardt((v) => {
    const pose = { bearing: v[0], pitch: v[1], roll: v[2], fov: fixFov ? start.fov : v[3] };
    if (pose.fov < 5 || pose.fov > 140) return new Array(2 * obs.count + 2).fill(1e3);
    const { u, pen } = normalizedResiduals(obs, h, pose, sigPx, demErrM);
    const out = new Array(2 * obs.count + 2);
    for (let k = 0; k < obs.count; k++) {
      // Squares sum to twice the column cost: robust misfit, smooth through zero, plus the tolerance price.
      out[2 * k] = sw[k] * psi(u[k]);
      out[2 * k + 1] = sw[k] * penTerm(u[k], pen[k]);
    }
    out[2 * obs.count] = v[2] / rollSigma;
    out[2 * obs.count + 1] = !fixFov && fovHint ? (v[3] - fovHint) / (0.3 * fovHint) : 0;
    return out;
  }, x0, { steps: [0.004, 0.004, 0.01, 0.01], iterations });
  let x = [start.bearing, start.pitch, start.roll ?? 0, start.fov];
  if (wide) x = run(Math.max(sigmaPx * 4, 3), x).x;
  x = run(sigmaPx, x).x;
  const pose = { bearing: wrap360(x[0]), pitch: x[1], roll: x[2], fov: fixFov ? start.fov : x[3] };
  return { ...pose, cost: poseCost(obs, h, pose, sigmaPx, demErrM) };
}

/** sign(u)·sqrt(2·rho(u)): least-squares residual whose square is the robust cost (NaN → outlier). */
export const psi = (u) => (u === u ? Math.sign(u) * Math.sqrt(2 * rho(u)) : Math.sqrt(2 * OUTSIDE));
/** The tolerance price as a least-squares residual (zero for a NaN column, whose psi already holds OUTSIDE). */
const penTerm = (u, pen) => (u === u ? Math.sqrt(2 * pen) : 0);

/**
 * Standard deviations of the fitted angles (degrees), from the curvature of the cost at the solution,
 * widened because neighbouring columns are not independent (nEff of obs.count are).
 */
export function poseUncertainty(obs, h, pose, { sigmaPx, demErrM = DEM_ERROR_M, fixFov = false, fovHint = null, rollSigma = 4, nEff = null } = {}) {
  const names = fixFov ? ["bearing", "pitch", "roll"] : ["bearing", "pitch", "roll", "fov"];
  const f = (v) => {
    const p = { bearing: v[0], pitch: v[1], roll: v[2], fov: fixFov ? pose.fov : v[3] };
    const { u } = normalizedResiduals(obs, h, p, sigmaPx, demErrM);
    const out = Array.from(u, (x, k) => Math.sqrt(obs.w[k]) * psi(x));
    out.push(v[2] / rollSigma);
    if (!fixFov && fovHint) out.push((v[3] - fovHint) / (0.3 * fovHint));
    return out;
  };
  const x0 = [pose.bearing, pose.pitch, pose.roll, pose.fov].slice(0, names.length);
  const r0 = f(x0);
  const J = x0.map((_, j) => {
    const xp = [...x0];
    xp[j] += 0.01;
    return f(xp).map((v, i) => (v - r0[i]) / 0.01);
  });
  const n = names.length;
  const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((sum, v, i) => sum + v * J[b][i], 0)));
  const inflate = Math.sqrt(obs.count / (nEff ?? effectiveSamples(obs, h, pose)));
  const out = {};
  names.forEach((name, j) => {
    const e = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    const col = solveLinear(JtJ, e);
    out[name] = col && col[j] > 0 ? Math.sqrt(col[j]) * inflate : null;
  });
  return out;
}

/**
 * The horizon made by 3D terrain points seen from (cx, cy) with the eye at absolute height eyeZ: per
 * azimuth bin the highest elevation angle along the lines through the points (upper envelope). pts are
 * [x, y, zAbs] in DEM grid metres, in order along lines; null separates lines.
 */
export function envelopeHorizon(pts, cx, cy, eyeZ, az0, count, step, minDistM = 0) {
  const el = new Float64Array(count).fill(-Infinity);
  const dist = new Float32Array(count);
  let prev = null;
  for (const p of pts) {
    if (!p) {
      prev = null;
      continue;
    }
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const d = Math.hypot(dx, dy);
    if (d < minDistM) {
      prev = null;
      continue;
    }
    const cur = { f: (wrap180(Math.atan2(dx, dy) / DEG - az0 - 180) + 180) / step, el: Math.atan((p[2] - eyeZ - dropAt(d)) / d) / DEG, d };
    // A jump means a gap in the line (or the far side of the circle).
    const a = prev && Math.abs(prev.f - cur.f) < 5 / step ? prev : cur;
    const lo = Math.max(0, Math.ceil(Math.min(a.f, cur.f)));
    const hi = Math.min(count - 1, Math.floor(Math.max(a.f, cur.f)));
    for (let b = lo; b <= hi; b++) {
      const t = cur.f === a.f ? 0 : (b - a.f) / (cur.f - a.f);
      const v = a.el + (cur.el - a.el) * t;
      if (v > el[b]) {
        el[b] = v;
        dist[b] = t < 0.5 ? a.d : cur.d;
      }
    }
    prev = cur;
  }
  for (let b = 0; b < count; b++) if (el[b] === -Infinity) el[b] = NaN;
  return { az0, stepDeg: step, count, full: false, el, dist };
}

/**
 * The fitted skyline as a constraint for other solvers (e.g. the resection from ground points): the
 * terrain skyline's ridge points are kept in 3D, so for a slightly different standpoint and eye height
 * their directions are recomputed and the photo's skyline columns compared again.
 * Returns { count, nEff, residuals(lat, lon, eyeZ, pose) → normalized residual per column,
 * terms(…) → the same as robust least-squares terms, together worth nEff independent measurements }.
 */
export function skylineConstraint({ dem, horizon, camera, obs, sigmaPx, demErrM = DEM_ERROR_M, nEff }) {
  const pts = [];
  for (let i = 0; i < horizon.count; i++) {
    const el = horizon.el[i];
    const d = horizon.dist[i];
    if (!(el === el) || !d) {
      pts.push(null);
      continue;
    }
    const a = (horizon.az0 + i * horizon.stepDeg) * DEG;
    pts.push([camera.e + d * Math.sin(a), camera.n + d * Math.cos(a), camera.eyeZ + d * Math.tan(el * DEG) + dropAt(d)]);
  }
  const pad = 3;
  const count = horizon.count + Math.round((2 * pad) / horizon.stepDeg);
  const az0 = horizon.az0 - pad;
  const reproject = (lat, lon, eyeZ) => {
    const [cx, cy] = dem.toLocal(lat, lon);
    return envelopeHorizon(pts, cx, cy, eyeZ, az0, count, horizon.stepDeg);
  };
  const full = (lat, lon, eyeZ, pose) => normalizedResiduals(obs, reproject(lat, lon, eyeZ), pose, sigmaPx, demErrM);
  return {
    count: obs.count,
    nEff,
    residuals: (lat, lon, eyeZ, pose) => full(lat, lon, eyeZ, pose).u,
    terms: (lat, lon, eyeZ, pose) => {
      const { u, pen } = full(lat, lon, eyeZ, pose);
      const w = Math.sqrt(nEff / Math.max(1, u.length));
      const out = [];
      for (let k = 0; k < u.length; k++) out.push(w * Math.sqrt(obs.w[k]) * psi(u[k]), w * Math.sqrt(obs.w[k]) * penTerm(u[k], pen[k]));
      return out;
    },
  };
}

/** Fit statistics: share of columns on the terrain skyline, their spread, the skyline's relief. */
export function fitStats(obs, h, pose, sigmaPx, demErrM = DEM_ERROR_M) {
  const r = skylineResiduals(obs, h, pose);
  const { az, dist } = normalizedResiduals(obs, h, pose, sigmaPx, demErrM);
  // "On the line": within 3 tolerances, the terrain-model part counted at most 0.25° (else near slopes pass anything).
  const sPx = sigmaPx / pxPerDeg(obs, pose.fov);
  const u = Array.from(r, (v, k) => v / Math.hypot(sPx, Math.min(0.25, demSigmaDeg(dist[k], demErrM))));
  let win = 0;
  let wall = 0;
  let ss = 0;
  let n = 0;
  const els = [];
  for (let k = 0; k < obs.count; k++) {
    wall += obs.w[k];
    const hz = horizonAt(h, az[k]);
    if (hz) els.push(hz.el);
    if (u[k] === u[k] && Math.abs(u[k]) < 3) {
      win += obs.w[k];
      ss += r[k] * r[k];
      n++;
    }
  }
  els.sort((a, b) => a - b);
  const relief = els.length ? els[Math.floor(els.length * 0.97)] - els[Math.floor(els.length * 0.03)] : 0;
  return {
    inlierShare: wall ? win / wall : 0, rmsDeg: n ? Math.sqrt(ss / n) : null, inliers: n, reliefDeg: relief, residuals: r,
    nEff: effectiveSamples(obs, h, pose),
  };
}

/** Azimuth range covered by the skyline columns for a pose, widened by `pad` degrees. */
export function columnSector(obs, pose, pad = 3) {
  const { az } = columnDirections(obs, { ...pose, pitch: pose.pitch });
  let lo = Infinity;
  let hi = -Infinity;
  const ref = pose.bearing;
  for (const a of az) {
    const d = wrap180(a - ref);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  // The photo's own edges too, in case the skyline only shows up in part of it.
  const half = pose.fov / 2 + Math.abs(pose.roll) * 0.2;
  lo = Math.min(lo, -half);
  hi = Math.max(hi, half);
  return { center: wrap360(ref + (lo + hi) / 2), half: (hi - lo) / 2 + pad };
}

/** Extra degrees on each side of the viewing sector when the camera may move by radiusM (far peaks shift by that much). */
export const shiftPad = (radiusM) => 2 + Math.asin(Math.min(1, radiusM / 5000)) / DEG;

/**
 * Search the standpoint within radiusM of the grid centre (and optionally the eye height): at every
 * trial position the horizon is traced anew and the orientation refitted. A coarse grid first, then a
 * shrinking pattern search. The assumed standpoint is kept unless another one fits clearly better
 * (terrain-model errors alone can make a wrong place look slightly better). Returns the chosen position,
 * `consistent` (assumed standpoint kept), the best other position and the uncertainty: how far
 * positions reach that fit about as well (a rough 90 % region).
 */
export function searchPosition(dem, obs, pose, {
  radiusM, eyeHeight = 1.6, solveHeight = false, sigmaPx, demErrM = DEM_ERROR_M, fovHint = null, fixFov = false, stepDeg = 0.05,
  maxDistM = 200000, minStepM = 8, start = [0, 0],
} = {}) {
  const sector = columnSector(obs, pose, shiftPad(radiusM));
  const az0 = sector.center - sector.half;
  const count = Math.ceil((2 * sector.half) / stepDeg) + 1;
  const evals = [];
  let current = pose;
  const evaluate = (e, n, hEye) => {
    const ground = dem.height(e, n);
    if (!(ground === ground)) return null;
    const h = traceHorizon(dem, { e, n, eyeZ: ground + hEye, az0, count, stepDeg, maxDistM });
    const p = refinePose(obs, h, current, { sigmaPx, demErrM, fovHint, fixFov, wide: false, iterations: 12 });
    const res = { e, n, hEye, ground, pose: p, cost: p.cost, h };
    evals.push(res);
    return res;
  };
  let best = evaluate(start[0], start[1], eyeHeight);
  if (!best) return null;
  const assumed = best;
  const g = radiusM / 2;
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      if ((!i && !j) || Math.hypot(i, j) > 2.3) continue;
      const c = evaluate(start[0] + i * g, start[1] + j * g, eyeHeight);
      if (c && c.cost < best.cost) best = c;
    }
  }
  current = best.pose;
  let step = g / 2;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (step >= minStepM) {
    let improved = false;
    const trials = dirs.map(([a, b]) => [best.e + a * step, best.n + b * step, best.hEye]);
    if (solveHeight) {
      const dh = Math.max(1, step / 4);
      trials.push([best.e, best.n, best.hEye + dh]);
      if (best.hEye - dh >= 0.3) trials.push([best.e, best.n, best.hEye - dh]);
    }
    for (const [e, n, hh] of trials) {
      if (Math.hypot(e - start[0], n - start[1]) > radiusM * 1.25) continue;
      const c = evaluate(e, n, hh);
      if (c && c.cost < best.cost - 1e-9) {
        best = c;
        improved = true;
      }
    }
    current = best.pose;
    if (!improved) step /= 2;
  }
  // Positions that fit about as well: cost within the 90 % bound for two unknowns (chi² 4.6 over the
  // independent pieces of skyline).
  const nEff = effectiveSamples(obs, best.h, best.pose);
  const tol = 2.3 / nEff;
  const consistent = assumed.cost <= best.cost + tol;
  const chosen = consistent ? assumed : best;
  let reach = minStepM * 2;
  for (const c of evals) if (c.cost <= best.cost + tol) reach = Math.max(reach, Math.hypot(c.e - chosen.e, c.n - chosen.n));
  const { h: _h, ...out } = chosen;
  return {
    ...out, consistent, uncertaintyM: reach, evaluations: evals.length, nEff, costTolerance: tol, assumedCost: assumed.cost,
    best: { e: best.e, n: best.n, hEye: best.hEye, cost: best.cost, pose: best.pose },
  };
}

// ---------- peaks ----------

/** Overpass query for named peaks inside a polygon ([[lat, lon], …]). */
export function overpassPeakQuery(polygon) {
  const poly = polygon.map(([la, lo]) => `${la.toFixed(5)} ${lo.toFixed(5)}`).join(" ");
  return `[out:json][timeout:25];node["natural"~"^(peak|volcano|hill)$"]["name"](poly:"${poly}");out qt 3000;`;
}

export function parseOsmPeaks(data) {
  const out = [];
  for (const el of data?.elements || []) {
    const t = el.tags || {};
    if (el.type !== "node" || !t.name || !Number.isFinite(el.lat)) continue;
    const ele = parseLength(t.ele);
    out.push({ name: t["name:de"] || t.name, lat: el.lat, lon: el.lon, ele: ele != null && ele > -500 && ele < 9000 ? ele : null, kind: t.natural, source: "OSM" });
  }
  return out;
}

/** Wikidata (SPARQL) query for mountains and summits in a bounding box – the fallback when Overpass is busy. */
export function wikidataPeakQuery(south, west, north, east) {
  return `SELECT ?item ?itemLabel ?coord ?ele WHERE {
  SERVICE wikibase:box { ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west.toFixed(4)} ${south.toFixed(4)})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east.toFixed(4)} ${north.toFixed(4)})"^^geo:wktLiteral . }
  VALUES ?cls { wd:Q8502 wd:Q207326 }
  ?item wdt:P31/wdt:P279* ?cls .
  OPTIONAL { ?item p:P2044/psn:P2044/wikibase:quantityAmount ?ele }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en,fr,it,es,rm". }
} LIMIT 4000`;
}

export function parseWikidataPeaks(json) {
  const out = [];
  for (const b of json?.results?.bindings || []) {
    const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(b.coord?.value || "");
    const name = b.itemLabel?.value || "";
    if (!m || !name || /^Q\d+$/.test(name)) continue;
    const ele = b.ele ? parseFloat(b.ele.value) : null;
    out.push({ name, lat: parseFloat(m[2]), lon: parseFloat(m[1]), ele: Number.isFinite(ele) && ele > -500 && ele < 9000 ? ele : null, kind: "peak", source: "Wikidata" });
  }
  return out;
}

/** One entry per summit: same name within 1.5 km (or any two within 60 m) count as one; OSM first. */
export function mergePeaks(...lists) {
  const out = [];
  for (const p of lists.flat()) {
    const dup = out.find((q) => {
      const d = geoInverse(p.lat, p.lon, q.lat, q.lon).distance;
      return d < 60 || (d < 1500 && q.name.toLowerCase() === p.name.toLowerCase());
    });
    if (!dup) out.push({ ...p });
    else if (dup.ele == null && p.ele != null) dup.ele = p.ele;
  }
  return out;
}

/** The sector the camera looks into, as a polygon for the Overpass query. */
export function sectorPolygon(lat, lon, sector, maxDistM) {
  const pts = [[lat, lon]];
  const a0 = sector.center - sector.half;
  const steps = Math.max(2, Math.ceil((2 * sector.half) / 5));
  for (let i = 0; i <= steps; i++) pts.push(geoDirect(lat, lon, wrap360(a0 + (2 * sector.half * i) / steps), maxDistM));
  return pts;
}

/** Highest sight-line tangent between the camera and distance `to` along an azimuth. */
function blockingTan(dem, e, n, eyeZ, azDeg, to) {
  const dx = Math.sin(azDeg * DEG);
  const dy = Math.cos(azDeg * DEG);
  let best = -Infinity;
  for (let s = 60; s < to;) {
    const x = e + dx * s;
    const y = n + dy * s;
    const L = dem.levels[dem.levelAt(x, y)];
    const z = dem.height(x, y);
    if (z === z) best = Math.max(best, (z - eyeZ - dropAt(s)) / s);
    s += Math.max(L.step * 0.6, s * 0.004);
  }
  return best;
}

/**
 * Which peaks the camera sees and where they are in the photo. camera: { e, n, eyeZ } on the DEM grid,
 * pose as fitted, width/height of the photo. Returns entries sorted left to right with photo
 * coordinates (0–1), distance, bearing, elevation angle and whether the peak is on the skyline.
 */
export function peaksInView(dem, peaks, camera, pose, { width, height, horizon = null, minDistM = 250, maxDistM = 220000 }) {
  const cam = makeCamera({ bearingDeg: pose.bearing, pitchDeg: pose.pitch, rollDeg: pose.roll, fovDeg: pose.fov, width, height });
  const out = [];
  for (const p of peaks) {
    const [pe, pn] = dem.toLocal(p.lat, p.lon);
    const dx = pe - camera.e;
    const dy = pn - camera.n;
    const s = Math.hypot(dx, dy);
    if (s < minDistM || s > maxDistM) continue;
    const az = wrap360(Math.atan2(dx, dy) / DEG);
    if (Math.abs(wrap180(az - pose.bearing)) > 90) continue;
    const demTop = dem.peakHeight(pe, pn, Math.max(30, s * 0.002));
    const z = p.ele ?? demTop;
    if (!(z === z)) continue;
    const t = (z - camera.eyeZ - dropAt(s)) / s;
    const elev = Math.atan(t) / DEG;
    const c = cam.toCam([Math.sin(az * DEG) * Math.cos(elev * DEG), Math.cos(az * DEG) * Math.cos(elev * DEG), Math.sin(elev * DEG)]);
    if (c[2] <= 0) continue;
    const [px, py] = cam.project(c);
    if (px < -0.02 * width || px > 1.02 * width || py < -0.02 * height || py > 1.02 * height) continue;
    // Hidden behind nearer terrain? (a few tens of metres of slack for DEM smoothing)
    const block = blockingTan(dem, camera.e, camera.n, camera.eyeZ, az, s - Math.max(90, 0.02 * s));
    if (t + (25 + 0.002 * s) / s < block) continue;
    const hz = horizon ? horizonAt(horizon, az) : null;
    out.push({
      name: p.name, ele_m: p.ele != null ? Math.round(p.ele) : Math.round(z), ele_from_dem: p.ele == null, source: p.source, lat: p.lat, lon: p.lon,
      // On the skyline: within ~40 m of the horizon at that distance (the model rounds summits off).
      distance_m: s, bearing_deg: az, elevation_deg: elev, x: px / width, y: py / height,
      on_skyline: hz ? elev >= hz.el - Math.max(0.15, Math.atan2(40, s) / DEG) : false,
    });
  }
  return out.sort((a, b) => a.x - b.x);
}

/**
 * Summits the terrain model shows on the skyline (for peaks without a name in the databases): local
 * maxima of the horizon standing out by at least minPromDeg against both sides within ±windowDeg.
 */
export function skylineSummits(h, { from, to, minPromDeg = 0.3, windowDeg = 2 }) {
  const out = [];
  const w = Math.max(1, Math.round(windowDeg / h.stepDeg));
  const i0 = Math.max(0, Math.ceil(wrap180(from - h.az0) / h.stepDeg));
  const i1 = Math.min(h.count - 1, Math.floor((wrap180(to - h.az0 - 180) + 180) / h.stepDeg));
  for (let i = Math.max(i0, 1); i < Math.min(i1, h.count - 1); i++) {
    const v = h.el[i];
    if (!(v === v) || !(v >= h.el[i - 1] && v > h.el[i + 1])) continue;
    let lowL = v;
    let lowR = v;
    let top = true;
    for (let k = 1; k <= w && top; k++) {
      if (i - k >= 0 && h.el[i - k] > v) top = false;
      if (i + k < h.count && h.el[i + k] > v) top = false;
      if (i - k >= 0 && h.el[i - k] < lowL) lowL = h.el[i - k];
      if (i + k < h.count && h.el[i + k] < lowR) lowR = h.el[i + k];
    }
    if (top && v - lowL >= minPromDeg && v - lowR >= minPromDeg) out.push({ az: wrap360(h.az0 + i * h.stepDeg), el: v, dist: h.dist[i] });
  }
  return out;
}

/** Chain the ridge crests of neighbouring azimuths into lines (for drawing). Returns [[{az, el, d}…]…]. */
export function ridgeLines(h, minLength = 6) {
  if (!h.crests) return [];
  const done = [];
  let open = [];
  for (let i = 0; i < h.count; i++) {
    const az = h.az0 + i * h.stepDeg;
    const next = [];
    for (const c of h.crests[i] || []) {
      const line = open.find((l) => {
        const last = l.at(-1);
        return !next.includes(l) && Math.abs(last.d - c.d) < Math.max(80, 0.12 * c.d) && Math.abs(last.el - c.el) < 0.6;
      });
      const pt = { az, el: c.el, d: c.d };
      if (line) {
        line.push(pt);
        next.push(line);
      } else {
        next.push([pt]);
      }
    }
    done.push(...open.filter((l) => !next.includes(l)));
    open = next;
  }
  done.push(...open);
  return done.filter((l) => l.length >= minLength);
}

/**
 * Exact ridge heights (in Switzerland from swisstopo's 2 m model): the terrain skyline and the longest ridge
 * lines in front of it, sampled on the model's crest and `offsets` metres in front of and behind it – the
 * worldwide model's crests can sit a little off. All lines go as one polyline per offset (the stretches
 * between them are real terrain, too). profile(line [[lat, lon]…], nbPoints) → [{ lat, lon, h }].
 * Returns { points: [[x, y, zAbs] | null …] on the DEM grid for envelopeHorizon, minDistM, samples }.
 */
export async function ridgePointsFromProfiles({ dem, horizon, camera, profile, offsets = [-40, 0, 40], maxLines = 6, vertexM = 25, spacingM = 6 }) {
  const lines = [];
  let cur = [];
  for (let i = 0; i < horizon.count; i++) {
    const d = horizon.dist[i];
    if (!(horizon.el[i] === horizon.el[i]) || !d) {
      if (cur.length > 1) lines.push(cur);
      cur = [];
      continue;
    }
    cur.push({ az: horizon.az0 + i * horizon.stepDeg, d });
  }
  if (cur.length > 1) lines.push(cur);
  lines.push(...ridgeLines(horizon, 8).sort((a, b) => b.length - a.length).slice(0, maxLines));
  if (!lines.length) return { points: [], minDistM: 0, samples: 0 };
  const minDistM = 0.7 * Math.min(...lines.flat().map((p) => p.d));
  const at = (p, off) => [camera.e + (p.d + off) * Math.sin(p.az * DEG), camera.n + (p.d + off) * Math.cos(p.az * DEG)];
  const points = [];
  let samples = 0;
  for (const off of offsets) {
    // Vertices at least vertexM apart (the service samples evenly along the whole line anyway).
    const verts = [];
    for (const line of lines) {
      for (const p of line) {
        const xy = at(p, off);
        const last = verts.at(-1);
        if (!last || Math.hypot(xy[0] - last[0], xy[1] - last[1]) >= vertexM) verts.push(xy);
      }
    }
    let length = 0;
    for (let i = 1; i < verts.length; i++) length += Math.hypot(verts[i][0] - verts[i - 1][0], verts[i][1] - verts[i - 1][1]);
    const got = await profile(verts.map(([x, y]) => dem.toLatLon(x, y)), Math.min(5000, Math.max(50, length / spacingM)));
    for (const q of got) {
      const [x, y] = dem.toLocal(q.lat, q.lon);
      points.push([x, y, q.h]);
    }
    points.push(null);
    samples += got.length;
  }
  return { points, minDistM, samples };
}

/** A horizon with the exact ridge heights where they exist, the model's elsewhere. */
export function mergeHorizon(model, exact) {
  const el = Float64Array.from(model.el, (v, i) => (exact.el[i] === exact.el[i] ? exact.el[i] : v));
  const dist = Float32Array.from(model.dist, (v, i) => (exact.el[i] === exact.el[i] ? exact.dist[i] : v));
  return { ...model, el, dist };
}

/** Direction (azimuth, elevation) → photo position (0–1) for a pose, or null behind the camera. */
export function projectDirection(pose, width, height, azDeg, elDeg) {
  const cam = makeCamera({ bearingDeg: pose.bearing, pitchDeg: pose.pitch, rollDeg: pose.roll, fovDeg: pose.fov, width, height });
  const c = cam.toCam([Math.sin(azDeg * DEG) * Math.cos(elDeg * DEG), Math.cos(azDeg * DEG) * Math.cos(elDeg * DEG), Math.sin(elDeg * DEG)]);
  if (c[2] <= 0) return null;
  const [x, y] = cam.project(c);
  return [x / width, y / height];
}

/** The terrain skyline and ridge lines as polylines in photo coordinates (0–1), split where they leave the frame. */
export function overlayLines(h, pose, width, height) {
  const cam = makeCamera({ bearingDeg: pose.bearing, pitchDeg: pose.pitch, rollDeg: pose.roll, fovDeg: pose.fov, width, height });
  const proj = (az, el) => {
    const c = cam.toCam([Math.sin(az * DEG) * Math.cos(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG)]);
    if (c[2] <= 0) return null;
    const [x, y] = cam.project(c);
    return x >= -2 && x <= width + 2 && y >= -2 && y <= height + 2 ? [x / width, y / height] : null;
  };
  const split = (pts) => {
    const lines = [];
    let cur = [];
    for (const p of pts) {
      if (p) cur.push(p);
      else if (cur.length) { lines.push(cur); cur = []; }
    }
    if (cur.length) lines.push(cur);
    return lines.filter((l) => l.length > 1);
  };
  const skyline = split(Array.from({ length: h.count }, (_, i) => (h.el[i] === h.el[i] ? proj(h.az0 + i * h.stepDeg, h.el[i]) : null)));
  const ridges = ridgeLines(h).flatMap((line) => split(line.map((p) => proj(p.az, p.el))));
  return { skyline, ridges };
}

/**
 * How sure is the match? The product of how uniquely this orientation beats the best alternative and
 * the weakest of: share of skyline columns on the terrain line, relief of the skyline, share of the
 * width with a clear skyline. Returns { confidence (0–1), limit (what limits it) }.
 */
export function matchConfidence({ bestCost, secondCost, inlierShare, reliefDeg, coverage, nEff }) {
  const unique = secondCost == null ? 1 : 1 - Math.exp(-nEff * Math.max(0, secondCost - bestCost));
  const factors = {
    fit: clamp((inlierShare - 0.3) / 0.4, 0, 1),
    relief: clamp(reliefDeg / 1.5, 0, 1),
    coverage: clamp(coverage / 0.3, 0, 1),
  };
  const [limit, q] = Object.entries(factors).sort((a, b) => a[1] - b[1])[0];
  const confidence = q * unique;
  return { confidence, limit: unique < q ? "unique" : limit, factors: { ...factors, unique } };
}

// ---------- browser ----------

/** Photo pixels scaled to at most maxW × maxH (for finding the skyline). */
function photoPixels(bitmap, maxW = 800, maxH = 1400) {
  const bw = bitmap.naturalWidth || bitmap.width;
  const bh = bitmap.naturalHeight || bitmap.height;
  const scale = Math.min(1, maxW / bw, maxH / bh);
  const W = Math.max(8, Math.round(bw * scale));
  const H = Math.max(8, Math.round(bh * scale));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, W, H);
  return { width: W, height: H, data: ctx.getImageData(0, 0, W, H).data };
}

const skylineCache = new WeakMap();

/** The photo's skyline (cached per image). */
export function photoSkyline(bitmap) {
  if (!skylineCache.has(bitmap)) skylineCache.set(bitmap, extractSkyline(photoPixels(bitmap)));
  return skylineCache.get(bitmap);
}

async function loadTiles(terrain, keys, concurrency = 8) {
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const [z, x, y] = keys[next++].split("/").map(Number);
      await terrain.ensure(z, x, y);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
}

/** Browser: load the tiles for a LocalDem and build it. */
export async function buildDem(terrain, { lat, lon, levels, sector, shiftM, maxDistM }) {
  const plan = demTiles({ lat, lon, levels, sector, shiftM, maxDistM });
  await loadTiles(terrain, plan.keys);
  return new LocalDem({ lat, lon, levels: plan.levels, sector, shiftM, maxDistM, elevation: (la, lo, z) => terrain.elevation(la, lo, z) });
}

/** Named peaks in the sector: OpenStreetMap (Overpass) first, Wikidata when Overpass does not answer. */
export async function loadPeaks({ osm, fetchImpl = globalThis.fetch?.bind(globalThis), lat, lon, sector, maxDistM }) {
  const poly = sectorPolygon(lat, lon, sector, maxDistM);
  const problems = [];
  if (osm) {
    try {
      return { peaks: parseOsmPeaks(await osm.overpassRaw(overpassPeakQuery(poly))), source: "OpenStreetMap" };
    } catch (err) {
      problems.push(`OpenStreetMap: ${err.message}`);
    }
  }
  if (fetchImpl) {
    try {
      const lats = poly.map((p) => p[0]);
      const lons = poly.map((p) => p[1]);
      const q = wikidataPeakQuery(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons));
      const resp = await fetchImpl(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { Accept: "application/sparql-results+json" }, signal: timeoutSignal(25000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { peaks: parseWikidataPeaks(await resp.json()), source: "Wikidata", note: problems.join(" ") };
    } catch (err) {
      problems.push(`Wikidata: ${err.message}`);
    }
  }
  return { peaks: [], source: null, note: `Gipfelnamen nicht abrufbar (${problems.join("; ")}) – nur Gipfel aus dem Geländemodell.` };
}

/**
 * Browser: the whole match. Finds the skyline in the photo, searches the orientation (all round unless a
 * rough bearing is given), refines it on a fine terrain grid, optionally searches the standpoint within
 * searchRadiusM, and names the visible peaks. onStatus(text) reports progress.
 */
export async function skylineMatch({
  bitmap, terrain, osm = null, fetchImpl, lat, lon, eyeHeight = 1.6, bearingDeg = null, bearingRange = 45, fovDeg = null, fixFov = false,
  searchRadiusM = 0, solveHeight = false, maxDistM = 200000, onStatus = () => {},
}) {
  const t0 = Date.now();
  const obs = photoSkyline(bitmap);
  const photoW = bitmap.naturalWidth || bitmap.width;
  const photoH = bitmap.naturalHeight || bitmap.height;
  if (obs.count < Math.max(12, 0.08 * obs.width)) {
    return { ok: false, note: "Im Foto ist kein klarer Übergang Himmel → Berg/Land zu finden (zu wenig Himmel, Wolken oder Dunst). skyline_match hilft hier nicht." };
  }
  const coverage = obs.count / obs.width;
  const degPx = (fovDeg || 60) / obs.width;
  // Expected skyline error in pixels of the skyline image: on the coarse grid, and on the fine one.
  const sigmaCoarse = 2.5;
  const sigmaFine = 1.2;
  // In Switzerland the exact ground height at the standpoint (the worldwide model is often metres off).
  await learnSwissHeights(terrain, fetchImpl, [{ lat, lon }]).catch(() => 0);
  // 1) Orientation on a coarse grid (all round when the direction is unknown).
  onStatus("Bergkamm: Geländemodell rundum laden …");
  const fovMax = fixFov && fovDeg ? fovDeg : fovDeg ? fovDeg * 1.4 : 85;
  const full = bearingDeg == null || bearingRange >= 150;
  const coarseSector = full ? null : { center: bearingDeg, half: bearingRange + fovMax / 2 + 4 };
  const coarse = await buildDem(terrain, { lat, lon, levels: DEM_COARSE, sector: coarseSector, shiftM: 0, maxDistM });
  const ground0 = coarse.height(0, 0);
  if (!(ground0 === ground0)) throw new Error("Geländemodell am Standpunkt nicht verfügbar");
  const hc = traceHorizon(coarse, {
    eyeZ: ground0 + eyeHeight, az0: full ? 0 : coarseSector.center - coarseSector.half, stepDeg: 0.1,
    count: full ? 3600 : Math.ceil((2 * coarseSector.half) / 0.1) + 1, maxDistM,
  });
  onStatus("Bergkamm: Blickrichtung suchen …");
  const cands = searchOrientation(obs, hc, { bearingDeg: full ? null : bearingDeg, bearingRange, fovDeg, fixFov });
  if (!cands.length) return { ok: false, note: "Kein passender Horizont gefunden (Geländemodell leer?)." };
  // Candidates are ranked with the expected field of view: the cost is per column, so the prior's share
  // is spread over the skyline's independent pieces – else a far-off field of view can fit a little better
  // by chance (e.g. an ultra-wide view steeply down instead of the phone's normal one).
  const score = (p) => {
    const z = !fixFov && fovDeg ? (p.fov - fovDeg) / (0.3 * fovDeg) : 0;
    return poseCost(obs, hc, p, sigmaCoarse) + (z ? (0.5 * z * z) / effectiveSamples(obs, hc, p) : 0);
  };
  const refined = cands.slice(0, 5).map((c) => refinePose(obs, hc, c, { sigmaPx: sigmaCoarse, fovHint: fovDeg, fixFov }))
    .map((p) => ({ p, s: score(p) })).sort((a, b) => a.s - b.s).map(({ p }) => p);
  let pose = refined[0];
  // The best clearly different orientation (refined, or as found by the search when all refined to the same).
  const bestCoarse = score(pose);
  let rival = null;
  let secondCoarse = null;
  for (const p of [...refined, ...cands]) {
    if (Math.abs(wrap180(p.bearing - pose.bearing)) <= Math.max(3, pose.fov / 5)) continue;
    const c = score(p);
    if (secondCoarse == null || c < secondCoarse) {
      secondCoarse = c;
      rival = p;
    }
  }

  // 2) Fine grid for the viewing sector; range only as far as the skyline reaches.
  let sector = columnSector(obs, pose, shiftPad(searchRadiusM) + 1);
  let farthest = 0;
  for (let a = -sector.half; a <= sector.half; a += 0.2) {
    const hz = horizonAt(hc, sector.center + a);
    if (hz) farthest = Math.max(farthest, hz.dist);
  }
  const fineMax = Math.min(maxDistM, farthest * 1.3 + 3000 + searchRadiusM);
  onStatus("Bergkamm: feines Geländemodell für den Blickwinkel laden …");
  let dem = await buildDem(terrain, { lat, lon, levels: DEM_FINE, sector, shiftM: searchRadiusM, maxDistM: fineMax });
  const stepDeg = clamp(degPx / 2, 0.02, 0.05);
  const sectorHorizon = (d, e, n, eyeZ, ridges = false) => traceHorizon(d, {
    e, n, eyeZ, az0: sector.center - sector.half, count: Math.ceil((2 * sector.half) / stepDeg) + 1, stepDeg, maxDistM: fineMax, ridges,
  });
  let cam = { e: 0, n: 0, hEye: eyeHeight, ground: dem.height(0, 0) };
  let hf = sectorHorizon(dem, 0, 0, cam.ground + eyeHeight);
  pose = refinePose(obs, hf, pose, { sigmaPx: sigmaFine, fovHint: fovDeg, fixFov });

  // 3) Standpoint search (near ridges move against far ones).
  let position = null;
  if (searchRadiusM > 0) {
    onStatus(`Bergkamm: Standpunkt im Umkreis von ${Math.round(searchRadiusM)} m prüfen …`);
    position = searchPosition(dem, obs, pose, { radiusM: searchRadiusM, eyeHeight, solveHeight, sigmaPx: sigmaFine, fovHint: fovDeg, fixFov, stepDeg, maxDistM: fineMax });
    if (position) {
      const moved = Math.hypot(position.e, position.n);
      if (!position.consistent && moved > 400) {
        // Far from the start: new fine grid around the new standpoint, then a small final search.
        const center = dem.toLatLon(position.e, position.n);
        onStatus("Bergkamm: Geländemodell um den neuen Standpunkt laden …");
        sector = columnSector(obs, position.pose, shiftPad(300) + 1);
        dem = await buildDem(terrain, { lat: center[0], lon: center[1], levels: DEM_FINE, sector, shiftM: 300, maxDistM: fineMax });
        const again = searchPosition(dem, obs, position.pose, { radiusM: 300, eyeHeight: position.hEye, solveHeight, sigmaPx: sigmaFine, fovHint: fovDeg, fixFov, stepDeg, maxDistM: fineMax });
        if (again) {
          const [bla, blo] = dem.toLatLon(again.best.e, again.best.n);
          position = { ...again, consistent: false, bestLatLon: [bla, blo], uncertaintyM: Math.max(again.uncertaintyM, position.uncertaintyM * 0.5), evaluations: again.evaluations + position.evaluations };
        }
      } else {
        position.bestLatLon = dem.toLatLon(position.best.e, position.best.n);
      }
      cam = { e: position.e, n: position.n, hEye: position.hEye, ground: position.ground };
      pose = refinePose(obs, sectorHorizon(dem, cam.e, cam.n, cam.ground + cam.hEye), position.pose, { sigmaPx: sigmaFine, fovHint: fovDeg, fixFov, wide: false });
    }
  }
  const eyeZ = cam.ground + cam.hEye;
  hf = sectorHorizon(dem, cam.e, cam.n, eyeZ, true);
  const stats = fitStats(obs, hf, pose, sigmaFine);
  const sd = poseUncertainty(obs, hf, pose, { sigmaPx: sigmaFine, fixFov, fovHint: fovDeg, nEff: stats.nEff });
  const { confidence, limit, factors } = matchConfidence({
    bestCost: bestCoarse, secondCost: secondCoarse, inlierShare: stats.inlierShare, reliefDeg: stats.reliefDeg, coverage, nEff: stats.nEff,
  });
  const [camLat, camLon] = dem.toLatLon(cam.e, cam.n);
  const shift = geoInverse(lat, lon, camLat, camLon);

  // 4) Peaks: names from OSM/Wikidata, plus summits the terrain model shows on the skyline.
  onStatus("Bergkamm: Gipfel benennen …");
  let skyFar = 0;
  const dists = [];
  for (let i = 0; i < hf.count; i++) if (hf.dist[i]) { skyFar = Math.max(skyFar, hf.dist[i]); dists.push(hf.dist[i]); }
  dists.sort((a, b) => a - b);
  const loaded = await loadPeaks({ osm, fetchImpl, lat: camLat, lon: camLon, sector, maxDistM: Math.min(fineMax, skyFar * 1.1 + 2000) });
  const camera = { e: cam.e, n: cam.n, eyeZ };
  let peaks = peaksInView(dem, loaded.peaks, camera, pose, { width: photoW, height: photoH, horizon: hf, maxDistM: fineMax });
  for (const s of skylineSummits(hf, { from: sector.center - sector.half, to: sector.center + sector.half, minPromDeg: Math.max(0.3, 4 * degPx) })) {
    if (peaks.some((p) => Math.abs(wrap180(p.bearing_deg - s.az)) < 0.8 && Math.abs(p.distance_m - s.dist) < 0.25 * s.dist)) continue;
    const xy = projectDirection(pose, photoW, photoH, s.az, s.el);
    if (!xy || xy[0] < 0 || xy[0] > 1 || xy[1] < 0 || xy[1] > 1) continue;
    const [pe, pn] = [cam.e + Math.sin(s.az * DEG) * s.dist, cam.n + Math.cos(s.az * DEG) * s.dist];
    const [pla, plo] = dem.toLatLon(pe, pn);
    peaks.push({
      name: "", ele_m: Math.round(dem.peakHeight(pe, pn, 40)), ele_from_dem: true, source: "Gelände", lat: pla, lon: plo,
      distance_m: s.dist, bearing_deg: s.az, elevation_deg: s.el, x: xy[0], y: xy[1], on_skyline: true,
    });
  }
  peaks = peaks.sort((a, b) => a.x - b.x);
  const lines = overlayLines(hf, pose, photoW, photoH);
  return {
    ok: true,
    pose,
    camera: {
      lat: camLat, lon: camLon, eye_height_m: cam.hEye, ground_m: cam.ground, moved_m: shift.distance,
      east_m: shift.distance * Math.sin(shift.azimuth * DEG), north_m: shift.distance * Math.cos(shift.azimuth * DEG),
      uncertainty_m: position ? position.uncertaintyM : null, searched_m: searchRadiusM,
      // Searched but kept: the assumed standpoint fits as well as any other within the uncertainty.
      consistent: position ? position.consistent : null,
      best_fit: position && Math.hypot(position.best.e - position.e, position.best.n - position.n) > 20
        ? { lat: position.bestLatLon[0], lon: position.bestLatLon[1], distance_m: geoInverse(camLat, camLon, ...position.bestLatLon).distance } : null,
    },
    fit: {
      inlier_share: stats.inlierShare, rms_deg: stats.rmsDeg, rms_px: stats.rmsDeg == null ? null : (stats.rmsDeg / pose.fov) * photoW,
      coverage, relief_deg: stats.reliefDeg, sigma_px: sigmaFine, columns: obs.count, independent: stats.nEff,
    },
    confidence, limit, factors, sd,
    alternative: rival ? { bearing_deg: rival.bearing, fov_deg: rival.fov, worse_by: secondCoarse - bestCoarse } : null,
    skyline_km: { median: dists.length ? dists[Math.floor(dists.length / 2)] / 1000 : null, max: skyFar / 1000 },
    peaks, peakSource: loaded.source, peakNote: loaded.note || "",
    lines, photoSkyline: { width: obs.width, height: obs.height, x: obs.x, y: obs.y, residuals: stats.residuals, sigma_px: sigmaFine },
    seconds: (Date.now() - t0) / 1000,
    // For solve_camera: the skyline as an extra constraint (not serialisable, stays in memory).
    constraint: skylineConstraint({ dem, horizon: hf, camera: { e: cam.e, n: cam.n, eyeZ }, obs, sigmaPx: sigmaFine, nEff: stats.nEff }),
  };
}

/** Labels to draw: named peaks first (on the skyline, then higher), none closer than minGapPx. */
export function pickLabels(peaks, widthPx, { minGapPx = 16, max = 24 } = {}) {
  const score = (p) => (p.name ? 4 : 0) + (p.on_skyline ? 2 : 0) + p.ele_m / 3000 - p.distance_m / 400000;
  const chosen = [];
  for (const p of [...peaks].sort((a, b) => score(b) - score(a))) {
    if (chosen.length >= max) break;
    if (chosen.some((q) => Math.abs(q.x - p.x) * widthPx < minGapPx)) continue;
    chosen.push(p);
  }
  return chosen.sort((a, b) => a.x - b.x);
}

const fmtKm = (m) => (m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1).replace(".", ",")} km`);

/** Label text for a peak: "Name 2345 m · 12 km". */
export function peakLabel(p) {
  return `${p.name || "Gipfel"} ${p.ele_m.toLocaleString("de-DE")} m · ${fmtKm(p.distance_m)}`;
}

/**
 * Browser: the photo with the terrain skyline (red), ridge lines (white) and peak labels, like PeakFinder.
 * crop: only the band around the skyline (for the AI: fewer pixels, more detail).
 */
export function skylineImage(bitmap, match, { maxWidth = 1200, crop = false } = {}) {
  const bw = bitmap.naturalWidth || bitmap.width;
  const bh = bitmap.naturalHeight || bitmap.height;
  const scale = Math.min(1, maxWidth / bw);
  const W = Math.round(bw * scale);
  const H = Math.round(bh * scale);
  const labels = pickLabels(match.peaks, W);
  const font = 13;
  const labelLen = (p) => 14 + peakLabel(p).length * font * 0.56;
  let top = 0;
  let bottom = H;
  if (crop) {
    const ys = match.lines.skyline.flat().map((p) => p[1] * H);
    const tops = labels.map((p) => p.y * H - 18 - labelLen(p));
    if (ys.length) {
      top = clamp(Math.min(...ys, ...tops) - 30, 0, H);
      bottom = clamp(Math.max(...ys) + 0.08 * H, top + 120, H);
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = Math.round(bottom - top) + 22;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, top / scale, bw, (bottom - top) / scale, 0, 0, W, bottom - top);
  ctx.save();
  ctx.translate(0, -top);
  const line = (pts, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    ctx.stroke();
  };
  for (const r of match.lines.ridges) line(r, "rgba(255,255,255,0.55)", 1);
  for (const s of match.lines.skyline) line(s, "rgba(255,40,40,0.95)", 2);
  ctx.font = `bold ${font}px sans-serif`;
  ctx.textBaseline = "middle";
  for (const p of labels) {
    const x = p.x * W;
    const y = p.y * H;
    // Labels read upwards above the peak; without room up to the top edge they go below it.
    const below = y - 20 - labelLen(p) < top + 2;
    const dir = below ? 1 : -1;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + 3 * dir);
    ctx.lineTo(x, y + 16 * dir);
    ctx.stroke();
    ctx.fillStyle = p.name ? "#ffd400" : "#fff";
    ctx.beginPath();
    ctx.moveTo(x, y + dir);
    ctx.lineTo(x - 4, y + 8 * dir);
    ctx.lineTo(x + 4, y + 8 * dir);
    ctx.closePath();
    ctx.fill();
    ctx.save();
    ctx.translate(x, below ? y + 20 + labelLen(p) - 14 : y - 20);
    ctx.rotate(-Math.PI / 2);
    const text = peakLabel(p);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
  const p = match.pose;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, canvas.height - 22, W, 22);
  ctx.fillStyle = "#fff";
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "alphabetic";
  const f1 = (v) => (Math.round(v * 10) / 10).toString().replace(".", ",");
  ctx.fillText(`Bergkamm-Abgleich · Blick ${f1(p.bearing)}° · Neigung ${f1(p.pitch)}° · Schieflage ${f1(p.roll)}° · Bildwinkel ${f1(p.fov)}° · ` +
    `rot = Geländehorizont · Gipfel: ${match.peakSource || "Geländemodell"} · Gelände: Mapzen/AWS`, 6, canvas.height - 7);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.87);
  const thumb = document.createElement("canvas");
  thumb.width = 240;
  thumb.height = Math.round((240 * canvas.height) / W);
  thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return { data: dataUrl.split(",")[1], dataUrl, thumbnail: thumb.toDataURL("image/jpeg", 0.8), width: W, height: canvas.height, labels };
}

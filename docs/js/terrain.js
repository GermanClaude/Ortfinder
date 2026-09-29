// Terrain elevation from the free Terrarium tiles (Mapzen terrain on AWS Open Data): used for
// mountain skylines in the 3D reconstruction and for line of sight in the visible-area computation.

import { worldPixel } from "./mapview.js";

const TILE = 256;

export const terrariumUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Terrarium encodes metres as (R·256 + G + B/256) − 32768. */
export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

/** Tile zoom used for a sample at distance `d` metres from the camera: fine nearby, coarse far away. */
export function zoomForDistance(d) {
  return d < 1500 ? 14 : d < 8000 ? 12 : 10;
}

/** Browser loader: PNG tile → Float32Array of 256×256 elevations, or null when unavailable. */
export async function loadTerrariumTile(z, x, y, timeoutMs = 15000) {
  const img = await new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), timeoutMs);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); resolve(null); };
    image.src = terrariumUrl(z, x, y);
  });
  if (!img) return null;
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  let px;
  try {
    px = ctx.getImageData(0, 0, TILE, TILE).data;
  } catch {
    return null; // no CORS permission
  }
  const out = new Float32Array(TILE * TILE);
  for (let i = 0; i < out.length; i++) out[i] = decodeTerrarium(px[4 * i], px[4 * i + 1], px[4 * i + 2]);
  return out;
}

/** Offset a point by metres east/north (flat approximation, fine for a few dozen kilometres). */
function offset(lat, lon, east, north) {
  const k = 111195;
  return [lat + north / k, lon + east / (k * Math.cos((lat * Math.PI) / 180))];
}

export class Terrain {
  constructor({ loadTile = loadTerrariumTile, maxTilesPerBox = 20, retryDelayMs = 600 } = {}) {
    this.loadTile = loadTile;
    this.maxTilesPerBox = maxTilesPerBox;
    this.retryDelayMs = retryDelayMs;
    this.tiles = new Map(); // "z/x/y" → Float32Array | null
    this.pending = new Map();
  }

  async ensure(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.tiles.has(key)) return;
    if (!this.pending.has(key)) {
      const attempt = () => Promise.resolve().then(() => this.loadTile(z, x, y)).catch(() => null);
      this.pending.set(key, attempt()
        .then((data) => data || new Promise((r) => setTimeout(r, this.retryDelayMs)).then(attempt)) // one retry
        .then((data) => { this.tiles.set(key, data || null); this.pending.delete(key); }));
    }
    await this.pending.get(key);
  }

  /** Load the tiles covering a lat/lon bounding box at zoom z (at most maxTilesPerBox). */
  async prefetchBox(south, west, north, east, z) {
    const n = 2 ** z;
    const a = worldPixel(Math.min(north, 85), west, z);
    const b = worldPixel(Math.max(south, -85), east, z);
    const jobs = [];
    for (let ty = Math.max(0, Math.floor(a.y / TILE)); ty <= Math.min(n - 1, Math.floor(b.y / TILE)); ty++) {
      for (let tx = Math.floor(a.x / TILE); tx <= Math.floor(b.x / TILE); tx++) {
        if (jobs.length >= this.maxTilesPerBox) break;
        jobs.push(this.ensure(z, ((tx % n) + n) % n, ty));
      }
    }
    await Promise.all(jobs);
  }

  /** Load what a camera looking along `bearingDeg` with field of view `fovDeg` needs up to maxDistM. */
  async prefetchView(lat, lon, bearingDeg, fovDeg, maxDistM) {
    // Coarse z10 tiles cover the whole view, so a missing finer tile falls back to them instead of flat ground.
    const bands = [[0, 1500, 14], [1500, 8000, 12], [0, Infinity, 10]];
    const jobs = [];
    for (const [from, to, z] of bands) {
      if (from >= maxDistM || (z === 10 && maxDistM <= 1500)) continue;
      const far = Math.min(to, maxDistM);
      const pts = from === 0 ? [[lat, lon]] : [];
      const half = Math.min(fovDeg, 360) / 2;
      for (let a = -half; a <= half + 1e-9; a += Math.max(1, half / 6)) {
        const br = ((bearingDeg + a) * Math.PI) / 180;
        for (const d of [from, far]) pts.push(offset(lat, lon, Math.sin(br) * d, Math.cos(br) * d));
      }
      const lats = pts.map((p) => p[0]);
      const lons = pts.map((p) => p[1]);
      jobs.push(this.prefetchBox(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons), z));
    }
    await Promise.all(jobs);
  }

  /** Bilinear elevation in metres from one zoom level, or null if that tile is not loaded. */
  sample(lat, lon, z) {
    const n = 2 ** z;
    const p = worldPixel(lat, lon, z);
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    const data = this.tiles.get(`${z}/${((tx % n) + n) % n}/${ty}`);
    if (!data) return null;
    const fx = Math.min(Math.max(p.x - tx * TILE - 0.5, 0), TILE - 1);
    const fy = Math.min(Math.max(p.y - ty * TILE - 0.5, 0), TILE - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, TILE - 1);
    const y1 = Math.min(y0 + 1, TILE - 1);
    const dx = fx - x0;
    const dy = fy - y0;
    const v = (x, y) => data[y * TILE + x];
    return v(x0, y0) * (1 - dx) * (1 - dy) + v(x1, y0) * dx * (1 - dy) + v(x0, y1) * (1 - dx) * dy + v(x1, y1) * dx * dy;
  }

  /**
   * Elevation at the finest loaded zoom ≤ z, or null when nothing is loaded there; near exact heights
   * (this.correction, see swiss.js addExactHeights) corrected by the model's error there.
   */
  elevation(lat, lon, z = 14) {
    const v = this.modelElevation(lat, lon, z);
    return v == null || !this.correction ? v : v + this.correction(lat, lon, z);
  }

  /** The model's own elevation, without corrections. */
  modelElevation(lat, lon, z = 14) {
    for (let zz = z; zz >= 8; zz--) {
      const v = this.sample(lat, lon, zz);
      if (v != null) return v;
    }
    return null;
  }

  get available() {
    for (const data of this.tiles.values()) if (data) return true;
    return false;
  }
}

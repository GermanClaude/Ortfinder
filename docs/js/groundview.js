// Side view ↔ top view. Every pixel of the photo is traced as a sight ray onto the terrain model (with
// earth curvature), so that
//  - the photo can be laid flat onto the map ("Draufsicht") and compared with aerial imagery: roofs,
//    roads, field edges and trees must then line up, and
//  - aerial imagery can be seen from the camera: the terrain draped with the satellite image, a
//    Google-Earth-like view to compare with the photo.
// The math is plain functions (tested in Node); the browser parts (tiles, canvases) are at the end.

import { TILE_SOURCES, latLonFromWorldPixel, loadTileImage, worldPixel } from "./mapview.js";
import { groundModel, makeCamera } from "./scene3d.js";
import { SURFACES, flatTopView, surfaceMask, surfaceStats } from "./surfaceview.js";

const DEG = Math.PI / 180;
const TILE = 256;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Sight rays for every pixel of `cam`: where each ray meets the ground. Returns per pixel the horizontal
 * distance (Infinity = sky or farther than maxDistM) and the hit point in metres east/north of the camera.
 * Column by column from the bottom up, each ray continues where the one below it hit – a height field
 * seen from above it is never hit closer by a higher ray – so the whole image costs about one march per column.
 */
export function castRays({ cam, g, maxDistM = 30000 }) {
  const { width: W, height: H, f, r, u, fpx } = cam;
  const dist = new Float32Array(W * H).fill(Infinity);
  const hx = new Float32Array(W * H);
  const hy = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    const a = (x + 0.5 - W / 2) / fpx;
    let start = 0.5;
    for (let y = H - 1; y >= 0; y--) {
      const b = (H / 2 - (y + 0.5)) / fpx;
      const dx = f[0] + a * r[0] + b * u[0];
      const dy = f[1] + a * r[1] + b * u[1];
      const dz = f[2] + a * r[2] + b * u[2];
      const h = Math.hypot(dx, dy);
      if (h < 1e-9) continue; // straight up or down
      const ex = dx / h;
      const ey = dy / h;
      const slope = dz / h; // height change of the ray per metre of horizontal distance
      let prevT = -1;
      let prevDiff = 0;
      let hit = -1;
      for (let t = start; t <= maxDistM; t += Math.max(0.5, t * 0.008)) {
        const diff = slope * t - g.groundZ(ex * t, ey * t, t);
        if (diff <= 0) {
          hit = prevT < 0 ? t : prevT + ((t - prevT) * prevDiff) / (prevDiff - diff);
          break;
        }
        prevT = t;
        prevDiff = diff;
      }
      if (hit < 0) break; // this ray and every ray above it in the column only see sky
      const i = y * W + x;
      dist[i] = hit;
      hx[i] = ex * hit;
      hy[i] = ey * hit;
      start = Math.max(0.5, hit * 0.985);
    }
  }
  return { width: W, height: H, dist, hx, hy, bearingDeg: (Math.atan2(f[0], f[1]) / DEG + 360) % 360 };
}

/**
 * A north-up Web-Mercator box around the given points, scaled so its longer side has `maxSide` pixels.
 * `zoom` is fractional; worldPixel(lat, lon, zoom) − (x0, y0) is the pixel inside the box.
 */
export function mercatorBox(points, maxSide) {
  const Z = 20;
  const px = points.map(([la, lo]) => worldPixel(la, lo, Z));
  const minX = Math.min(...px.map((p) => p.x));
  const maxX = Math.max(...px.map((p) => p.x));
  const minY = Math.min(...px.map((p) => p.y));
  const maxY = Math.max(...px.map((p) => p.y));
  const scale = maxSide / Math.max(maxX - minX, maxY - minY, 1e-6);
  const zoom = Z + Math.log2(scale);
  const width = Math.max(1, Math.round((maxX - minX) * scale));
  const height = Math.max(1, Math.round((maxY - minY) * scale));
  const x0 = minX * scale;
  const y0 = minY * scale;
  const [north, west] = latLonFromWorldPixel(x0, y0, zoom);
  const [south, east] = latLonFromWorldPixel(x0 + width, y0 + height, zoom);
  return { zoom, x0, y0, width, height, bounds: { south, west, north, east } };
}

/** Bilinear RGB from RGBA pixels. */
function sampleRgb(data, W, H, x, y) {
  const fx = clamp(x - 0.5, 0, W - 1);
  const fy = clamp(y - 0.5, 0, H - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, W - 1);
  const y1 = Math.min(y0 + 1, H - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = data[(y0 * W + x0) * 4 + c] * (1 - tx) + data[(y0 * W + x1) * 4 + c] * tx;
    const bottom = data[(y1 * W + x0) * 4 + c] * (1 - tx) + data[(y1 * W + x1) * 4 + c] * tx;
    out[c] = top * (1 - ty) + bottom * ty;
  }
  return out;
}

/**
 * Lay the photo flat onto the map. For every pixel of the north-up `box` (see mercatorBox) the ground point
 * is projected into the photo; it is filled when the sight ray through that photo pixel really ends there
 * (not hidden behind a hill), lies between minDistM and maxDistM and inside `region` ([x0, y0, x1, y1] in
 * 0–1 photo coordinates). Returns RGBA pixels (transparent where the photo shows nothing of the ground).
 */
export function projectPhotoToMap({ photo, cam, rays, g, box, minDistM = 10, maxDistM = 1500, region = null, surfaceAt = null }) {
  const { width: W, height: H, data: src } = photo;
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  const kx = rays.width / W;
  const ky = rays.height / H;
  const [rx0, ry0, rx1, ry1] = region ? [region[0] * W, region[1] * H, region[2] * W, region[3] * H] : [0, 0, W, H];
  // Web Mercator is separable: latitude depends only on the row, longitude only on the column.
  const lons = Float64Array.from({ length: box.width }, (_, i) => latLonFromWorldPixel(box.x0 + i + 0.5, box.y0, box.zoom)[1]);
  let covered = 0;
  let nearest = Infinity;
  let farthest = 0;
  for (let j = 0; j < box.height; j++) {
    const lat = latLonFromWorldPixel(box.x0, box.y0 + j + 0.5, box.zoom)[0];
    for (let i = 0; i < box.width; i++) {
      const [e, n] = g.proj.toXY(lat, lons[i]);
      const s = Math.hypot(e, n);
      if (s < minDistM || s > maxDistM) continue;
      const c = cam.toCam([e, n, g.groundZ(e, n, s)]);
      if (c[2] <= 0.1) continue;
      const [u, v] = cam.project(c);
      if (u < rx0 || u >= rx1 || v < ry0 || v >= ry1) continue;
      // Visible only if the ray through this photo pixel does not end earlier (hill, slope in between).
      const ri = Math.min(rays.height - 1, Math.floor(v * ky)) * rays.width + Math.min(rays.width - 1, Math.floor(u * kx));
      const seen = rays.dist[ri];
      if (s > seen * 1.04 + 3) continue;
      let [cr, cg, cb] = sampleRgb(src, W, H, u, v);
      const tint = surfaceAt?.(u / W, v / H);
      if (tint) [cr, cg, cb] = [0, 1, 2].map((c) => [cr, cg, cb][c] * 0.6 + tint[c] * 0.4);
      const o = (j * box.width + i) * 4;
      out[o] = cr;
      out[o + 1] = cg;
      out[o + 2] = cb;
      out[o + 3] = 255;
      covered += 1;
      if (s < nearest) nearest = s;
      if (s > farthest) farthest = s;
    }
  }
  return { data: out, covered, nearest: covered ? nearest : null, farthest: covered ? farthest : null };
}

/** Local-metre extent of the ground the photo shows between minDistM and maxDistM (inside `region`). */
export function groundExtent(rays, { minDistM = 10, maxDistM = 1500, region = null } = {}) {
  const [x0, y0, x1, y1] = region
    ? [region[0] * rays.width, region[1] * rays.height, region[2] * rays.width, region[3] * rays.height]
    : [0, 0, rays.width, rays.height];
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  let hits = 0;
  let halfSpread = 0;
  const bearing = rays.bearingDeg ?? 0;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const i = y * rays.width + x;
      const d = rays.dist[i];
      if (!(d >= minDistM && d <= maxDistM)) continue;
      hits += 1;
      minE = Math.min(minE, rays.hx[i]);
      maxE = Math.max(maxE, rays.hx[i]);
      minN = Math.min(minN, rays.hy[i]);
      maxN = Math.max(maxN, rays.hy[i]);
      const az = Math.atan2(rays.hx[i], rays.hy[i]) / DEG - bearing;
      halfSpread = Math.max(halfSpread, Math.abs(((az % 360) + 540) % 360 - 180));
    }
  }
  return hits ? { minE, maxE, minN, maxN, hits, halfSpread } : null;
}

/** A round grid spacing giving about `lines` lines over `span` metres (10, 20, 25, 50, 100 … m). */
export function gridSpacing(span, lines = 6) {
  const raw = span / lines;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * pow).find((v) => v >= raw) ?? 10 * pow;
}

/** Tile zoom whose pixels are about as large as `metres` on the ground (never finer than maxZoom). */
export function imageryZoom(lat, metres, maxZoom = 19) {
  return clamp(Math.floor(Math.log2((156543.03392 * Math.cos(lat * DEG)) / Math.max(metres, 0.05))), 2, maxZoom);
}

/**
 * Colour every ray hit from aerial imagery. `imagery.color(lat, lon, zoom)` returns [r, g, b] or null.
 * Returns RGBA: sky stays transparent, distant ground fades into haze like in a photo.
 */
export function drapeRays({ rays, cam, g, imagery, zoomBias = 0, lat0 }) {
  const out = new Uint8ClampedArray(rays.width * rays.height * 4);
  const haze = [184, 196, 212];
  for (let i = 0; i < rays.dist.length; i++) {
    const d = rays.dist[i];
    if (!Number.isFinite(d)) continue;
    const [la, lo] = g.proj.toLatLon(rays.hx[i], rays.hy[i]);
    // Size of one screen pixel on the ground (grazing views stretch it; the tile only needs the across size).
    const z = imageryZoom(lat0, (d / cam.fpx) * (cam.width / rays.width), 19) + zoomBias;
    const rgb = imagery.color(la, lo, z) ?? [120, 138, 96];
    const t = 1 - Math.exp(-d / 9000);
    const o = i * 4;
    out[o] = rgb[0] + (haze[0] - rgb[0]) * t;
    out[o + 1] = rgb[1] + (haze[1] - rgb[1]) * t;
    out[o + 2] = rgb[2] + (haze[2] - rgb[2]) * t;
    out[o + 3] = 255;
  }
  return out;
}

/** Tile keys ("z/x/y") the drape needs, with the zoom lowered until at most maxTiles remain. */
export function tilesForRays({ rays, cam, g, lat0, maxTiles = 100 }) {
  for (let bias = 0; bias > -8; bias--) {
    const keys = new Set();
    for (let i = 0; i < rays.dist.length; i += 3) {
      const d = rays.dist[i];
      if (!Number.isFinite(d)) continue;
      const [la, lo] = g.proj.toLatLon(rays.hx[i], rays.hy[i]);
      const z = imageryZoom(lat0, (d / cam.fpx) * (cam.width / rays.width), 19) + bias;
      const p = worldPixel(la, lo, z);
      keys.add(`${z}/${Math.floor(p.x / TILE)}/${Math.floor(p.y / TILE)}`);
      if (keys.size > maxTiles) break;
    }
    if (keys.size <= maxTiles) return { keys: [...keys], bias };
  }
  return { keys: [], bias: -8 };
}

// ---------- browser ----------

/** Aerial imagery tiles as pixel arrays, for colouring the draped terrain. */
export class ImageryTiles {
  constructor({ url = TILE_SOURCES.satellit.url, loadImage = loadTileImage } = {}) {
    this.url = url;
    this.loadImage = loadImage;
    this.tiles = new Map(); // key → Uint8ClampedArray | null
  }

  async load(keys, concurrency = 8) {
    const todo = keys.filter((k) => !this.tiles.has(k));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const key = todo[next++];
        const [z, x, y] = key.split("/").map(Number);
        const img = await this.loadImage(this.url(z, x, y));
        let data = null;
        if (img) {
          const c = document.createElement("canvas");
          c.width = TILE;
          c.height = TILE;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, TILE, TILE);
          try {
            data = ctx.getImageData(0, 0, TILE, TILE).data;
          } catch {
            data = null; // no CORS permission
          }
        }
        this.tiles.set(key, data);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  }

  /** Colour at a point from the finest loaded tile at zoom ≤ z. */
  color(lat, lon, z) {
    for (let zz = z; zz >= Math.max(2, z - 4); zz--) {
      const p = worldPixel(lat, lon, zz);
      const tx = Math.floor(p.x / TILE);
      const ty = Math.floor(p.y / TILE);
      const data = this.tiles.get(`${zz}/${tx}/${ty}`);
      if (!data) continue;
      const i = (Math.min(TILE - 1, Math.floor(p.y - ty * TILE)) * TILE + Math.min(TILE - 1, Math.floor(p.x - tx * TILE))) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    }
    return null;
  }
}

/** Photo pixels (at most maxSide on the longer side) for projecting. */
function photoPixels(bitmap, maxSide = 1600) {
  const bw = bitmap.naturalWidth || bitmap.width;
  const bh = bitmap.naturalHeight || bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(bw, bh));
  const W = Math.round(bw * scale);
  const H = Math.round(bh * scale);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, W, H);
  return { width: W, height: H, data: ctx.getImageData(0, 0, W, H).data };
}

/** Aerial imagery for a Mercator box (sharpest tile zoom that is not finer than needed). */
export async function drawImageryBox(ctx, box, url = TILE_SOURCES.satellit.url, maxTiles = Infinity) {
  let z = clamp(Math.ceil(box.zoom), 2, 19);
  // Coarser tiles when the box would need too many (each zoom level down quarters the count).
  const count = (zz) => {
    const kk = 2 ** (zz - box.zoom);
    return (Math.floor((box.x0 + box.width) * kk / TILE) - Math.floor((box.x0 * kk) / TILE) + 1) *
      (Math.floor((box.y0 + box.height) * kk / TILE) - Math.floor((box.y0 * kk) / TILE) + 1);
  };
  while (z > 2 && count(z) > maxTiles) z--;
  const k = 2 ** (z - box.zoom); // tile pixels per box pixel
  const left = box.x0 * k;
  const top = box.y0 * k;
  const jobs = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + box.height * k) / TILE); ty++) {
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + box.width * k) / TILE); tx++) {
      jobs.push(loadTileImage(url(z, tx, ty)).then((img) => {
        if (img) ctx.drawImage(img, (tx * TILE - left) / k, (ty * TILE - top) / k, TILE / k + 0.5, TILE / k + 0.5);
        return Boolean(img);
      }));
    }
  }
  const loaded = await Promise.all(jobs);
  return loaded.filter(Boolean).length;
}

/** Grid (labelled A, B, C … / 1, 2, 3 …), camera, field of view, distance rings, north arrow and scale. */
function drawMapOverlay(ctx, box, { lat, lon, bearingDeg, azFrom, azTo, edges, gridM, rings }) {
  const toPx = (la, lo) => {
    const p = worldPixel(la, lo, box.zoom);
    return [p.x - box.x0, p.y - box.y0];
  };
  const mpp = (156543.03392 * Math.cos(lat * DEG)) / 2 ** box.zoom;
  const [cx, cy] = toPx(lat, lon);
  ctx.save();
  ctx.font = "bold 12px sans-serif";
  ctx.lineWidth = 1;
  // Grid lines through the camera's metric frame, so "C3" means the same square in both panels.
  const cols = [];
  for (let e = Math.floor((-cx * mpp) / gridM) * gridM; (e / mpp) + cx <= box.width; e += gridM) cols.push(cx + e / mpp);
  const rows = [];
  for (let n = Math.floor((-cy * mpp) / gridM) * gridM; (n / mpp) + cy <= box.height; n += gridM) rows.push(cy + n / mpp);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.setLineDash([4, 4]);
  for (const x of cols) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, box.height); ctx.stroke(); }
  for (const y of rows) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(box.width, y); ctx.stroke(); }
  ctx.setLineDash([]);
  const label = (text, x, y) => {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    const w = ctx.measureText(text).width + 6;
    ctx.fillRect(x - w / 2, y - 8, w, 16);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(text, x, y + 4);
  };
  const cells = (list, size) => [0, ...list.filter((v) => v > 0 && v < size), size];
  const xs = cells(cols, box.width);
  const ys = cells(rows, box.height);
  for (let i = 0; i + 1 < xs.length; i++) label(String.fromCharCode(65 + i), (xs[i] + xs[i + 1]) / 2, 10);
  for (let i = 0; i + 1 < ys.length; i++) label(String(i + 1), 10, (ys[i] + ys[i + 1]) / 2);
  // Distance rings across the photographed sector, and the left/right photo edges traced on the ground.
  ctx.strokeStyle = "rgba(255,210,0,0.85)";
  ctx.fillStyle = "rgba(255,210,0,0.95)";
  for (const r of rings) {
    ctx.beginPath();
    ctx.arc(cx, cy, r / mpp, (azFrom - 90) * DEG, (azTo - 90) * DEG);
    ctx.stroke();
    const a = (azTo - 90) * DEG;
    ctx.textAlign = "left";
    ctx.fillText(r >= 1000 ? `${r / 1000} km` : `${r} m`, cx + Math.cos(a) * (r / mpp) + 3, cy + Math.sin(a) * (r / mpp));
  }
  ctx.lineWidth = 2;
  for (const edge of edges) {
    ctx.beginPath();
    edge.forEach(([la, lo], i) => {
      const [x, y] = toPx(la, lo);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  // Camera: red dot with the viewing direction.
  const a = (bearingDeg - 90) * DEG;
  ctx.strokeStyle = "#ff1744";
  ctx.fillStyle = "#ff1744";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * 26, cy + Math.sin(a) * 26);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
  // North arrow and scale bar.
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(box.width - 28, 24, 22, 30);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.fillText("N", box.width - 17, 38);
  ctx.fillText("↑", box.width - 17, 51);
  const barPx = gridM / mpp;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(6, box.height - 26, barPx + 12, 20);
  ctx.fillStyle = "#fff";
  ctx.fillRect(12, box.height - 12, barPx, 3);
  ctx.textAlign = "left";
  ctx.fillText(gridM >= 1000 ? `${gridM / 1000} km` : `${gridM} m`, 14, box.height - 15);
  ctx.restore();
}

/**
 * Browser: the photo laid flat next to aerial imagery of exactly the same area (or both on top of each
 * other), plus a transparent PNG of the flattened photo for the map.
 */
export async function topViewImage({
  bitmap, terrain, lat, lon, bearingDeg, fovDeg, pitchDeg = 0, rollDeg = 0, eyeHeight = 1.6,
  minDistM = 10, maxDistM = 1500, region = null, style = "nebeneinander", panel = 640, surfaces = [],
}) {
  const photo = photoPixels(bitmap);
  const aspect = photo.width / photo.height;
  // Azimuths covered by the photo (wider than the horizontal angle for tilted, tall images).
  const halfV = Math.atan(Math.tan((fovDeg * DEG) / 2) / aspect) / DEG;
  const spread = Math.min(170, fovDeg + Math.abs(pitchDeg) * 0.5 + (aspect < 1 ? halfV : 0) + 10);
  await terrain.prefetchView(lat, lon, bearingDeg, spread, Math.max(maxDistM, 1600)).catch(() => {});
  const g = groundModel({ lat, lon, eyeHeight, terrain });
  const cam = makeCamera({ bearingDeg, pitchDeg, rollDeg, fovDeg, width: photo.width, height: photo.height });
  const rw = Math.min(photo.width, 360);
  const camR = makeCamera({ bearingDeg, pitchDeg, rollDeg, fovDeg, width: rw, height: Math.round((rw * photo.height) / photo.width) });
  const rays = castRays({ cam: camR, g, maxDistM: maxDistM * 1.2 });
  const extent = groundExtent(rays, { minDistM, maxDistM, region });
  if (!extent) {
    return { empty: true, note: "In diesem Entfernungsbereich zeigt das Foto keinen Boden (nur Himmel, Berge weiter weg oder alles verdeckt)." };
  }
  const pad = 0.04 * Math.max(extent.maxE - extent.minE, extent.maxN - extent.minN, 20);
  const corners = [
    [extent.minE - pad, extent.minN - pad], [extent.maxE + pad, extent.maxN + pad],
    [extent.minE - pad, extent.maxN + pad], [extent.maxE + pad, extent.minN - pad], [0, 0],
  ].map(([e, n]) => g.proj.toLatLon(e, n));
  const box = mercatorBox(corners, panel);
  const flat = projectPhotoToMap({ photo, cam, rays, g, box, minDistM, maxDistM, region, surfaceAt: surfaceLookup(surfaces) });

  const flatCanvas = document.createElement("canvas");
  flatCanvas.width = box.width;
  flatCanvas.height = box.height;
  flatCanvas.getContext("2d").putImageData(new ImageData(flat.data, box.width, box.height), 0, 0);
  const overlayUrl = flatCanvas.toDataURL("image/png");

  const sat = document.createElement("canvas");
  sat.width = box.width;
  sat.height = box.height;
  const sctx = sat.getContext("2d");
  sctx.fillStyle = "#777";
  sctx.fillRect(0, 0, box.width, box.height);
  const tiles = await drawImageryBox(sctx, box);

  const spanM = Math.max(extent.maxE - extent.minE, extent.maxN - extent.minN) + 2 * pad;
  const gridM = gridSpacing(spanM);
  const ringStep = gridSpacing(Math.min(maxDistM, flat.farthest ?? maxDistM), 3);
  const rings = [];
  for (let r = ringStep; r <= Math.min(maxDistM, (flat.farthest ?? 0) + ringStep); r += ringStep) rings.push(r);
  // Where the left and right edges of the photo meet the ground; and the sector between them.
  const edges = [0, rays.width - 1].map((x) => {
    const pts = [];
    for (let y = rays.height - 1; y >= 0; y--) {
      const i = y * rays.width + x;
      if (rays.dist[i] >= minDistM && rays.dist[i] <= maxDistM) pts.push(g.proj.toLatLon(rays.hx[i], rays.hy[i]));
    }
    return pts;
  });
  const overlay = { lat, lon, bearingDeg, azFrom: bearingDeg - extent.halfSpread, azTo: bearingDeg + extent.halfSpread, edges, gridM, rings };

  const header = 22;
  const gap = 8;
  const side = style !== "ueberlagert";
  const out = document.createElement("canvas");
  out.width = side ? box.width * 2 + gap : box.width;
  out.height = box.height + header;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, out.width, out.height);
  const panelAt = (x, title, draw) => {
    ctx.save();
    ctx.translate(x, header);
    ctx.beginPath();
    ctx.rect(0, 0, box.width, box.height);
    ctx.clip();
    draw();
    drawMapOverlay(ctx, box, overlay);
    ctx.restore();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(title, x + 6, 15);
  };
  if (side) {
    panelAt(0, "Foto → Draufsicht (auf das Gelände projiziert)", () => {
      ctx.fillStyle = "#3a3a3a";
      ctx.fillRect(0, 0, box.width, box.height);
      ctx.drawImage(flatCanvas, 0, 0);
    });
    panelAt(box.width + gap, "Luftbild (Esri) – gleicher Ausschnitt", () => ctx.drawImage(sat, 0, 0));
  } else {
    panelAt(0, "Luftbild mit darübergelegtem Foto (60 %)", () => {
      ctx.drawImage(sat, 0, 0);
      ctx.globalAlpha = 0.6;
      ctx.drawImage(flatCanvas, 0, 0);
      ctx.globalAlpha = 1;
    });
  }
  const dataUrl = out.toDataURL("image/jpeg", 0.86);
  const thumb = document.createElement("canvas");
  thumb.width = 240;
  thumb.height = Math.round((240 * out.height) / out.width);
  thumb.getContext("2d").drawImage(out, 0, 0, thumb.width, thumb.height);
  const mpp = (156543.03392 * Math.cos(lat * DEG)) / 2 ** box.zoom;
  return {
    data: dataUrl.split(",")[1], dataUrl, thumbnail: thumb.toDataURL("image/jpeg", 0.8),
    overlay: { url: overlayUrl, bounds: box.bounds },
    stats: {
      covered_pct: Math.round((100 * flat.covered) / (box.width * box.height)),
      width_m: Math.round(box.width * mpp), height_m: Math.round(box.height * mpp), m_per_px: Math.round(mpp * 100) / 100,
      grid_m: gridM, nearest_m: flat.nearest == null ? null : Math.round(flat.nearest), farthest_m: flat.farthest == null ? null : Math.round(flat.farthest),
      terrain: g.hasTerrain, ground_m: Math.round(g.ground0), imagery_tiles: tiles,
    },
  };
}

/**
 * Browser: the terrain seen from the camera, draped with aerial imagery (Google-Earth-like), as a canvas
 * to draw under the OSM buildings. Returns null when the terrain or imagery is not available.
 */
export async function drapedTerrain({ terrain, lat, lon, bearingDeg, fovDeg, pitchDeg = 0, rollDeg = 0, eyeHeight = 1.6, width, height, maxDistM = 30000, imagery = new ImageryTiles() }) {
  const g = groundModel({ lat, lon, eyeHeight, terrain });
  const cam = makeCamera({ bearingDeg, pitchDeg, rollDeg, fovDeg, width, height });
  // Rays at half resolution: plenty for colours, four times faster.
  const rw = Math.max(80, Math.round(width / 2));
  const camR = makeCamera({ bearingDeg, pitchDeg, rollDeg, fovDeg, width: rw, height: Math.round((rw * height) / width) });
  const rays = castRays({ cam: camR, g, maxDistM });
  const { keys, bias } = tilesForRays({ rays, cam: camR, g, lat0: lat, maxTiles: 110 });
  await imagery.load(keys);
  const rgba = drapeRays({ rays, cam: camR, g, imagery, zoomBias: bias, lat0: lat });
  const small = document.createElement("canvas");
  small.width = rays.width;
  small.height = rays.height;
  small.getContext("2d").putImageData(new ImageData(rgba, rays.width, rays.height), 0, 0);
  let skyline = 0;
  for (let x = 0; x < rays.width; x++) {
    for (let y = 0; y < rays.height; y++) {
      const d = rays.dist[y * rays.width + x];
      if (Number.isFinite(d)) { skyline = Math.max(skyline, d); break; }
    }
  }
  const loaded = keys.filter((k) => imagery.tiles.get(k)).length;
  return { canvas: small, skyline, tiles: loaded, wanted: keys.length };
}


/** Colour lookup for the outlined surfaces at photo position (0–1), or null. */
function surfaceLookup(surfaces, w = 480, h = 360) {
  if (!surfaces?.length) return null;
  const mask = surfaceMask(surfaces, w, h);
  return (x, y) => {
    const k = mask[Math.min(h - 1, Math.max(0, Math.floor(y * h))) * w + Math.min(w - 1, Math.max(0, Math.floor(x * w)))];
    return k >= 0 ? SURFACES[surfaces[k].art] : null;
  };
}

/**
 * Browser: the top view from the photo alone (no standpoint): the ground laid flat with a metre grid, the
 * reliable range marked and, next to it, the outlined surfaces as a plain map with a legend.
 */
export function surfaceTopViewImage({ bitmap, fovDeg, pitchDeg = 0, rollDeg = 0, eyeHeight = 1.6, minDistM = 0, maxDistM = 60, surfaces = [], reliableM = Infinity, panel = 560 }) {
  const photo = photoPixels(bitmap);
  const view = flatTopView({ photo, fovDeg, pitchDeg, rollDeg, eyeHeight, minDistM, maxDistM, surfaces, panel });
  if (!view) return { empty: true, note: "Mit dieser Neigung zeigt das Foto keinen Boden vor der Kamera (Horizont zu tief oder Blick nach oben) – horizon_y prüfen." };
  const { width: W, height: H, mPerPx: m } = view;
  const toPx = (e, n) => [(e - view.minE) / m, (view.maxN - n) / m];
  const [cx, cy] = toPx(0, 0);
  // Panel A: the photo laid flat, beyond the reliable range dimmed; outlined surfaces tinted, their borders solid.
  const a = new ImageData(W, H);
  const b = new ImageData(W, H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      const o = p * 4;
      if (!view.data[o + 3]) {
        a.data.set([46, 50, 56, 255], o);
        b.data.set([236, 238, 240, 255], o);
        continue;
      }
      const d = Math.hypot(i - cx, j - cy) * m;
      const dim = d > reliableM ? 0.5 : 1;
      const k = view.cls[p];
      const col = k >= 0 ? SURFACES[surfaces[k].art] : null;
      const edge = k >= 0 && ((i > 0 && view.cls[p - 1] !== k) || (j > 0 && view.cls[p - W] !== k));
      for (let c = 0; c < 3; c++) {
        const photoC = view.data[o + c];
        a.data[o + c] = (edge ? col[c] : col ? photoC * 0.65 + col[c] * 0.35 : photoC) * dim;
        b.data[o + c] = col ? col[c] * (d > reliableM ? 0.7 : 1) + (d > reliableM ? 255 * 0.3 : 0) : 200 + (photoC - 128) * 0.15;
      }
      a.data[o + 3] = 255;
      b.data[o + 3] = 255;
    }
  }
  const spanM = Math.max(W, H) * m;
  const gridM = gridSpacing(spanM);
  const decorate = (ctx) => {
    ctx.save();
    ctx.font = "bold 12px sans-serif";
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.setLineDash([4, 4]);
    for (let e = Math.ceil(view.minE / gridM) * gridM; e <= view.maxE; e += gridM) {
      const [x] = toPx(e, 0);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let n = Math.ceil(view.minN / gridM) * gridM; n <= view.maxN; n += gridM) {
      const [, y] = toPx(0, n);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // Distance rings, and the reliable range as a dashed yellow arc.
    ctx.strokeStyle = "rgba(255,210,0,0.8)";
    ctx.fillStyle = "rgba(255,210,0,0.95)";
    const ring = gridSpacing(Math.min(maxDistM, view.farthest), 3);
    for (let r = ring; r <= view.farthest + 1e-6; r += ring) {
      ctx.beginPath();
      ctx.arc(cx, cy, r / m, -Math.PI * 0.95, -Math.PI * 0.05);
      ctx.stroke();
      ctx.fillText(`${r} m`, cx + 3, cy - r / m - 3);
    }
    if (reliableM < view.farthest) {
      ctx.strokeStyle = "#ffd400";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.arc(cx, cy, reliableM / m, -Math.PI * 0.95, -Math.PI * 0.05);
      ctx.stroke();
      ctx.setLineDash([]);
      const text = `verlässlich bis ${Math.round(reliableM)} m`;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(6, 6, ctx.measureText(text).width + 10, 18);
      ctx.fillStyle = "#ffd400";
      ctx.textAlign = "left";
      ctx.fillText(text, 11, 19);
    }
    // Camera at the bottom, looking up; scale bar.
    ctx.fillStyle = "#ff1744";
    ctx.beginPath();
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx - 7, cy + 2);
    ctx.lineTo(cx + 7, cy + 2);
    ctx.closePath();
    ctx.fill();
    const bar = gridM / m;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(W - bar - 20, H - 26, bar + 14, 20);
    ctx.fillStyle = "#fff";
    ctx.fillRect(W - bar - 13, H - 12, bar, 3);
    ctx.textAlign = "left";
    ctx.fillText(`${gridM} m`, W - bar - 11, H - 15);
    ctx.restore();
  };
  const header = 22;
  const gap = 8;
  const withMap = surfaces.length > 0;
  const legendH = withMap ? 22 : 0;
  const out = document.createElement("canvas");
  out.width = withMap ? W * 2 + gap : W;
  out.height = H + header + legendH;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, out.width, out.height);
  const panelAt = (x, img, title) => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const pc = c.getContext("2d");
    pc.putImageData(img, 0, 0);
    decorate(pc);
    ctx.drawImage(c, x, header);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(title, x + 6, 15);
  };
  panelAt(0, a, "Foto → Draufsicht (ebener Boden, Blick nach oben)");
  const stats = surfaceStats(view, surfaces, reliableM);
  if (withMap) {
    panelAt(W + gap, b, "Oberflächen – zum Vergleich mit Luftbildern");
    // Legend: the kinds that were outlined.
    let x = 6;
    ctx.font = "12px sans-serif";
    for (const art of [...new Set(surfaces.map((s) => s.art))]) {
      const col = SURFACES[art];
      ctx.fillStyle = `rgb(${col.join(",")})`;
      ctx.fillRect(x, H + header + 5, 12, 12);
      ctx.fillStyle = "#fff";
      ctx.fillText(art, x + 16, H + header + 15);
      x += ctx.measureText(art).width + 30;
    }
  }
  const dataUrl = out.toDataURL("image/jpeg", 0.86);
  const thumb = document.createElement("canvas");
  thumb.width = 240;
  thumb.height = Math.round((240 * out.height) / out.width);
  thumb.getContext("2d").drawImage(out, 0, 0, thumb.width, thumb.height);
  return {
    data: dataUrl.split(",")[1], dataUrl, thumbnail: thumb.toDataURL("image/jpeg", 0.8),
    stats: {
      width_m: Math.round(W * m), depth_m: Math.round(H * m), m_per_px: Math.round(m * 100) / 100, grid_m: gridM,
      nearest_m: Math.round(view.nearest * 10) / 10, farthest_m: Math.round(view.farthest), surfaces: stats,
    },
  };
}

// Aerial imagery and map snapshots around a point, rendered for the AI to compare with the photo.

export const TILE_SOURCES = {
  satellit: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: "Luftbild: Esri, Maxar, Earthstar Geographics",
  },
  karte: {
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: "© OpenStreetMap-Mitwirkende",
  },
};

const TILE = 256;

export function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** Web-Mercator pixel coordinates of a point at the given zoom level. */
export function worldPixel(lat, lon, zoom) {
  const size = TILE * 2 ** zoom;
  const phi = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * size,
  };
}

/** Inverse of worldPixel: latitude/longitude of Web-Mercator pixel (x, y) at the given zoom level. */
export function latLonFromWorldPixel(x, y, zoom) {
  const size = TILE * 2 ** zoom;
  return [(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI, (x / size) * 360 - 180];
}

/** Tiles needed to cover a square of `size` pixels centred on (lat, lon). */
export function tilesFor(lat, lon, zoom, size) {
  const { x, y } = worldPixel(lat, lon, zoom);
  const left = x - size / 2;
  const top = y - size / 2;
  const n = 2 ** zoom;
  const tiles = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + size - 1) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + size - 1) / TILE); tx++) {
      tiles.push({ x: ((tx % n) + n) % n, y: ty, dx: tx * TILE - left, dy: ty * TILE - top });
    }
  }
  return tiles;
}

/** A "nice" scale bar length (10, 20, 50, 100 … m) of roughly a quarter of the image width. */
export function scaleBar(mpp, size) {
  const target = (size / 4) * mpp;
  const pow = 10 ** Math.floor(Math.log10(target));
  const meters = [1, 2, 5, 10].map((f) => f * pow).filter((m) => m <= target).pop() || pow;
  return { meters, pixels: meters / mpp };
}

export function loadTileImage(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // required so the canvas can be exported afterwards
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

/** Draw the camera's field of view as a wedge from the centre (north is up). */
function drawViewWedge(ctx, c, size, { bearing_deg: bearing, fov_deg: fov = 60 }) {
  const r = size * 0.75;
  const a0 = ((bearing - fov / 2 - 90) * Math.PI) / 180;
  const a1 = ((bearing + fov / 2 - 90) * Math.PI) / 180;
  ctx.fillStyle = "rgba(255,146,43,0.18)";
  ctx.strokeStyle = "rgba(255,146,43,0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.arc(c, c, r, a0, a1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const mid = ((bearing - 90) * Math.PI) / 180;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c + Math.cos(mid) * r, c + Math.sin(mid) * r);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Thin grid lines every gridM metres from the crosshair, labelled in metres east (O) / north (N). */
function drawMetreGrid(ctx, c, size, mpp) {
  const gridM = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find((g) => g / mpp >= size / 9) ?? 5000;
  const step = gridM / mpp;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.font = "10px sans-serif";
  for (let k = -Math.floor(c / step); k <= Math.floor(c / step); k++) {
    if (k === 0) continue;
    const p = c + k * step;
    ctx.beginPath();
    ctx.moveTo(p, 0); ctx.lineTo(p, size);
    ctx.moveTo(0, p); ctx.lineTo(size, p);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(p + 2, size - 58, 44, 13);
    ctx.fillRect(2, p - 13, 44, 13);
    ctx.fillStyle = "#fff";
    ctx.fillText(`${k > 0 ? "+" : ""}${k * gridM} O`, p + 4, size - 48);
    ctx.fillText(`${k < 0 ? "+" : ""}${-k * gridM} N`, 4, p - 3);
  }
  ctx.restore();
  return gridM;
}

/** Render a size×size JPEG of the area around (lat, lon) with crosshair, metre grid, scale bar and north arrow. */
export async function renderMapView({ lat, lon, zoom, layer = "satellit", size = 768, view = null }) {
  const source = TILE_SOURCES[layer] ?? TILE_SOURCES.satellit;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#777";
  ctx.fillRect(0, 0, size, size);
  const tiles = tilesFor(lat, lon, zoom, size);
  const images = await Promise.all(tiles.map((t) => loadTileImage(source.url(zoom, t.x, t.y))));
  if (!images.some(Boolean)) throw new Error(`${layer === "satellit" ? "Luftbild" : "Karte"} konnte nicht geladen werden.`);
  tiles.forEach((t, i) => images[i] && ctx.drawImage(images[i], t.dx, t.dy, TILE, TILE));

  const mpp = metersPerPixel(lat, zoom);
  const c = size / 2;
  const gridM = drawMetreGrid(ctx, c, size, mpp);
  if (view && Number.isFinite(view.bearing_deg)) drawViewWedge(ctx, c, size, view);
  // Crosshair on the queried point.
  ctx.strokeStyle = "#ff1744";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(c - 18, c); ctx.lineTo(c - 5, c); ctx.moveTo(c + 5, c); ctx.lineTo(c + 18, c);
  ctx.moveTo(c, c - 18); ctx.lineTo(c, c - 5); ctx.moveTo(c, c + 5); ctx.lineTo(c, c + 18);
  ctx.stroke();
  // Scale bar.
  const bar = scaleBar(mpp, size);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(10, size - 38, bar.pixels + 20, 28);
  ctx.fillStyle = "#fff";
  ctx.fillRect(20, size - 20, bar.pixels, 4);
  ctx.font = "bold 13px sans-serif";
  ctx.fillText(`${bar.meters} m`, 22, size - 25);
  // North arrow.
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(size - 42, 10, 32, 40);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(size - 26, 16); ctx.lineTo(size - 34, 32); ctx.lineTo(size - 18, 32);
  ctx.fill();
  ctx.fillText("N", size - 31, 46);
  // Attribution.
  ctx.font = "10px sans-serif";
  const w = ctx.measureText(source.attribution).width;
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fillRect(size - w - 10, size - 16, w + 8, 14);
  ctx.fillStyle = "#222";
  ctx.fillText(source.attribution, size - w - 6, size - 5);

  let data;
  try {
    data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  } catch {
    throw new Error("Das Kartenbild wurde vom Browser blockiert (fehlende CORS-Freigabe des Kartendienstes).");
  }
  const thumb = document.createElement("canvas");
  thumb.width = 240;
  thumb.height = 240;
  thumb.getContext("2d").drawImage(canvas, 0, 0, 240, 240);
  return { data, width: size, height: size, metersPerPixel: mpp, spanM: mpp * size, gridM, thumbnail: thumb.toDataURL("image/jpeg", 0.8) };
}

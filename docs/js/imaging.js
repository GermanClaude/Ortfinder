// Image decoding, resizing and zoom crops in the browser (canvas).

export const MODEL_MAX_SIDE = 1600; // overview sent to the model
export const ZOOM_MIN_SIDE = 1024; // crops are upscaled to at least this long side
export const ZOOM_MAX_SIDE = 1536;
export const ZOOM_MIN_SOURCE_PX = 24; // smallest crop in source pixels

const isHeic = (file) => /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || "");

let heicLoader = null;
function loadHeic2any() {
  // 1.3 MB library, only fetched when a HEIC file needs converting.
  heicLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("../vendor/heic2any.min.js", import.meta.url).href;
    script.onload = () => resolve(window.heic2any);
    script.onerror = () => reject(new Error("HEIC-Konverter konnte nicht geladen werden"));
    document.head.append(script);
  });
  return heicLoader;
}

/** Decode a File/Blob into an ImageBitmap with EXIF orientation applied. */
export async function decodeImage(file) {
  // Older browsers reject unknown options, so retry without; both apply EXIF orientation by default.
  for (const options of [{ imageOrientation: "from-image" }, undefined]) {
    try {
      return await createImageBitmap(file, options);
    } catch {
      // try the next variant
    }
  }
  if (!isHeic(file)) throw new Error("Das ist kein lesbares Bild (unterstützt: JPEG, PNG, WebP, HEIC, …).");
  const heic2any = await loadHeic2any();
  const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 });
  return createImageBitmap(Array.isArray(converted) ? converted[0] : converted);
}

function canvas(width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

export function fitSize(width, height, maxSide) {
  if (Math.max(width, height) <= maxSide) return [width, height];
  const scale = maxSide / Math.max(width, height);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

const toBase64 = (c, quality = 0.9) => c.toDataURL("image/jpeg", quality).split(",")[1];

function drawScaled(source, sx, sy, sw, sh, w, h) {
  const c = canvas(w, h);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return c;
}

/** JPEG (base64 + data URL) of the whole image, fitted to maxSide. */
export function overview(source, maxSide = MODEL_MAX_SIDE) {
  const [w, h] = fitSize(source.width, source.height, maxSide);
  const c = drawScaled(source, 0, 0, source.width, source.height, w, h);
  const data = toBase64(c);
  return { data, width: w, height: h, dataUrl: `data:image/jpeg;base64,${data}` };
}

/**
 * The photo for the model with a 0–1 ruler in a margin around it (ticks every 0.05, labels every 0.1), so
 * it can aim zooms and name photo positions without a second, gridded copy of the picture. The ruler sits
 * outside the photo, so no detail is covered; 0–1 refers to the photo itself.
 */
export function rulerOverview(source, maxSide = MODEL_MAX_SIDE, margin = 22) {
  const [w, h] = fitSize(source.width, source.height, maxSide);
  const c = canvas(w + 2 * margin, h + 2 * margin);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, source.width, source.height, margin, margin, w, h);
  ctx.strokeStyle = "#ffd54a";
  ctx.fillStyle = "#ffd54a";
  ctx.font = "bold 11px sans-serif";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const long = i % 2 === 0;
    const x = margin + t * w;
    const y = margin + t * h;
    const len = long ? 9 : 5;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, margin - len); ctx.lineTo(x + 0.5, margin);
    ctx.moveTo(x + 0.5, margin + h); ctx.lineTo(x + 0.5, margin + h + len);
    ctx.moveTo(margin - len, y + 0.5); ctx.lineTo(margin, y + 0.5);
    ctx.moveTo(margin + w, y + 0.5); ctx.lineTo(margin + w + len, y + 0.5);
    ctx.stroke();
    if (!long || i === 0 || i === 20) continue;
    const label = t.toFixed(1).slice(1); // ".1" … ".9" keeps the labels inside the narrow margin
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(label, x, 1);
    ctx.textBaseline = "bottom";
    ctx.fillText(label, x, c.height - 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 1, y);
    ctx.textAlign = "right";
    ctx.fillText(label, c.width - 1, y);
  }
  return { data: toBase64(c), width: c.width, height: c.height, photoWidth: w, photoHeight: h };
}

/** Overlay a labelled 0.0-1.0 grid so the model can aim its zoom requests. */
export function gridImage(source, maxSide = 1024, divisions = 10) {
  const [w, h] = fitSize(source.width, source.height, maxSide);
  const c = drawScaled(source, 0, 0, source.width, source.height, w, h);
  const ctx = c.getContext("2d");
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "top";
  for (let i = 1; i < divisions; i++) {
    const x = Math.round((w * i) / divisions);
    const y = Math.round((h * i) / divisions);
    ctx.strokeStyle = "rgba(255,0,80,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
    const label = (i / divisions).toFixed(1);
    for (const [px, py] of [[x + 2, 2], [2, y + 2]]) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(px, py, 22, 13);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, px + 2, py + 1);
    }
  }
  return { data: toBase64(c, 0.85), width: w, height: h };
}

/** Pixel box for a normalized box, grown around its centre to at least ZOOM_MIN_SOURCE_PX per side. */
export function pixelBox(box, width, height) {
  const axis = (lo, hi, size) => {
    let start = Math.round(lo * size);
    let end = Math.round(hi * size);
    const minimum = Math.min(ZOOM_MIN_SOURCE_PX, size);
    if (end - start < minimum) {
      const centre = (start + end) / 2;
      start = Math.min(Math.max(Math.round(centre - minimum / 2), 0), size - minimum);
      end = start + minimum;
    }
    return [start, end];
  };
  const [left, right] = axis(box[0], box[2], width);
  const [top, bottom] = axis(box[1], box[3], height);
  return [left, top, right, bottom];
}

/**
 * Crop `box` (normalized) from the full-resolution image and enlarge it for reading small details – only
 * enlarged (smooth scaling), never edited: no contrast, no sharpening, nothing added.
 */
export function zoomCrop(source, box) {
  const [left, top, right, bottom] = pixelBox(box, source.width, source.height);
  const sw = right - left;
  const sh = bottom - top;
  let scale = Math.max(1, ZOOM_MIN_SIDE / Math.max(sw, sh));
  scale = Math.min(scale, ZOOM_MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = drawScaled(source, left, top, sw, sh, w, h);
  const [tw, th] = fitSize(w, h, 360);
  const thumb = drawScaled(c, 0, 0, w, h, tw, th);
  return {
    data: toBase64(c, 0.85),
    width: w,
    height: h,
    sourceWidth: sw,
    sourceHeight: sh,
    thumbnail: thumb.toDataURL("image/jpeg", 0.8),
  };
}

/**
 * A zoom crop sharpened by the AI upscaler (sharpen.js; opt-in only, it can invent details): `sharpen(rgb, w, h)`
 * returns the checked result. Falls back to the plain crop (with the reason) when the check fails or the crop
 * is large. Returns what zoomCrop returns plus { ai: { applied, reason, stats }, aiImage (when applied) }.
 */
export async function sharpenedZoomCrop(source, box, sharpen) {
  const [left, top, right, bottom] = pixelBox(box, source.width, source.height);
  const sw = right - left;
  const sh = bottom - top;
  const plain = () => zoomCrop(source, box);
  let res;
  try {
    const px = drawScaled(source, left, top, sw, sh, sw, sh).getContext("2d").getImageData(0, 0, sw, sh).data;
    const rgb = new Uint8ClampedArray(sw * sh * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      rgb[j] = px[i];
      rgb[j + 1] = px[i + 1];
      rgb[j + 2] = px[i + 2];
    }
    res = await sharpen(rgb, sw, sh);
  } catch (err) {
    return { ...plain(), ai: { applied: false, reason: `KI-Schärfung nicht möglich (${err.message})` } };
  }
  if (!res.ok) return { ...plain(), ai: { applied: false, reason: res.reason, stats: res.stats } };
  const big = canvas(res.width, res.height);
  const data = new ImageData(res.width, res.height);
  for (let i = 0, j = 0; j < res.rgb.length; i += 4, j += 3) {
    data.data[i] = res.rgb[j];
    data.data[i + 1] = res.rgb[j + 1];
    data.data[i + 2] = res.rgb[j + 2];
    data.data[i + 3] = 255;
  }
  big.getContext("2d").putImageData(data, 0, 0);
  // Same size as a plain crop.
  let scale = Math.max(1, ZOOM_MIN_SIDE / Math.max(sw, sh));
  scale = Math.min(scale, ZOOM_MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = drawScaled(big, 0, 0, res.width, res.height, w, h);
  const [tw, th] = fitSize(w, h, 360);
  const [vw, vh] = fitSize(w, h, 900);
  return {
    data: toBase64(c, 0.85),
    width: w,
    height: h,
    sourceWidth: sw,
    sourceHeight: sh,
    thumbnail: drawScaled(c, 0, 0, w, h, tw, th).toDataURL("image/jpeg", 0.8),
    aiImage: drawScaled(c, 0, 0, w, h, vw, vh).toDataURL("image/jpeg", 0.85),
    ai: { applied: true, reason: "", stats: res.stats },
  };
}

/**
 * High-resolution 2×2 tiles of a large photo, sent with the first request so small details are
 * readable without extra zoom rounds. Returns [] when the overview already shows nearly everything.
 */
export function detailTiles(source, minSide = 2000) {
  if (Math.max(source.width, source.height) < minSide) return [];
  const names = [["oben links", "oben rechts"], ["unten links", "unten rechts"]];
  const tiles = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      // Slight overlap so objects on the seams stay whole in one tile.
      const box = [Math.max(0, col * 0.5 - 0.04), Math.max(0, row * 0.5 - 0.04), Math.min(1, col * 0.5 + 0.54), Math.min(1, row * 0.5 + 0.54)];
      const [left, top, right, bottom] = pixelBox(box, source.width, source.height);
      const [w, h] = fitSize(right - left, bottom - top, ZOOM_MAX_SIDE);
      const c = drawScaled(source, left, top, right - left, bottom - top, w, h);
      tiles.push({ name: names[row][col], box, data: toBase64(c, 0.85) });
    }
  }
  return tiles;
}

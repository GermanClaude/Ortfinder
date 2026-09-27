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

function sharpen(c, amount = 0.6) {
  const ctx = c.getContext("2d");
  const { width: w, height: h } = c;
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const centre = s[i + ch];
        const up = y > 0 ? s[i - w * 4 + ch] : centre;
        const down = y < h - 1 ? s[i + w * 4 + ch] : centre;
        const left = x > 0 ? s[i - 4 + ch] : centre;
        const right = x < w - 1 ? s[i + 4 + ch] : centre;
        const laplace = 4 * centre - up - down - left - right;
        d[i + ch] = Math.max(0, Math.min(255, centre + amount * laplace));
      }
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/** Crop `box` (normalized) from the full-resolution image and upscale it for reading small details. */
export function zoomCrop(source, box, enhance = false) {
  const [left, top, right, bottom] = pixelBox(box, source.width, source.height);
  const sw = right - left;
  const sh = bottom - top;
  let scale = Math.max(1, ZOOM_MIN_SIDE / Math.max(sw, sh));
  scale = Math.min(scale, ZOOM_MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = drawScaled(source, left, top, sw, sh, w, h);
  if (enhance) {
    const ctx = c.getContext("2d");
    const tmp = drawScaled(c, 0, 0, w, h, w, h);
    ctx.filter = "contrast(1.3) saturate(1.1)";
    ctx.drawImage(tmp, 0, 0);
    ctx.filter = "none";
    sharpen(c);
  }
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

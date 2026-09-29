// Careful AI sharpening of zoom crops: ESRGAN-slim ×4 (UpscalerJS, MIT) run in the browser with TensorFlow.js.
// An AI upscaler can invent details (a letter, a window) that were never in the photo. So it is used only
//  - when the AI analysing the photo says it is sure what the detail shows (the tool asks for that), and
//  - when the result, shrunk back to the original size, still matches the original at least as well as a
//    plain enlargement does – overall and in every small block. Invented content fails that check and the
//    sharpened image is thrown away.
// The model and TensorFlow.js (~2 MB) are loaded only the first time a crop is sharpened.

export const SR_SCALE = 4;
export const SR_MAX_SOURCE = 256; // longer crops already have enough pixels; the AI gets them as they are
export const MIN_CERTAINTY = 0.9;
const BLOCK = 4; // original pixels per side of the blocks checked one by one
const MIN_PSNR = 25; // dB, the sharpened image shrunk back vs the original
const SLACK_DB = 0.5; // may be this much less faithful than a plain enlargement overall …
const BLOCK_SLACK_DB = 2; // … and in its worst block

const psnr = (mse) => (mse <= 1e-9 ? 99 : 10 * Math.log10((255 * 255) / mse));

/** Plain bilinear enlargement by k (pixel centres aligned), RGB. */
export function bilinearUp(rgb, w, h, k) {
  const W = w * k;
  const H = h * k;
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(Math.max((y + 0.5) / k - 0.5, 0), h - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, h - 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(Math.max((x + 0.5) / k - 0.5, 0), w - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, w - 1);
      const tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = rgb[(y0 * w + x0) * 3 + c] * (1 - tx) + rgb[(y0 * w + x1) * 3 + c] * tx;
        const b = rgb[(y1 * w + x0) * 3 + c] * (1 - tx) + rgb[(y1 * w + x1) * 3 + c] * tx;
        out[(y * W + x) * 3 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  return out;
}

/** Shrink by k with area averaging (what a camera sensor would have recorded), RGB. */
export function boxDown(rgb, W, H, k) {
  const w = Math.floor(W / k);
  const h = Math.floor(H / k);
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h * k; y++) {
    for (let x = 0; x < w * k; x++) {
      const o = (Math.floor(y / k) * w + Math.floor(x / k)) * 3;
      const i = (y * W + x) * 3;
      out[o] += rgb[i];
      out[o + 1] += rgb[i + 1];
      out[o + 2] += rgb[i + 2];
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= k * k;
  return out;
}

/**
 * How faithfully an enlargement (W×H = k·w × k·h) reproduces the original (w×h) when shrunk back:
 * PSNR overall and in the worst block of BLOCK×BLOCK original pixels.
 */
export function consistency(big, small, w, h, k) {
  const down = boxDown(big, w * k, h * k, k);
  let total = 0;
  let worst = Infinity;
  for (let by = 0; by < h; by += BLOCK) {
    for (let bx = 0; bx < w; bx += BLOCK) {
      let sum = 0;
      let n = 0;
      for (let y = by; y < Math.min(by + BLOCK, h); y++) {
        for (let x = bx; x < Math.min(bx + BLOCK, w); x++) {
          for (let c = 0; c < 3; c++) {
            const d = down[(y * w + x) * 3 + c] - small[(y * w + x) * 3 + c];
            sum += d * d;
            n += 1;
          }
        }
      }
      total += sum;
      worst = Math.min(worst, psnr(sum / n));
    }
  }
  return { psnr: psnr(total / (w * h * 3)), worst };
}

/** Accept the sharpened image only if it is at least about as faithful as a plain enlargement. */
export function judge(sr, plain) {
  if (sr.psnr < MIN_PSNR) return { ok: false, reason: `verkleinert weicht es zu stark vom Original ab (${sr.psnr.toFixed(1)} dB)` };
  if (sr.psnr < plain.psnr - SLACK_DB) return { ok: false, reason: "es gibt das Original schlechter wieder als eine normale Vergrößerung" };
  if (sr.worst < plain.worst - BLOCK_SLACK_DB) return { ok: false, reason: "eine Stelle weicht deutlich vom Original ab (möglicherweise erfundenes Detail)" };
  return { ok: true, reason: "" };
}

/**
 * The upscaler: TensorFlow.js and the model are loaded on first use. `tf` and `fetchImpl` can be given
 * (tests); `base` is where model.json and its weights are.
 */
export function createSharpener({ tf = null, fetchImpl = globalThis.fetch?.bind(globalThis), base = new URL("../vendor/esrgan-slim-x4/", import.meta.url).href } = {}) {
  let ready = null;
  const load = () => {
    ready ??= (async () => {
      const lib = tf || (await import("../vendor/tfjs/tf.fesm.min.js"));
      await lib.ready();
      const json = await (await fetchImpl(`${base}model.json`)).json();
      const manifest = json.weightsManifest[0];
      const weightData = await (await fetchImpl(`${base}${manifest.paths[0]}`)).arrayBuffer();
      const model = await lib.loadLayersModel(lib.io.fromMemory({ modelTopology: json.modelTopology, weightSpecs: manifest.weights, weightData }));
      return { lib, model };
    })().catch((err) => {
      ready = null; // try again next time (network)
      throw err;
    });
    return ready;
  };
  return {
    /** RGB (0–255) w×h → RGB 4w×4h (Float32Array). */
    async upscale(rgb, w, h) {
      const { lib, model } = await load();
      const out = lib.tidy(() => model.predict(lib.tensor4d(Float32Array.from(rgb), [1, h, w, 3])).clipByValue(0, 255));
      try {
        return await out.data();
      } finally {
        out.dispose();
      }
    },
  };
}

/**
 * Sharpen an RGB crop (w×h, 0–255) ×4 and check it. Returns { ok, rgb, width, height, stats, reason };
 * rgb is the sharpened image when ok.
 */
export async function sharpenPixels({ rgb, w, h, upscale }) {
  if (Math.max(w, h) > SR_MAX_SOURCE) {
    return { ok: false, reason: `der Ausschnitt hat schon genug Bildpunkte (${w}×${h}) – KI-Schärfung nur bis ${SR_MAX_SOURCE} px` };
  }
  if (Math.min(w, h) < 4) return { ok: false, reason: "der Ausschnitt ist zu klein" };
  const sr = await upscale(rgb, w, h);
  const plain = bilinearUp(rgb, w, h, SR_SCALE);
  const small = Float32Array.from(rgb);
  const a = consistency(sr, small, w, h, SR_SCALE);
  const b = consistency(plain, small, w, h, SR_SCALE);
  const verdict = judge(a, b);
  const stats = { psnr: round1(a.psnr), worst: round1(a.worst), plain_psnr: round1(b.psnr), plain_worst: round1(b.worst) };
  if (!verdict.ok) return { ok: false, reason: verdict.reason, stats };
  return { ok: true, rgb: Uint8ClampedArray.from(sr, (v) => Math.round(v)), width: w * SR_SCALE, height: h * SR_SCALE, stats, reason: "" };
}

const round1 = (v) => Math.round(v * 10) / 10;

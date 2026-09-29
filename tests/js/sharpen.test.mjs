import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

import { SR_MAX_SOURCE, bilinearUp, consistency, createSharpener, judge, sharpenPixels } from "../../docs/js/sharpen.js";

// The vendored TensorFlow.js bundle looks for require() when it runs in Node.
globalThis.require ??= createRequire(import.meta.url);
const tf = await import("../../docs/vendor/tfjs/tf.fesm.min.js");
const MODEL = new URL("../../docs/vendor/esrgan-slim-x4/", import.meta.url);
const fileFetch = async (url) => {
  const bytes = readFileSync(new URL(url));
  return { json: async () => JSON.parse(bytes.toString()), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};

/** A small, slightly blurred "sign": white bars and blocks on blue, like lettering seen from afar. */
function sign(w = 40, h = 16) {
  const sharp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const letter = y >= 4 && y < 12 && x >= 3 && x < w - 3 && (x % 5 === 0 || x % 5 === 1 || ((x % 5 === 2 || x % 5 === 3) && (y === 4 || y === 7 || y === 11)));
      sharp.set(letter ? [245, 245, 245] : [25, 60, 150], (y * w + x) * 3);
    }
  }
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = Math.min(Math.max(y + dy, 0), h - 1);
            const xx = Math.min(Math.max(x + dx, 0), w - 1);
            const wgt = dx === 0 && dy === 0 ? 4 : 1;
            s += sharp[(yy * w + xx) * 3 + c] * wgt;
            n += wgt;
          }
        }
        out[(y * w + x) * 3 + c] = Math.round(s / n);
      }
    }
  }
  return out;
}

test("the check: a faithful enlargement passes, one with an invented detail fails", () => {
  const w = 40;
  const h = 16;
  const small = sign(w, h);
  const plain = bilinearUp(small, w, h, 4);
  const good = consistency(plain, small, w, h, 4);
  assert.ok(good.psnr > 30, `${good.psnr}`);
  const invented = Float32Array.from(plain);
  for (let y = 20; y < 36; y++) for (let x = 60; x < 76; x++) invented.set([255, 0, 0], (y * w * 4 + x) * 3);
  const bad = consistency(invented, small, w, h, 4);
  assert.ok(bad.worst < good.worst - 10, "the altered block stands out");
  assert.equal(judge(good, good).ok, true);
  const verdict = judge(bad, good);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /weicht|schlechter/);
});

test("ESRGAN-slim ×4 runs locally and passes the check on a small sign; an inventing upscaler is rejected", async () => {
  const sharpener = createSharpener({ tf, fetchImpl: fileFetch, base: MODEL.href });
  const rgb = sign();
  const res = await sharpenPixels({ rgb, w: 40, h: 16, upscale: sharpener.upscale });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.width, 160);
  assert.equal(res.height, 64);
  assert.equal(res.rgb.length, 160 * 64 * 3);
  assert.ok(res.stats.psnr >= res.stats.plain_psnr - 0.5, JSON.stringify(res.stats));
  // A "sharpener" that paints something that was not there.
  const inventing = async (src, w, h) => {
    const out = bilinearUp(src, w, h, 4);
    for (let y = 8; y < 24; y++) for (let x = 100; x < 116; x++) out.set([255, 255, 0], (y * w * 4 + x) * 3);
    return out;
  };
  const rejected = await sharpenPixels({ rgb, w: 40, h: 16, upscale: inventing });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.rgb, undefined, "nothing of it is used");
  // Large crops already have enough pixels.
  const big = await sharpenPixels({ rgb: new Float32Array(300 * 20 * 3), w: 300, h: 20, upscale: inventing });
  assert.equal(big.ok, false);
  assert.match(big.reason, new RegExp(`bis ${SR_MAX_SOURCE} px`));
});

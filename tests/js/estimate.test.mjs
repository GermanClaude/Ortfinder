import assert from "node:assert/strict";
import { test } from "node:test";

import { TILES_MARK } from "../../docs/js/compact.js";
import {
  PLAN, PRICES, TEXT_PROFILE, TYPICAL_ROUNDS, actualAverage, estimateAnalysis, formatMoney, formatTokens, gptImageTokens, photoParts, planFor, recordActual,
  recordUse, usedToday,
} from "../../docs/js/estimate.js";
import { ROUNDS_NOW, fakeJpeg, measureAll } from "./token-scenario.mjs";

test("the estimate matches the typical analysis played through each service's real request code", async () => {
  // A 3200×2400 photo gives exactly the pictures the scenario sends (overview 1644×1244, tiles 1536×1152).
  assert.deepEqual(photoParts(3200, 2400), { overview: [1644, 1244], tiles: Array(4).fill([1536, 1152]) });
  const images = [
    { type: "image", mime_type: "image/jpeg", data: fakeJpeg(1644, 1244), resolution: "high" },
    { type: "text", text: TILES_MARK },
    ...[0, 1, 2, 3].flatMap((i) => [{ type: "text", text: `Detail-Kachel ${i}:` }, { type: "image", mime_type: "image/jpeg", data: fakeJpeg(1536, 1152), resolution: "high" }]),
  ];
  const measured = await measureAll({ intro: "Bestimme, wo dieses Foto aufgenommen wurde. Originalauflösung: 4000×3000 Pixel. ".repeat(3), images, rounds: ROUNDS_NOW });
  for (const [provider, model, key] of [["gemini", "gemini-3.8-flash", "gemini"], ["puter", "gemini-3.8-flash", "puter"], ["openrouter", "x:free", "openrouter"], ["claude", "claude-opus-5", "claude"]]) {
    const est = estimateAnalysis({ provider, model, width: 3200, height: 2400, rounds: TYPICAL_ROUNDS });
    const real = measured[key].perRequest.map((r) => r.total);
    est.plan.forEach((r, i) => {
      const off = Math.abs(r.input - real[i]) / real[i];
      assert.ok(off < 0.05, `${provider} Runde ${r.round}: geschätzt ${r.input}, gemessen ${real[i]} – Profil in estimate.js nachziehen`);
    });
  }
});

test("plans: a shorter budget ends with the result, a longer one keeps reserve rounds; costs from the price list", () => {
  assert.equal(planFor(5).length, 5);
  assert.equal(planFor(5).at(-1), PLAN.at(-1));
  assert.equal(planFor(12).length, 12);
  const est = estimateAnalysis({ provider: "gemini", model: "gemini-3.8-flash", width: 1600, height: 1000, rounds: 10 });
  assert.equal(est.tiles, 0, "small photos have no detail tiles");
  assert.deepEqual([est.typical.rounds, est.max.rounds], [7, 10]);
  assert.deepEqual(est.plan.slice(7).map((r) => r.reserve), [true, true, true]);
  assert.ok(est.max.input > est.typical.input);
  const expected = (est.typical.input * 0.75 + est.typical.output * 3.75) / 1e6;
  assert.ok(Math.abs(est.cost.typical - expected) < 1e-9);
  const high = estimateAnalysis({ provider: "gemini", model: "gemini-3.8-flash", thinking: "high", width: 1600, height: 1000, rounds: 10 });
  assert.ok(high.typical.output > est.typical.output, "more thinking, more tokens received");
  // Claude: its cached repeats cost a tenth – a third of the raw input overall.
  const claude = estimateAnalysis({ provider: "claude", model: "claude-opus-5", width: 3200, height: 2400, rounds: 7 });
  assert.ok(Math.abs(claude.cost.typical - (claude.typical.input * 0.33 * 5 + claude.typical.output * 25) / 1e6) < 1e-9);
  // Groq takes at most three pictures per request; unknown models have no price.
  const groq = estimateAnalysis({ provider: "groq", model: "qwen/qwen3.8-27b", width: 3200, height: 2400, rounds: 7 });
  assert.ok(groq.plan[0].input < TEXT_PROFILE.chat[0] + 3 * 2048 + 1, `${groq.plan[0].input}`);
  assert.equal(estimateAnalysis({ provider: "custom", model: "irgendwas", width: 800, height: 600, rounds: 7 }).cost, null);
  assert.equal(estimateAnalysis({ provider: "poe", model: "gemini-3.8-flash", width: 800, height: 600, rounds: 7, prices: [0.76, 3.79] }).cost.price[0], 0.76);
  assert.ok(Object.values(PRICES).every(([i, o]) => i > 0 && o >= i), "output never cheaper than input");
  // OpenAI's own example: 1024×1024 is scaled down to 768×768 → 2×2 tiles; small pictures are not enlarged.
  assert.equal(gptImageTokens(1024, 1024), 765);
  assert.equal(gptImageTokens(512, 512), 255);
});

test("free limits counted in this browser, and the actual use of the last analyses", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(usedToday(storage, "gemini:gemini-3.8-flash", "2026-09-29"), 0);
  recordUse(storage, "gemini:gemini-3.8-flash", "2026-09-29", 7);
  recordUse(storage, "gemini:gemini-3.8-flash", "2026-09-29", 3);
  assert.equal(usedToday(storage, "gemini:gemini-3.8-flash", "2026-09-29"), 10);
  recordUse(storage, "gemini:gemini-3.8-flash", "2026-09-30", 2);
  assert.equal(usedToday(storage, "gemini:gemini-3.8-flash", "2026-09-30"), 2);
  assert.deepEqual(Object.keys(JSON.parse(store.get("ortfinder.usage.v1"))), ["2026-09-30"], "older days are dropped");
  assert.equal(actualAverage(storage, "gemini:gemini-3.8-flash"), null);
  recordActual(storage, "gemini:gemini-3.8-flash", { requests: 6, input_tokens: 70000, output_tokens: 3000, thought_tokens: 9000 });
  recordActual(storage, "gemini:gemini-3.8-flash", { requests: 8, input_tokens: 90000, output_tokens: 4000, thought_tokens: 11000 });
  assert.deepEqual(actualAverage(storage, "gemini:gemini-3.8-flash"), { count: 2, rounds: 7, input: 80000, output: 13500 });
  assert.equal(usedToday({ getItem: () => "{kaputt" }, "x", "d"), 0);
  recordUse({ getItem: () => null, setItem: () => { throw new Error("voll"); } }, "x", "d", 1);
  assert.deepEqual([formatTokens(950), formatTokens(84300), formatTokens(1250000)], ["950", "84 Tsd.", "1,3 Mio."]);
  assert.deepEqual([formatMoney(0.004), formatMoney(0.109), formatMoney(1.5)], ["unter 1 Cent", "ca. 11 Cent", "ca. 1,50 $"]);
});

test("'Oberflächen zuerst' shows in the plan and costs its instruction and one top view", () => {
  const base = estimateAnalysis({ provider: "gemini", model: "gemini-3.8-flash", width: 4000, height: 3000, rounds: 7 });
  const surf = estimateAnalysis({ provider: "gemini", model: "gemini-3.8-flash", width: 4000, height: 3000, rounds: 7, surfaceFirst: true });
  assert.match(surf.plan[0].steps, /^Oberflächen → Draufsicht/);
  assert.equal(surf.plan[1].input - base.plan[1].input, surf.plan[2].input - base.plan[2].input + 1120, "round 2 carries the top view");
  assert.ok(surf.plan[2].input - base.plan[2].input > 50 && surf.plan[2].input - base.plan[2].input < 150, "the instruction");
  assert.ok(surf.typical.output > base.typical.output);
});

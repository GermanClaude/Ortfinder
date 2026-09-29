import assert from "node:assert/strict";
import { test } from "node:test";

import { backgroundRelief, reliefWorthMatching } from "../../docs/js/skyline.js";

/** A sky line as extractSkyline returns it: row per column (width 800, height 600). */
const skyLine = (rowAt, from = 0, to = 800) => {
  const xs = [];
  const ys = [];
  for (let x = from; x < to; x++) {
    xs.push(x + 0.5);
    ys.push(rowAt(x));
  }
  return { width: 800, height: 600, count: xs.length, x: Float32Array.from(xs), y: Float32Array.from(ys), w: new Float32Array(xs.length).fill(1) };
};

test("hills against the sky are worth matching; a flat sea horizon or a short stretch are not", () => {
  const hills = backgroundRelief(skyLine((x) => 260 + 40 * Math.sin(x / 90)), 66);
  assert.ok(hills.coverage > 0.99 && hills.reliefDeg > 5 && hills.roughDeg < 0.2, JSON.stringify(hills));
  assert.equal(reliefWorthMatching(hills), true);
  const sea = backgroundRelief(skyLine(() => 300), 66);
  assert.ok(sea.reliefDeg < 0.1);
  assert.equal(reliefWorthMatching(sea), false);
  assert.equal(reliefWorthMatching(backgroundRelief(skyLine((x) => 260 + 40 * Math.sin(x / 90), 0, 150), 66)), false, "too little of the width");
  assert.equal(backgroundRelief({ width: 800, height: 600, count: 3, x: [], y: [], w: [] }, 66), null);
  // Low, gentle hills (about 1.5°) still count.
  assert.equal(reliefWorthMatching(backgroundRelief(skyLine((x) => 300 + 6 * Math.sin(x / 120)), 66)), true);
});

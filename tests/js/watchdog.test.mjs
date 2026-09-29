import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_STALLS, STALL_MS, StallError, stallLimit, stallNote, watch } from "../../docs/js/watchdog.js";

const later = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

test("an answer in time passes through; none at all is a stall that aborts the request", async () => {
  assert.equal(await watch(() => later(10, "ok"), 200), "ok");
  let seen = null;
  const started = Date.now();
  await assert.rejects(watch((signal) => new Promise(() => { signal.addEventListener("abort", () => { seen = signal.reason; }); }), 60), (err) => {
    assert.ok(err instanceof StallError && err.ms === 60);
    return true;
  });
  assert.ok(Date.now() - started >= 55);
  assert.ok(seen instanceof StallError, "the request's signal was aborted");
  // Errors of the request itself are passed on unchanged; a late failure of a dropped request is ignored.
  await assert.rejects(watch(async () => { throw new TypeError("Failed to fetch"); }, 200), /Failed to fetch/);
  await assert.rejects(watch(() => later(80).then(() => { throw new Error("zu spät"); }), 20), StallError);
  await later(100);
});

test("streams stay alive as long as data keeps coming", async () => {
  const stream = (signal, alive) => new Promise((resolve) => {
    let n = 0;
    const tick = setInterval(() => {
      alive();
      if (++n === 6) {
        clearInterval(tick);
        resolve(n);
      }
    }, 25);
  });
  assert.equal(await watch(stream, 60), 6, "150 ms in total, but never 60 ms without data");
});

test("cancelling the analysis ends the wait at once, even for requests that cannot be aborted", async () => {
  const outer = new AbortController();
  const started = Date.now();
  setTimeout(() => outer.abort(), 20);
  await assert.rejects(watch(() => new Promise(() => {}), 5000, outer.signal), (err) => err.name === "AbortError");
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(watch(() => later(10), 5000, outer.signal), (err) => err.name === "AbortError", "already cancelled");
});

test("limits: 50 s, longer for slow models and for every retry", () => {
  assert.equal(STALL_MS, 50000);
  assert.equal(stallLimit(0, 0), 50000);
  assert.equal(stallLimit(20000, 0), 50000);
  assert.equal(stallLimit(60000, 0), 90000, "a model that needed 60 s before gets 90 s");
  assert.equal(stallLimit(0, 2), 150000);
  assert.equal(MAX_STALLS, 3);
  assert.equal(stallNote(new StallError(50000), 1), "Die KI gibt seit 50 s kein Lebenszeichen – Ortfinder fragt dieselbe Runde neu an (Versuch 2 von 4) …");
});

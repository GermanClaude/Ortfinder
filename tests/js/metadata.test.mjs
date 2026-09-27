import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { extractMetadata, hintsForModel } from "../../docs/js/metadata.js";

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

test("GPS, time and camera are read from EXIF", async () => {
  const meta = await extractMetadata(fixture("gps.jpg"));
  assert.equal(meta.has_exif, true);
  assert.ok(Math.abs(meta.gps.lat - -33.8568) < 1e-4);
  assert.ok(Math.abs(meta.gps.lon - 151.2153) < 1e-4);
  assert.equal(meta.gps.direction_deg, 123.5);
  assert.equal(meta.taken_at, "2024:06:21 14:30:00");
  assert.equal(meta.utc_offset, "+02:00");
  assert.equal(meta.camera_model, "Model X");
});

test("images without EXIF", async () => {
  assert.deepEqual(await extractMetadata(fixture("plain.png")), { has_exif: false });
  assert.deepEqual(await extractMetadata(new Uint8Array([1, 2, 3])), { has_exif: false });
});

test("hints never contain the GPS position", async () => {
  const hints = hintsForModel(await extractMetadata(fixture("gps.jpg"))).join("\n");
  assert.match(hints, /2024:06:21 14:30:00/);
  assert.match(hints, /UTC-Offset \+02:00/);
  assert.doesNotMatch(hints, /33\.8|151\.2/);
});

test("HEIC (iPhone format): GPS is found even when exifr can't walk the container", async () => {
  const meta = await extractMetadata(fixture("gps.heic"));
  assert.equal(meta.camera_model, "iPhone 15");
  assert.deepEqual(meta.gps, { lat: 47.99, lon: 7.85 });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addExactHeights, heightCorrection, inSwitzerland, learnSwissHeights, lv95ToWgs84, parseProfile, swissHeight, swissHeights, swissProfile, wgs84ToLv95,
} from "../../docs/js/swiss.js";
import { Terrain } from "../../docs/js/terrain.js";

const LAT = 46.62;
const LON = 7.9;
const KX = 111195 * Math.cos((LAT * Math.PI) / 180);

test("Swiss coordinates: swisstopo's worked example and the way back", () => {
  // swisstopo, "Approximate formulas": 46° 2' 38.87" N, 8° 43' 49.79" E → E 2 699 999.76, N 1 099 999.97.
  const [e, n] = wgs84ToLv95(46 + 2 / 60 + 38.87 / 3600, 8 + 43 / 60 + 49.79 / 3600);
  assert.ok(Math.abs(e - 2699999.76) < 0.5 && Math.abs(n - 1099999.97) < 0.5, `${e} ${n}`);
  const [lat, lon] = lv95ToWgs84(...wgs84ToLv95(LAT, LON));
  assert.ok(Math.abs(lat - LAT) < 2e-5 && Math.abs(lon - LON) < 2e-5, `${lat} ${lon}`);
  assert.ok(inSwitzerland(LAT, LON) && inSwitzerland(47.14, 9.52) && !inSwitzerland(48.14, 11.58) && !inSwitzerland(45.46, 9.19));
});

test("heights from swisstopo: one request per point, cached, failures give null", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url.includes("easting=2") ? { ok: true, json: async () => ({ height: "617.8" }) } : { ok: false, status: 400 };
  };
  assert.equal(await swissHeight(fetchImpl, 46.61, 7.91), 617.8);
  assert.match(urls[0], /^https:\/\/api3\.geo\.admin\.ch\/rest\/services\/height\?easting=26\d{5}\.\d&northing=11\d{5}\.\d&sr=2056$/);
  assert.equal(await swissHeight(fetchImpl, 46.61, 7.91), 617.8);
  assert.equal(urls.length, 1, "cached");
  assert.deepEqual(await swissHeights(async () => { throw new Error("offline"); }, [{ lat: 46.5, lon: 7.5 }, { lat: 46.6, lon: 7.6 }]), [null, null]);
  // Profiles: the 2 m model's heights, converted back to WGS84.
  let body = null;
  const profile = await swissProfile(async (url, init) => {
    body = new URLSearchParams(init.body);
    return { ok: true, json: async () => [{ easting: 2600000, northing: 1200000, alts: { DTM2: 548.2, COMB: 548 } }, { easting: 2600010, northing: 1200000, alts: {} }] };
  }, [[46.9, 7.4], [46.95, 7.45]], 99999);
  assert.equal(body.get("nb_points"), "5000");
  assert.equal(JSON.parse(body.get("geom")).coordinates.length, 2);
  assert.equal(profile.length, 1);
  assert.ok(Math.abs(profile[0].lat - 46.95108) < 1e-4 && Math.abs(profile[0].lon - 7.43864) < 1e-4 && profile[0].h === 548.2);
  assert.deepEqual(parseProfile({ error: "x" }), []);
});

test("exact heights correct the terrain model nearby and fade out further away", () => {
  // The model is 8 m too high at the camera and right 200 m east of it.
  const model = { tiles: new Map([["a", 1]]), modelElevation: () => 625.9, elevation: Terrain.prototype.elevation };
  const at = (east, north = 0) => [LAT + north / 111195, LON + east / KX];
  const fix = heightCorrection(model, [{ lat: LAT, lon: LON, h: 617.9 }, { lat: at(200)[0], lon: at(200)[1], h: 625.9 }]);
  assert.ok(Math.abs(fix(LAT, LON) + 8) < 0.01);
  assert.ok(Math.abs(fix(...at(200))) < 0.01);
  assert.ok(fix(...at(40)) < -6 && fix(...at(100)) < -2 && fix(...at(100)) > -6, `${fix(...at(40))} ${fix(...at(100))}`);
  assert.equal(fix(...at(0, 600)), 0, "far from all exact heights nothing changes");
  assert.equal(model.elevation(LAT, LON), 625.9, "not taught yet");
  assert.equal(addExactHeights(model, [{ lat: LAT, lon: LON, h: 617.9 }, { lat: LAT, lon: LON, h: 617.9 }, { lat: 47, lon: 8, h: NaN }]), 1);
  assert.ok(Math.abs(model.elevation(LAT, LON) - 617.9) < 0.01);
  assert.equal(addExactHeights(model, [{ lat: at(200)[0], lon: at(200)[1], h: 625.9 }]), 2);
  assert.ok(Math.abs(model.elevation(...at(200)) - 625.9) < 0.01);
});

test("learning Swiss heights asks swisstopo only inside Switzerland", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ height: 1000.5 }) };
  };
  const terrain = { tiles: new Map(), modelElevation: () => 990, elevation: Terrain.prototype.elevation };
  assert.equal(await learnSwissHeights(terrain, fetchImpl, [{ lat: 48.14, lon: 11.58 }]), 0);
  assert.equal(await learnSwissHeights(terrain, null, [{ lat: 46.3, lon: 7.3 }]), 0);
  assert.equal(calls, 0);
  assert.equal(await learnSwissHeights(terrain, fetchImpl, [{ lat: 46.3, lon: 7.3 }, { lat: 48.14, lon: 11.58 }]), 1);
  assert.equal(calls, 1);
  assert.ok(Math.abs(terrain.elevation(46.3, 7.3) - 1000.5) < 0.01);
});

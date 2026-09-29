import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEM_COARSE, DEM_FINE, LocalDem, columnSector, demTiles, dropAt, envelopeHorizon, extractSkyline, fitStats, geoDirect, geoInverse, horizonAt,
  matchConfidence, mergeHorizon, mergePeaks, overlayLines, overpassPeakQuery, parseOsmPeaks, parseWikidataPeaks, peakLabel, peaksInView,
  pickLabels, refinePose, ridgePointsFromProfiles, searchOrientation, searchPosition, sectorPolygon, shiftPad, skylineConstraint, skylineResiduals, skylineSummits,
  traceHorizon, wikidataPeakQuery,
} from "../../docs/js/skyline.js";
import { makeCamera } from "../../docs/js/scene3d.js";

const LAT = 46.4;
const LON = 9.1;
const DEG = Math.PI / 180;
const [LAT2, LON2] = [46.533493, 10.387526]; // GeographicLib reference for the geodesy test
const KX = 111195 * Math.cos(LAT * DEG);

// Synthetic Alps: bell-shaped mountains [azimuth °, distance m, summit m, width m] around the centre.
const MOUNTAINS = [[40, 3200, 1500, 900], [70, 9000, 2400, 1800], [85, 5200, 1900, 1100], [100, 24000, 3900, 3500], [118, 14000, 2900, 2000], [220, 6000, 2000, 1500]];
const PEAKS = MOUNTAINS.map(([az, d, h, w], i) => ({ name: `Berg ${i + 1}`, e: d * Math.sin(az * DEG), n: d * Math.cos(az * DEG), h, w }));
const elevation = (lat, lon) => {
  const e = (lon - LON) * KX;
  const n = (lat - LAT) * 111195;
  let z = 600;
  for (const p of PEAKS) z += (p.h - 600) * Math.exp(-(((e - p.e) ** 2 + (n - p.n) ** 2) / (p.w * p.w)));
  return z;
};
const peakList = PEAKS.map((p) => ({ name: p.name, lat: LAT + p.n / 111195, lon: LON + p.e / KX, ele: Math.round(elevation(LAT + p.n / 111195, LON + p.e / KX)), source: "OSM" }));

/** A photo of the synthetic mountains: blue sky above the terrain horizon, noisy green below. */
function synthPhoto(dem, truth, { width = 480, height = 320 } = {}) {
  const h = traceHorizon(dem, { e: truth.e, n: truth.n, eyeZ: dem.height(truth.e, truth.n) + truth.eye, az0: 0, count: 7200, stepDeg: 0.05 });
  const cam = makeCamera({ bearingDeg: truth.bearing, pitchDeg: truth.pitch, rollDeg: truth.roll, fovDeg: truth.fov, width, height });
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = (x + 0.5 - width / 2) / cam.fpx;
      const b = (height / 2 - y - 0.5) / cam.fpx;
      const d = [0, 1, 2].map((i) => cam.f[i] + a * cam.r[i] + b * cam.u[i]);
      const hz = horizonAt(h, Math.atan2(d[0], d[1]) / DEG);
      const sky = !hz || Math.atan2(d[2], Math.hypot(d[0], d[1])) / DEG > hz.el;
      const t = y / height;
      const c = sky ? [0.35 + 0.35 * t, 0.55 + 0.25 * t, 0.95] : [0.25 + 0.1 * Math.sin(x * 0.3) + 0.09 * rnd(), 0.35 + 0.09 * rnd(), 0.2 + 0.06 * rnd()];
      const i = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = 255 * (c[k] + 0.03 * rnd());
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

// Built once: the fine grid for the eastern view, as the browser would build it.
const fine = new LocalDem({ lat: LAT, lon: LON, elevation, levels: DEM_FINE, maxDistM: 40000, sector: { center: 85, half: 40 }, shiftM: 600 });
const TRUTH = { e: 150, n: 80, eye: 1.6, bearing: 82, pitch: 4, roll: 1.2, fov: 48 };
const obs = extractSkyline(synthPhoto(fine, TRUTH));

test("geodesy matches the WGS84 ellipsoid (GeographicLib reference values)", () => {
  // GeographicLib Direct: (46.4, 9.1) azimuth 81°, 100 km → 46.533493°, 10.387526°
  const [lat, lon] = geoDirect(46.4, 9.1, 81, 100000);
  assert.ok(geoInverse(lat, lon, LAT2, LON2).distance < 5, `${lat}, ${lon}`);
  const back = geoInverse(46.4, 9.1, LAT2, LON2);
  assert.ok(Math.abs(back.distance - 100000) < 5 && Math.abs(back.azimuth - 81) < 0.003, JSON.stringify(back));
  // Across the dateline, southern hemisphere: 50 km at 100° from (-33.9, 179.9) → -33.977123°, -179.567148°.
  const [la2, lo2] = geoDirect(-33.9, 179.9, 100, 50000);
  assert.ok(geoInverse(la2, lo2, -33.977123, -179.567148).distance < 2, `${la2}, ${lo2}`);
  const r = geoInverse(-33.9, 179.9, -33.977123, -179.567148);
  assert.ok(Math.abs(r.distance - 50000) < 2 && Math.abs(r.azimuth - 100) < 0.002, JSON.stringify(r));
});

test("horizon angles include curvature and refraction", () => {
  // One lone summit of 3000 m, 40 km north; the eye at 600 m.
  const far = (lat, lon) => {
    const e = (lon - LON) * KX;
    const n = (lat - LAT) * 111195 - 40000;
    return 600 + 2400 * Math.exp(-((e * e + n * n) / 1500 ** 2));
  };
  const dem = new LocalDem({ lat: LAT, lon: LON, elevation: far, levels: DEM_COARSE, maxDistM: 60000, sector: { center: 0, half: 10 } });
  const h = traceHorizon(dem, { eyeZ: 600, az0: -5, count: 101, stepDeg: 0.1 });
  const top = horizonAt(h, 0);
  const expected = Math.atan((3000 - 600 - dropAt(40000)) / 40000) / DEG;
  assert.ok(Math.abs(top.el - expected) < 0.05, `${top.el} vs ${expected}`);
  assert.ok(Math.abs(top.dist - 40000) < 400, `distance ${top.dist}`);
  assert.ok(dropAt(40000) > 100 && dropAt(40000) < 125, "≈109 m lower at 40 km");
  assert.ok(horizonAt(h, 4).el < top.el - 1, "lower beside the summit");
});

test("finds the sky/land line in the photo to about a pixel", () => {
  assert.ok(obs.count > 0.9 * obs.width, `columns ${obs.count}`);
  const h = traceHorizon(fine, { e: TRUTH.e, n: TRUTH.n, eyeZ: fine.height(TRUTH.e, TRUTH.n) + TRUTH.eye, az0: 40, count: 1500, stepDeg: 0.05 });
  const r = [...skylineResiduals(obs, h, TRUTH)].filter((v) => v === v).map(Math.abs).sort((a, b) => a - b);
  const degPerPx = TRUTH.fov / obs.width;
  assert.ok(r[r.length >> 1] < 1.2 * degPerPx, `median ${r[r.length >> 1]}°`);
  // No sky → no skyline.
  const grey = { width: 60, height: 40, data: new Uint8ClampedArray(60 * 40 * 4).fill(90) };
  assert.equal(extractSkyline(grey).count, 0);
});

test("all-round search finds the viewing direction; refinement gets it to a fraction of a degree", () => {
  const coarse = new LocalDem({ lat: LAT, lon: LON, elevation, levels: DEM_COARSE, maxDistM: 40000 });
  const h = traceHorizon(coarse, { eyeZ: coarse.height(0, 0) + 1.6, az0: 0, count: 3600, stepDeg: 0.1 });
  const cands = searchOrientation(obs, h, { fovDeg: 55 });
  assert.ok(Math.abs(cands[0].bearing - 82) < 2, `bearing ${cands[0].bearing}`);
  assert.ok(cands[0].cost < cands[1].cost - 0.5, "clearly better than the next direction");
  const pose = refinePose(obs, h, cands[0], { sigmaPx: 2.5, fovHint: 55 });
  // Assumed standpoint 170 m off: still within 0.6° / 2°.
  assert.ok(Math.abs(pose.bearing - 82) < 0.6 && Math.abs(pose.pitch - 4) < 0.6 && Math.abs(pose.fov - 48) < 2, JSON.stringify(pose));
});

test("standpoint search: near ridges shift against far ones and give the position away", () => {
  const sec = columnSector(obs, { bearing: 81.5, pitch: 4, roll: 1, fov: 47 }, shiftPad(600));
  const h = traceHorizon(fine, { eyeZ: fine.height(0, 0) + 1.6, az0: sec.center - sec.half, count: Math.ceil((2 * sec.half) / 0.04) + 1, stepDeg: 0.04 });
  const start = refinePose(obs, h, { bearing: 81.5, pitch: 4, roll: 1, fov: 47 }, { sigmaPx: 1.2, fovHint: 55 });
  const pos = searchPosition(fine, obs, start, { radiusM: 600, sigmaPx: 1.2, fovHint: 55, stepDeg: 0.04, maxDistM: 40000 });
  assert.ok(Math.hypot(pos.e - 150, pos.n - 80) < 25, `found ${pos.e}, ${pos.n}`);
  assert.ok(pos.uncertaintyM < 120, `uncertainty ${pos.uncertaintyM}`);
  const p = pos.pose;
  assert.ok(Math.abs(p.bearing - 82) < 0.15 && Math.abs(p.pitch - 4) < 0.15 && Math.abs(p.roll - 1.2) < 0.3 && Math.abs(p.fov - 48) < 0.3, JSON.stringify(p));
  const hf = traceHorizon(fine, { e: pos.e, n: pos.n, eyeZ: pos.ground + pos.hEye, az0: sec.center - sec.half, count: Math.ceil((2 * sec.half) / 0.04) + 1, stepDeg: 0.04, ridges: true });
  const stats = fitStats(obs, hf, p, 1.2);
  assert.ok(stats.inlierShare > 0.9 && stats.reliefDeg > 3, JSON.stringify({ ...stats, residuals: undefined }));
  const conf = matchConfidence({ bestCost: 0.3, secondCost: 1.5, inlierShare: stats.inlierShare, reliefDeg: stats.reliefDeg, coverage: 1, nEff: stats.nEff });
  assert.ok(conf.confidence > 0.9, JSON.stringify(conf));

  // Peaks: the three in the view, with true distance and direction, on the skyline or in front of it.
  const peaks = peaksInView(fine, peakList, { e: pos.e, n: pos.n, eyeZ: pos.ground + pos.hEye }, p, { width: 480, height: 320, horizon: hf });
  assert.deepEqual(peaks.map((q) => q.name), ["Berg 2", "Berg 3", "Berg 4"]);
  const b3 = peaks[1];
  const d3 = Math.hypot(PEAKS[2].e - 150, PEAKS[2].n - 80);
  assert.ok(Math.abs(b3.distance_m - d3) < 30, `distance ${b3.distance_m} vs ${d3}`);
  assert.ok(Math.abs(b3.bearing_deg - Math.atan2(PEAKS[2].e - 150, PEAKS[2].n - 80) / DEG) < 0.1);
  assert.ok(b3.on_skyline, "Berg 3 forms the skyline");
  assert.match(peakLabel(b3), /^Berg 3 1\.\d{3} m · 5,\d km$/);
  // Lines for drawing lie inside the photo; the summits of the terrain skyline are found.
  const lines = overlayLines(hf, p, 480, 320);
  assert.ok(lines.skyline.length >= 1 && lines.skyline.flat().every(([x, y]) => x >= -0.01 && x <= 1.01 && y >= -0.01 && y <= 1.01));
  const tops = skylineSummits(hf, { from: 60, to: 105 });
  assert.ok(tops.some((t) => Math.abs(t.az - b3.bearing_deg) < 0.5), JSON.stringify(tops));
});

test("a small peak hidden behind a big one is not labelled", () => {
  const hidden = { name: "Versteckt", lat: LAT + (PEAKS[2].n * 1.25) / 111195, lon: LON + (PEAKS[2].e * 1.25) / KX, ele: 1500, source: "OSM" };
  const cam = { e: 0, n: 0, eyeZ: fine.height(0, 0) + 1.6 };
  const pose = { bearing: 85, pitch: 4, roll: 0, fov: 50 };
  const names = peaksInView(fine, [...peakList, hidden], cam, pose, { width: 480, height: 320 }).map((p) => p.name);
  assert.ok(names.includes("Berg 3") && !names.includes("Versteckt"), names.join());
});

test("peak data: Overpass and Wikidata parsing, merging, label choice", () => {
  const poly = sectorPolygon(LAT, LON, { center: 90, half: 20 }, 50000);
  assert.equal(poly.length, 10);
  const q = overpassPeakQuery(poly);
  assert.match(q, /node\["natural"~"\^\(peak\|volcano\|hill\)\$"\]\["name"\]\(poly:"46\.40000 9\.10000 /);
  const osm = parseOsmPeaks({ elements: [
    { type: "node", lat: 46.6, lon: 7.9, tags: { natural: "peak", name: "Harder", ele: "1323 m" } },
    { type: "node", lat: 46.61, lon: 7.91, tags: { natural: "peak", name: "Ohne Höhe" } },
    { type: "way", tags: { name: "kein Punkt" } },
  ] });
  assert.deepEqual(osm.map((p) => [p.name, p.ele]), [["Harder", 1323], ["Ohne Höhe", null]]);
  const wd = parseWikidataPeaks({ results: { bindings: [
    { itemLabel: { value: "Harder" }, coord: { value: "Point(7.9001 46.6002)" }, ele: { value: "1322" } },
    { itemLabel: { value: "Ohne Höhe" }, coord: { value: "Point(7.9103 46.6101)" }, ele: { value: "1990" } },
    { itemLabel: { value: "Q12345" }, coord: { value: "Point(8 46)" } },
  ] } });
  assert.equal(wd.length, 2);
  const merged = mergePeaks(osm, wd);
  assert.deepEqual(merged.map((p) => [p.name, p.ele, p.source]), [["Harder", 1323, "OSM"], ["Ohne Höhe", 1990, "OSM"]]);
  assert.match(wikidataPeakQuery(46, 7, 47, 8), /Point\(7\.0000 46\.0000\)/);
  const many = Array.from({ length: 10 }, (_, i) => ({ name: i % 2 ? `P${i}` : "", x: 0.5 + i * 0.001, ele_m: 2000 + i, distance_m: 5000, on_skyline: true }));
  const picked = pickLabels(many, 1000);
  assert.equal(picked.length, 1, "labels closer than 16 px collapse to one");
  assert.ok(picked[0].name, "named peaks win");
});

test("tile plan: only the viewing sector, zoom lowered where a level would need too many tiles", () => {
  const all = demTiles({ lat: LAT, lon: LON, levels: DEM_COARSE, maxDistM: 200000 });
  const sector = demTiles({ lat: LAT, lon: LON, levels: DEM_FINE, sector: { center: 80, half: 25 }, maxDistM: 30000 });
  assert.ok(sector.keys.length < all.keys.length, `${sector.keys.length} vs ${all.keys.length}`);
  assert.ok(all.levels.every((l) => l.zoom <= DEM_COARSE.find((c) => c.half === l.half)?.zoom));
  assert.ok(sector.levels.length === 3, "no 220 km level for a 30 km view");
  const zooms = new Set(sector.keys.map((k) => Number(k.split("/")[0])));
  assert.ok(zooms.has(14) && zooms.has(12) && zooms.has(10), [...zooms].join());
});

test("skyline + a few ground points: the resection finds standpoint and height (the 'exact house' step)", async () => {
  const { solveCamera } = await import("../../docs/js/resection.js");
  const { groundModel, localProjection } = await import("../../docs/js/scene3d.js");
  // Photo from a 30 m tower, 150 m east / 80 m north of the grid centre.
  const truth = { e: 150, n: 80, eye: 30, bearing: 82, pitch: -3, roll: 0.8, fov: 48 };
  const photo = synthPhoto(fine, truth);
  const sky = extractSkyline(photo);
  const [lat, lon] = fine.toLatLon(truth.e, truth.n);
  const eyeZ = fine.height(truth.e, truth.n) + truth.eye;
  const sec = columnSector(sky, truth, 4);
  const h = traceHorizon(fine, { e: truth.e, n: truth.n, eyeZ, az0: sec.center - sec.half, count: Math.ceil((2 * sec.half) / 0.04) + 1, stepDeg: 0.04 });
  const skyline = { ...skylineConstraint({ dem: fine, horizon: h, camera: { e: truth.e, n: truth.n, eyeZ }, obs: sky, sigmaPx: 1.2, nEff: 12 }), pose: truth };

  // Four ground points in a narrow cluster (too few to fix the standpoint on their own).
  const terrain = { available: true, elevation };
  const g = groundModel({ lat, lon, eyeHeight: truth.eye, terrain });
  const cam = makeCamera({ bearingDeg: truth.bearing, pitchDeg: truth.pitch, rollDeg: truth.roll, fovDeg: truth.fov, width: 480, height: 320 });
  const proj = localProjection(lat, lon);
  const points = [[160, -8], [220, 3], [300, 9], [420, -2]].map(([d, off]) => {
    const a = (truth.bearing + off) * DEG;
    const [x, y] = [d * Math.sin(a), d * Math.cos(a)];
    const [u, v] = cam.project(cam.toCam([x, y, g.groundZ(x, y, d)]));
    const [pla, plo] = proj.toLatLon(x, y);
    return { x: u / 480, y: v / 320, lat: pla, lon: plo, height_m: 0 };
  });
  assert.ok(points.every((p) => p.x > 0 && p.x < 1 && p.y > 0.5 && p.y < 1), JSON.stringify(points));
  const [slat, slon] = proj.toLatLon(-30, 25); // assumed standpoint 39 m off, height guessed 20 m
  const base = { points, width: 480, height: 320, lat: slat, lon: slon, eyeHeight: 20, fovDeg: 55, terrain, positionSigmaM: 60 };
  const alone = solveCamera(base);
  const joint = solveCamera({ ...base, skyline });
  const off = (s) => { const [x, y] = proj.toXY(s.camera.lat, s.camera.lon); return Math.hypot(x, y); };
  assert.ok(joint.solved_position, "with the skyline three or four points are enough for the standpoint");
  assert.ok(off(joint) < 8, `standpoint off by ${off(joint).toFixed(1)} m`);
  assert.ok(Math.abs(joint.camera.eye_height_m - 30) < 4, `height ${joint.camera.eye_height_m}`);
  assert.ok(Math.abs(joint.view.bearing_deg - 82) < 0.2 && Math.abs(joint.view.fov_deg - 48) < 0.6, JSON.stringify(joint.view));
  assert.ok(joint.skyline_share > 0.9, `skyline share ${joint.skyline_share}`);
  assert.ok(off(joint) < off(alone), `joint ${off(joint).toFixed(1)} m vs points alone ${off(alone).toFixed(1)} m`);
});

test("exact ridge heights (e.g. swisstopo profiles) replace the model's along the skyline", async () => {
  const eyeZ = fine.height(TRUTH.e, TRUTH.n) + TRUTH.eye;
  const [az0, stepDeg, count] = [60, 0.1, 400];
  const h = traceHorizon(fine, { e: TRUTH.e, n: TRUTH.n, eyeZ, az0, count, stepDeg, ridges: true });
  // The "exact" terrain is 25 m higher; the service samples the polyline evenly.
  const calls = [];
  const profile = async (line, nb) => {
    calls.push(nb);
    const xy = line.map(([la, lo]) => fine.toLocal(la, lo));
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    const out = [];
    for (let k = 0, j = 1; k < nb; k++) {
      const s = (cum.at(-1) * k) / (nb - 1);
      while (j < xy.length - 1 && cum[j] < s) j++;
      const t = cum[j] > cum[j - 1] ? (s - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0;
      const [la, lo] = fine.toLatLon(xy[j - 1][0] + t * (xy[j][0] - xy[j - 1][0]), xy[j - 1][1] + t * (xy[j][1] - xy[j - 1][1]));
      out.push({ lat: la, lon: lo, h: elevation(la, lo) + 25 });
    }
    return out;
  };
  const rp = await ridgePointsFromProfiles({ dem: fine, horizon: h, camera: { e: TRUTH.e, n: TRUTH.n, eyeZ }, profile });
  assert.equal(calls.length, 3, "crest and 40 m in front of and behind it");
  assert.ok(rp.samples > 100 && rp.minDistM > 0);
  const merged = mergeHorizon(h, envelopeHorizon(rp.points, TRUTH.e, TRUTH.n, eyeZ, az0, count, stepDeg, rp.minDistM));
  const off = [];
  for (let i = 0; i < count; i++) {
    if (h.el[i] === h.el[i] && h.dist[i]) off.push(merged.el[i] - h.el[i] - Math.atan2(25, h.dist[i]) / DEG);
  }
  off.sort((a, b) => a - b);
  assert.ok(off.length > 0.8 * count, `${off.length} bins`);
  assert.ok(Math.abs(off[off.length >> 1]) < 0.05, `median ${off[off.length >> 1]}`);
});

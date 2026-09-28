// 3D reconstruction of a place from OpenStreetMap (buildings with heights, streets, trees) plus the
// terrain model: perspective renders to compare with the photo, and the exact area a camera sees.

import { zoomForDistance } from "./terrain.js";

const DEG = Math.PI / 180;
const EARTH_R = 6371000;
const M_PER_DEG = 111195;
const REFRACTION = 0.87; // atmospheric refraction lifts distant terrain a little
const NEAR = 0.3;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Flat east/north metres around (lat0, lon0); accurate to well under 1 % within a few dozen km. */
export function localProjection(lat0, lon0) {
  const ky = M_PER_DEG;
  const kx = M_PER_DEG * Math.cos(lat0 * DEG);
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

// ---------- OpenStreetMap scene ----------

/** "12", "12 m", "12,5m" or "40 ft" → metres. */
export function parseLength(value) {
  if (value == null) return null;
  const m = String(value).trim().replace(",", ".").match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|')?/i);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] && /ft|'/i.test(m[2]) ? 0.3048 : 1);
  return Number.isFinite(n) ? n : null;
}

const TYPE_HEIGHT = {
  house: 8, detached: 8, semidetached_house: 8, terrace: 9, residential: 10, apartments: 16, bungalow: 4, cabin: 4,
  garage: 3, garages: 3, shed: 3, hut: 3, carport: 3, kiosk: 3, roof: 5, service: 3, greenhouse: 4, container: 3,
  farm_auxiliary: 7, barn: 8, stable: 6, church: 18, cathedral: 30, chapel: 8, mosque: 15, temple: 10, synagogue: 12,
  commercial: 14, retail: 8, supermarket: 7, office: 18, industrial: 9, warehouse: 9, school: 12, university: 16,
  hospital: 20, hotel: 18, train_station: 12, stadium: 20, tower: 30, transformer_tower: 6, parking: 10, public: 12,
  civic: 12, government: 15, castle: 18, ruins: 5, bridge: 6,
};

/** Height and base height of a building from its OSM tags; `estimated` when only the type was known. */
export function buildingHeights(tags) {
  let height = parseLength(tags.height) ?? parseLength(tags["building:height"]);
  const levels = parseFloat(tags["building:levels"]);
  const roofLevels = parseFloat(tags["roof:levels"]) || 0;
  let estimated = false;
  if (height == null && levels > 0) height = (levels + roofLevels) * 3.1 + (tags["roof:shape"] && tags["roof:shape"] !== "flat" ? 2.5 : 0.5);
  if (height == null) {
    height = TYPE_HEIGHT[tags["building:part"] || tags.building] ?? 9;
    estimated = true;
  }
  height = clamp(height, 2, 900);
  const minLevel = parseFloat(tags["building:min_level"]);
  const minHeight = clamp(parseLength(tags.min_height) ?? (minLevel > 0 ? minLevel * 3.1 : 0), 0, height - 0.5);
  return { height, minHeight, estimated };
}

const ROAD_WIDTH = {
  motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8, unclassified: 6, residential: 6, living_street: 5,
  service: 4, pedestrian: 6, track: 3, busway: 4, footway: 2, path: 2, cycleway: 2, steps: 2, bridleway: 2,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
};

function roadWidth(tags) {
  const lanes = parseFloat(tags.lanes);
  if (lanes > 0 && lanes < 20) return lanes * 3.2;
  return parseLength(tags.width) ?? ROAD_WIDTH[tags.highway] ?? 5;
}

function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, oi] = ring[i];
    const [aj, oj] = ring[j];
    if ((oi > lon) !== (oj > lon) && lat < ((aj - ai) * (lon - oi)) / (oj - oi) + ai) inside = !inside;
  }
  return inside;
}

/** Outlines that have building:parts inside are drawn through their parts (OSM 3D convention). */
function hideOutlinesWithParts(buildings) {
  const centers = buildings.filter((b) => b.part).map((b) => [
    b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length,
    b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length,
  ]);
  if (!centers.length) return;
  for (const b of buildings) {
    if (b.part) continue;
    const lats = b.ring.map((p) => p[0]);
    const lons = b.ring.map((p) => p[1]);
    const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    if (centers.some(([la, lo]) => la >= s && la <= n && lo >= w && lo <= e && pointInRing(la, lo, b.ring))) b.hidden = true;
  }
}

/** Overpass JSON (with geometry) → { buildings, roads, trees } in lat/lon. */
export function parseScene(data) {
  const buildings = [];
  const roads = [];
  const trees = [];
  for (const el of data?.elements || []) {
    const tags = el.tags || {};
    if (el.type === "node") {
      if (tags.natural === "tree" && Number.isFinite(el.lat)) trees.push({ lat: el.lat, lon: el.lon, height: clamp(parseLength(tags.height) ?? 9, 2, 40) });
      continue;
    }
    if (el.type === "way" && tags.highway && !tags.building && Array.isArray(el.geometry) && el.geometry.length > 1) {
      roads.push({ points: el.geometry.map((g) => [g.lat, g.lon]), width: roadWidth(tags), minor: (ROAD_WIDTH[tags.highway] ?? 5) <= 2 });
      continue;
    }
    const kind = tags["building:part"] || tags.building;
    if (!kind || kind === "no") continue;
    const rings = el.type === "way" ? [el.geometry] : (el.members || []).filter((m) => m.role === "outer").map((m) => m.geometry);
    const heights = buildingHeights(tags);
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 4) continue;
      const pts = ring.map((g) => [g.lat, g.lon]);
      const [first, last] = [pts[0], pts.at(-1)];
      if (first[0] !== last[0] || first[1] !== last[1]) continue; // piece of a larger outline
      pts.pop();
      buildings.push({ ring: pts, ...heights, kind, part: Boolean(tags["building:part"]), name: tags.name || "" });
    }
  }
  hideOutlinesWithParts(buildings);
  return { buildings, roads, trees };
}

/** Overpass query for everything within radiusM, snapped to a grid so nearby renders share one request. */
export function sceneQuery(lat, lon, radiusM = 500) {
  const cLat = Math.round(lat / 0.004) * 0.004;
  const gridLon = 0.004 / Math.max(Math.cos(cLat * DEG), 0.2);
  const cLon = Math.round(lon / gridLon) * gridLon;
  // Snapping moves the centre by at most ~315 m.
  const at = `(around:${Math.round(radiusM + 330)},${cLat.toFixed(5)},${cLon.toFixed(5)})`;
  return `[out:json][timeout:60];(way["building"]${at};way["building:part"]${at};relation["building"]${at};` +
    `way["highway"]${at};node["natural"="tree"]${at};);out body geom qt 9000;`;
}

const scenes = new Map();

/** Buildings, streets and trees around a point (one cached Overpass request per ~450 m grid cell). */
export function loadScene(osm, lat, lon, radiusM = 500) {
  const query = sceneQuery(lat, lon, radiusM);
  if (!scenes.has(query)) {
    scenes.set(query, osm.overpassRaw(query).then(parseScene).catch((err) => {
      scenes.delete(query);
      throw err;
    }));
  }
  return scenes.get(query);
}

// ---------- camera ----------

/** Pinhole camera looking along bearingDeg (clockwise from north), tilted by pitchDeg (up positive). */
export function makeCamera({ bearingDeg, pitchDeg = 0, fovDeg, width, height }) {
  const b = bearingDeg * DEG;
  const p = pitchDeg * DEG;
  const f = [Math.sin(b) * Math.cos(p), Math.cos(b) * Math.cos(p), Math.sin(p)];
  const r = [Math.cos(b), -Math.sin(b), 0];
  const u = [-Math.sin(b) * Math.sin(p), -Math.cos(b) * Math.sin(p), Math.cos(p)];
  const fpx = width / 2 / Math.tan((clamp(fovDeg, 1, 170) * DEG) / 2);
  return {
    f, r, u, fpx, width, height,
    /** World (east, north, up relative to the eye) → camera [right, up, depth]. */
    toCam: ([x, y, z]) => [x * r[0] + y * r[1] + z * r[2], x * u[0] + y * u[1] + z * u[2], x * f[0] + y * f[1] + z * f[2]],
    project: ([cx, cy, cz]) => [width / 2 + (cx / cz) * fpx, height / 2 - (cy / cz) * fpx],
  };
}

/** Clip a polygon in camera space to the part in front of the near plane (Sutherland–Hodgman). */
export function clipNear(poly, near = NEAR) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const aIn = a[2] >= near;
    if (aIn) out.push(a);
    if (aIn !== (b[2] >= near)) {
      const t = (near - a[2]) / (b[2] - a[2]);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), near]);
    }
  }
  return out;
}

/** Heights relative to the eye, including terrain, earth curvature and refraction. */
function groundModel({ lat, lon, eyeHeight, terrain }) {
  const proj = localProjection(lat, lon);
  const hasTerrain = Boolean(terrain?.available);
  const raw = (x, y, d) => {
    if (!hasTerrain) return null;
    const [la, lo] = proj.toLatLon(x, y);
    const e = terrain.elevation(la, lo, zoomForDistance(d));
    // Terrarium contains sea-floor depths; the visible surface there is the water.
    return e == null ? null : e < -15 ? 0 : e;
  };
  const ground0 = raw(0, 0, 0) ?? 0;
  const eyeZ = ground0 + eyeHeight;
  const drop = (d) => ((d * d) / (2 * EARTH_R)) * REFRACTION;
  return { proj, hasTerrain, ground0, eyeZ, drop, groundZ: (x, y, d) => (raw(x, y, d) ?? ground0) - eyeZ - drop(d) };
}

function signedArea2(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a;
}

/** Buildings in local coordinates with base/top heights relative to the eye. */
function prepareBuildings(scene, g, rangeM) {
  const out = [];
  for (const b of scene?.buildings || []) {
    if (b.hidden) continue;
    const ring = b.ring.map(([la, lo]) => g.proj.toXY(la, lo));
    let cx = 0;
    let cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    cx /= ring.length;
    cy /= ring.length;
    const radius = Math.max(...ring.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    const dist = Math.hypot(cx, cy);
    if (dist - radius > rangeM) continue;
    const base = g.groundZ(cx, cy, Math.max(dist, 1));
    out.push({ ring, cx, cy, radius, dist, zb: base + b.minHeight, zt: base + b.height, estimated: b.estimated, ccw: signedArea2(ring) > 0 });
  }
  return out;
}

// ---------- perspective render ----------

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, alpha = 1) => (alpha === 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`);
const HAZE = [184, 196, 212];
const GRASS = [128, 146, 96];
const ROCK = [146, 138, 128];
const SNOW = [238, 241, 245];
const WATER = [110, 140, 170];
const WALL = [222, 208, 184];
const ROOF = [150, 92, 78];
const LIGHT = (() => { const v = [-0.55, -0.65, 0.52]; const n = Math.hypot(...v); return v.map((x) => x / n); })();

/**
 * Draw the reconstructed view into a 2D canvas context. Returns statistics for the AI.
 * Everything is simple geometry: buildings are extruded footprints, the terrain is a height model.
 */
export function drawView(ctx, { width: W, height: H, lat, lon, bearingDeg, fovDeg, pitchDeg = 0, eyeHeight = 1.7, scene, terrain, maxDistM = 30000, buildingRangeM = 1500 }) {
  fovDeg = clamp(fovDeg, 5, 150);
  const cam = makeCamera({ bearingDeg, pitchDeg, fovDeg, width: W, height: H });
  const g = groundModel({ lat, lon, eyeHeight, terrain });
  const px = (c) => [W / 2 + (c[0] / c[2]) * cam.fpx, H / 2 - (c[1] / c[2]) * cam.fpx];

  // Sky down to the horizon.
  const hz = px(cam.toCam([Math.sin(bearingDeg * DEG) * 1e6, Math.cos(bearingDeg * DEG) * 1e6, 0]))[1];
  const sky = ctx.createLinearGradient(0, 0, 0, Math.max(hz, 1));
  sky.addColorStop(0, "#6f9fd2");
  sky.addColorStop(1, "#dde7f0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Terrain, column by column: paint every newly visible stretch, far terrain in haze. Colours are
  // elevation zones only (meadow, rock, snow), as orientation for comparing with the photo.
  const treeline = clamp(4200 - 42 * Math.abs(lat), 300, 4000); // rough: ~2250 m in the Alps
  const landColor = (e) => (Math.abs(e) < 0.5 ? WATER : e > treeline + 700 ? SNOW : e > treeline ? ROCK : GRASS);
  const crestCols = [];
  const colW = 2;
  let skylineMaxD = 0;
  for (let sx = 0; sx < W; sx += colW) {
    const az = bearingDeg * DEG + Math.atan((sx + colW / 2 - W / 2) / cam.fpx);
    const dx = Math.sin(az);
    const dy = Math.cos(az);
    const crests = [];
    let top = H;
    let open = false;
    let crest = null;
    let lastD = 0;
    for (let d = 1; d <= maxDistM; d += Math.max(0.5, d * 0.012)) {
      const z = g.groundZ(dx * d, dy * d, d);
      const c = cam.toCam([dx * d, dy * d, z]);
      if (c[2] < NEAR) continue;
      const sy = px(c)[1];
      if (sy < top) {
        if (crest && d - crest.d > Math.max(40, crest.d * 0.12)) crests.push(crest);
        crest = null;
        const land = g.hasTerrain ? landColor(z + g.eyeZ + g.drop(d)) : GRASS;
        ctx.fillStyle = rgb(mix(land, HAZE, 1 - Math.exp(-d / 6000)));
        ctx.fillRect(sx, sy, colW, top - sy + 0.6);
        top = sy;
        open = true;
        lastD = d;
      } else if (open) {
        crest = { x: sx, y: top, d: lastD };
        open = false;
      }
      if (top <= 0) break;
    }
    if (top < H && g.hasTerrain) {
      crests.push({ x: sx, y: top, d: lastD });
      skylineMaxD = Math.max(skylineMaxD, lastD);
    }
    crestCols.push(crests);
  }
  // Ridge lines: connect crests of neighbouring columns that belong to the same ridge.
  ctx.lineWidth = 1.4;
  crestCols.forEach((crests, i) => {
    for (const c of crests) {
      const prev = i ? crestCols[i - 1].find((p) => Math.abs(p.d - c.d) < Math.max(60, c.d * 0.15) && Math.abs(p.y - c.y) < 25) : null;
      ctx.strokeStyle = rgb(mix([40, 40, 40], [95, 108, 130], 1 - Math.exp(-c.d / 8000)), 0.9);
      ctx.beginPath();
      ctx.moveTo(prev ? prev.x + colW / 2 : c.x, prev ? prev.y : c.y);
      ctx.lineTo(c.x + colW / 2, c.y);
      ctx.stroke();
    }
  });

  const drawPoly = (pts, fill, stroke) => {
    const clipped = clipNear(pts.map(cam.toCam));
    if (clipped.length < 3) return false;
    const pp = clipped.map(px);
    const xs = pp.map((p) => p[0]);
    const ys = pp.map((p) => p[1]);
    if (Math.max(...xs) < 0 || Math.min(...xs) > W || Math.max(...ys) < 0 || Math.min(...ys) > H) return false;
    ctx.beginPath();
    pp.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    return true;
  };

  // Hidden behind a hill? (checked for things further away than a street block)
  const behindTerrain = (x, y, z, dist) => {
    if (!g.hasTerrain || dist < 80) return false;
    const target = z / dist;
    for (let i = 1; i < 40; i++) {
      const d = (dist * i) / 40;
      if (d > 20 && g.groundZ((x * d) / dist, (y * d) / dist, d) / d > target + 0.003) return true;
    }
    return false;
  };

  // Streets lie on the ground, so they go first.
  const roadRange = Math.min(buildingRangeM, 1200);
  for (const road of scene?.roads || []) {
    const pts = road.points.map(([la, lo]) => g.proj.toXY(la, lo));
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      const d1 = Math.hypot(x1, y1);
      const d2 = Math.hypot(x2, y2);
      if (Math.min(d1, d2) > roadRange) continue;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ox = (-(y2 - y1) / len) * (road.width / 2);
      const oy = ((x2 - x1) / len) * (road.width / 2);
      const z1 = g.groundZ(x1, y1, Math.max(d1, 1)) + 0.05;
      const z2 = g.groundZ(x2, y2, Math.max(d2, 1)) + 0.05;
      if (behindTerrain(x1, y1, z1, d1) && behindTerrain(x2, y2, z2, d2)) continue;
      drawPoly([[x1 + ox, y1 + oy, z1], [x2 + ox, y2 + oy, z2], [x2 - ox, y2 - oy, z2], [x1 - ox, y1 - oy, z1]], road.minor ? "#b9b1a3" : "#8a8a8c", null);
    }
  }

  // Walls, roofs and trees, far to near (painter's algorithm).
  const buildings = prepareBuildings(scene, g, buildingRangeM);
  const faces = [];
  for (const b of buildings) {
    if (behindTerrain(b.cx, b.cy, b.zt, b.dist)) continue;
    for (let i = 0; i < b.ring.length; i++) {
      const [x1, y1] = b.ring[i];
      const [x2, y2] = b.ring[(i + 1) % b.ring.length];
      const ex = x2 - x1;
      const ey = y2 - y1;
      const nx = b.ccw ? ey : -ey;
      const ny = b.ccw ? -ex : ex;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      if (nx * mx + ny * my >= 0) continue; // wall faces away from the camera
      const lambert = Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1]) / (Math.hypot(ex, ey) || 1));
      faces.push({
        depth: Math.hypot(mx, my),
        pts: [[x1, y1, b.zb], [x2, y2, b.zb], [x2, y2, b.zt], [x1, y1, b.zt]],
        fill: rgb(mix([96, 88, 76], WALL, 0.55 + 0.45 * lambert)),
        stroke: "rgba(55,45,35,0.75)",
        building: b,
      });
    }
    if (b.zt < 0) faces.push({ depth: b.dist + b.radius * 0.5, pts: b.ring.map(([x, y]) => [x, y, b.zt]), fill: rgb(ROOF), stroke: "rgba(60,30,25,0.8)", building: b });
  }
  for (const t of scene?.trees || []) {
    const [x, y] = g.proj.toXY(t.lat, t.lon);
    const dist = Math.hypot(x, y);
    if (dist > roadRange || dist < 1) continue;
    const base = g.groundZ(x, y, dist);
    if (behindTerrain(x, y, base + t.height, dist)) continue;
    faces.push({ depth: dist, tree: { x, y, base, height: t.height } });
  }
  faces.sort((a, b) => b.depth - a.depth);
  const drawn = new Set();
  for (const f of faces) {
    if (!f.tree) {
      if (drawPoly(f.pts, f.fill, f.stroke)) drawn.add(f.building);
      continue;
    }
    const { x, y, base, height } = f.tree;
    const crown = cam.toCam([x, y, base + height * 0.62]);
    const foot = cam.toCam([x, y, base]);
    if (crown[2] < NEAR || foot[2] < NEAR) continue;
    const [cx, cy] = px(crown);
    const [fx, fy] = px(foot);
    const r = ((height * 0.34) / crown[2]) * cam.fpx;
    if (cx + r < 0 || cx - r > W) continue;
    ctx.strokeStyle = "#5b4636";
    ctx.lineWidth = Math.max(1, r * 0.15);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.fillStyle = "rgba(62,110,52,0.92)";
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Compass scale along the top edge, horizon mark and centre.
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, W, 24);
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  const half = fovDeg / 2;
  for (let h = Math.ceil((bearingDeg - half) / 5) * 5; h <= bearingDeg + half; h += 5) {
    const x = W / 2 + Math.tan((h - bearingDeg) * DEG) * cam.fpx;
    const deg = ((h % 360) + 360) % 360;
    ctx.fillStyle = "#fff";
    ctx.fillRect(x - 0.5, deg % 10 === 0 ? 15 : 19, 1, deg % 10 === 0 ? 9 : 5);
    if (deg % 10 === 0) ctx.fillText(deg % 90 === 0 ? ["N", "O", "S", "W"][deg / 90] : `${deg}°`, x, 12);
  }
  ctx.strokeStyle = "rgba(255,23,68,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 10, H / 2);
  ctx.lineTo(W / 2 + 10, H / 2);
  ctx.moveTo(W / 2, H / 2 - 10);
  ctx.lineTo(W / 2, H / 2 + 10);
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.font = "11px sans-serif";
  const info = `3D-Nachbau · ${lat.toFixed(5)}, ${lon.toFixed(5)} · Blick ${Math.round(bearingDeg)}° · Bildfeld ${Math.round(fovDeg)}° · Augenhöhe ${eyeHeight} m`;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, H - 18, W, 18);
  ctx.fillStyle = "#fff";
  ctx.fillText(info, 6, H - 5);
  ctx.textAlign = "right";
  ctx.fillText("© OpenStreetMap · Gelände: Mapzen/AWS", W - 6, H - 5);

  const ahead = firstBuildingAhead(buildings, bearingDeg);
  const osmHeights = [...drawn].filter((b) => !b.estimated).length;
  return {
    buildings: drawn.size,
    heights_from_osm_pct: drawn.size ? Math.round((100 * osmHeights) / drawn.size) : 0,
    terrain: g.hasTerrain,
    ground_m: Math.round(g.ground0),
    building_ahead_m: ahead == null ? null : Math.round(ahead),
    skyline_distance_m: g.hasTerrain ? Math.round(skylineMaxD) : null,
  };
}

/** Browser: render the reconstruction as a JPEG (plus thumbnail). Missing data degrades gracefully. */
export async function renderViewImage({ osm, terrain, lat, lon, bearingDeg, fovDeg, pitchDeg = 0, eyeHeight = 1.6, aspect = 4 / 3, width = 768, maxDistM = 30000 }) {
  // Same aspect ratio as the photo, so both can be laid on top of each other.
  let height = Math.round(width / aspect);
  if (height > 1024 || height < 320) {
    height = clamp(height, 320, 1024);
    width = Math.round(clamp(height * aspect, 320, 2000)); // ≤2000 px: Claude rejects larger images when a request carries many
  }
  const notes = [];
  const [scene] = await Promise.all([
    loadScene(osm, lat, lon).catch((err) => {
      notes.push(`Gebäudedaten nicht verfügbar (${err.message}) – nur Gelände gezeigt.`);
      return null;
    }),
    terrain.prefetchView(lat, lon, bearingDeg, fovDeg, maxDistM).catch(() => {}),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const stats = drawView(canvas.getContext("2d"), { width, height, lat, lon, bearingDeg, fovDeg, pitchDeg, eyeHeight, scene, terrain, maxDistM });
  const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  const thumb = document.createElement("canvas");
  thumb.width = 240;
  thumb.height = Math.round((240 * height) / width);
  thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return { data: dataUrl.split(",")[1], dataUrl, thumbnail: thumb.toDataURL("image/jpeg", 0.8), stats, note: notes.join(" "), width, height };
}

/** Browser: load buildings and terrain for a view, then compute its exact visible area. */
export async function visibleAreaFor({ osm, terrain, lat, lon, bearingDeg, fovDeg, pitchDeg = 0, eyeHeight = 1.6, aspect = 4 / 3, maxDistM = 1000 }) {
  const [scene] = await Promise.all([
    loadScene(osm, lat, lon).catch(() => null),
    terrain.prefetchView(lat, lon, bearingDeg, fovDeg, maxDistM).catch(() => {}),
  ]);
  const area = computeVisibleArea({ lat, lon, bearingDeg, fovDeg, pitchDeg, eyeHeight, aspect, maxDistM, scene, terrain });
  return { ...area, sceneMissing: !scene };
}

// ---------- line of sight ----------

/** Distance along the ray from the origin with direction (dx, dy) to segment p–q, or null. */
export function raySegment(dx, dy, p, q) {
  const ex = q[0] - p[0];
  const ey = q[1] - p[1];
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return null;
  const t = (p[0] * ey - p[1] * ex) / den;
  const s = (p[0] * dy - p[1] * dx) / den;
  return t >= 0 && s >= 0 && s < 1 ? t : null;
}

/** Entry/exit distances of a ray through building footprints. */
function rayBuildings(dx, dy, buildings, maxD) {
  const hits = [];
  buildings.forEach((b, idx) => {
    const along = b.cx * dx + b.cy * dy;
    if (along + b.radius < 0 || along - b.radius > maxD) return;
    if (Math.abs(b.cx * dy - b.cy * dx) > b.radius) return;
    const ts = [];
    for (let i = 0; i < b.ring.length; i++) {
      const t = raySegment(dx, dy, b.ring[i], b.ring[(i + 1) % b.ring.length]);
      if (t != null) ts.push(t);
    }
    if (!ts.length) return;
    ts.sort((a, c) => a - c);
    if (ts.length % 2) ts.unshift(0); // the camera stands inside this footprint
    for (let k = 0; k + 1 < ts.length; k += 2) hits.push({ tin: ts[k], tout: ts[k + 1], zt: b.zt, idx });
  });
  return hits.sort((a, b) => a.tin - b.tin);
}

function firstBuildingAhead(buildings, bearingDeg) {
  const hits = rayBuildings(Math.sin(bearingDeg * DEG), Math.cos(bearingDeg * DEG), buildings, 1e5);
  return hits.length ? hits[0].tin : null;
}

/**
 * Trace one viewing direction: which stretches of ground are visible (terrain and buildings block the
 * view, the picture frame limits it) and which facade the view ends on.
 */
function traceRay(az, g, buildings, { maxD, tanLow, tanHigh }) {
  const dx = Math.sin(az);
  const dy = Math.cos(az);
  const hits = rayBuildings(dx, dy, buildings, maxD);
  const intervals = [];
  let open = null;
  let facade = null;
  let maxTan = -Infinity;
  let hi = 0;
  let d = 0.5;
  while (d <= maxD) {
    if (hi < hits.length && hits[hi].tin <= d) {
      const h = hits[hi++];
      if (open) open[1] = Math.max(open[1], h.tin); // the ground right up to the wall
      open = null;
      const topTan = h.zt / Math.max(h.tin, 0.5);
      if (!facade && h.tin > 0 && topTan > maxTan) facade = { d: h.tin, idx: h.idx };
      maxTan = Math.max(maxTan, topTan);
      d = Math.max(d, h.tout) + 0.01;
      continue;
    }
    const tan = g.groundZ(dx * d, dy * d, d) / d;
    if (tan >= maxTan - 1e-9 && tan >= tanLow && tan <= tanHigh) {
      if (open) open[1] = d;
      else intervals.push((open = [d, d]));
    } else {
      open = null;
    }
    if (tan > maxTan) maxTan = tan;
    let step = Math.max(0.5, d * 0.01);
    if (hi < hits.length && hits[hi].tin < d + step) step = Math.max(hits[hi].tin - d, 0.01);
    d += step;
  }
  // Tiny gaps come from noise in the height model; bridge them.
  const merged = [];
  for (const iv of intervals) {
    const last = merged.at(-1);
    if (last && iv[0] - last[1] < Math.max(3, last[1] * 0.03)) last[1] = iv[1];
    else merged.push([...iv]);
  }
  return { intervals: merged.filter(([a, b]) => b - a >= Math.max(0.5, a * 0.01)), facade };
}

/** Join the visible stretches of neighbouring rays into polygons. */
function chainRays(rays, stepRad) {
  const done = [];
  let open = [];
  for (const ray of rays) {
    const next = [];
    const used = new Set();
    for (const iv of ray.intervals) {
      const chain = open.find((c) => !used.has(c) && iv[0] <= c.last[1] && iv[1] >= c.last[0]);
      if (chain) {
        used.add(chain);
        chain.steps.push([ray.az, iv[0], iv[1]]);
        chain.last = iv;
        next.push(chain);
      } else {
        next.push({ steps: [[ray.az, iv[0], iv[1]]], last: iv });
      }
    }
    done.push(...open.filter((c) => !used.has(c)));
    open = next;
  }
  done.push(...open);
  return done.map((c) => {
    const first = c.steps[0];
    const last = c.steps.at(-1);
    const steps = [[first[0] - stepRad / 2, first[1], first[2]], ...c.steps, [last[0] + stepRad / 2, last[1], last[2]]];
    return { near: steps.map(([az, a]) => [az, a]), far: steps.map(([az, , b]) => [az, b]) };
  });
}

/**
 * The exact ground area a camera sees: bounded by the picture frame (horizontal and vertical field of
 * view), blocked by buildings and terrain. Returns lat/lon polygons plus the facades the view ends on.
 */
export function computeVisibleArea({ lat, lon, bearingDeg, fovDeg, pitchDeg = 0, eyeHeight = 1.7, aspect = 4 / 3, maxDistM = 1000, scene, terrain }) {
  fovDeg = clamp(fovDeg, 5, 150);
  const g = groundModel({ lat, lon, eyeHeight, terrain });
  const buildings = prepareBuildings(scene, g, maxDistM);
  const vHalf = Math.atan(Math.tan((fovDeg * DEG) / 2) / aspect);
  const tanLow = Math.tan(pitchDeg * DEG - vHalf);
  const tanHigh = pitchDeg * DEG + vHalf >= Math.PI / 2 ? Infinity : Math.tan(pitchDeg * DEG + vHalf);
  const count = clamp(Math.ceil(fovDeg / 0.5), 12, 300) + 1;
  const stepRad = (fovDeg * DEG) / (count - 1);
  const rays = [];
  for (let i = 0; i < count; i++) {
    const az = (bearingDeg - fovDeg / 2) * DEG + i * stepRad;
    rays.push({ az, ...traceRay(az, g, buildings, { maxD: maxDistM, tanLow, tanHigh }) });
  }
  const at = (az, d) => g.proj.toLatLon(Math.sin(az) * d, Math.cos(az) * d);
  const polygons = chainRays(rays, stepRad).map(({ near, far }) => [...near.map(([az, d]) => at(az, d)), ...far.reverse().map(([az, d]) => at(az, d))]);
  const facades = [];
  let line = null;
  for (const ray of rays) {
    if (ray.facade && line && line.idx === ray.facade.idx) {
      line.points.push(at(ray.az, ray.facade.d));
    } else {
      if (line && line.points.length > 1) facades.push(line.points);
      line = ray.facade ? { idx: ray.facade.idx, points: [at(ray.az, ray.facade.d)] } : null;
    }
  }
  if (line && line.points.length > 1) facades.push(line.points);
  const farthest = Math.max(0, ...rays.flatMap((r) => r.intervals.map((iv) => iv[1])));
  const nearest = Math.min(...rays.map((r) => r.intervals[0]?.[0] ?? Infinity));
  return {
    polygons,
    facades,
    stats: {
      rays: count, buildings: buildings.length, terrain: g.hasTerrain, ground_m: Math.round(g.ground0),
      farthest_m: Math.round(farthest), nearest_m: Number.isFinite(nearest) ? Math.round(nearest * 10) / 10 : null,
    },
  };
}

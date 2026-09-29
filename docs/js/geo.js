// OpenStreetMap lookups (Nominatim, Overpass) and small geo helpers. Runs in the browser and in Node tests.

const EARTH_RADIUS_KM = 6371.0088;
const PRIORITY_TAGS = [
  "name", "brand", "operator", "amenity", "shop", "tourism", "leisure", "building", "highway",
  "railway", "public_transport", "historic", "man_made", "natural", "addr:street",
  "addr:housenumber", "addr:postcode", "addr:city", "ref", "website", "denomination",
];
const MAX_TAGS = 16;
const MAX_OVERPASS_ELEMENTS = 60;

export const DEFAULT_OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dp = rad(lat2 - lat1);
  const dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached from (lat, lon) after distanceKm along the given bearing. Returns [lat, lon]. */
export function destinationPoint(lat, lon, bearing, distanceKm) {
  const d = distanceKm / EARTH_RADIUS_KM;
  const b = rad(bearing);
  const p1 = rad(lat);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = rad(lon) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/** Polygon (list of [lat, lon]) for a camera's field of view, for drawing on the map. */
export function viewCone(lat, lon, bearing, fov, distanceKm, steps = 12) {
  const points = [[lat, lon]];
  for (let i = 0; i <= steps; i++) points.push(destinationPoint(lat, lon, bearing - fov / 2 + (fov * i) / steps, distanceKm));
  points.push([lat, lon]);
  return points;
}

// Approximate solar azimuth/elevation (degrees, azimuth clockwise from north). Good to ~0.5°.
export function sunPosition(lat, lon, date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLon = rad((280.46 + 0.9856474 * n) % 360);
  const meanAnom = rad((357.528 + 0.9856003 * n) % 360);
  const eclLon = meanLon + rad(1.915) * Math.sin(meanAnom) + rad(0.02) * Math.sin(2 * meanAnom);
  const obliquity = rad(23.439 - 0.0000004 * n);
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon));
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(eclLon));
  const gmstHours = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const hourAngle = rad(gmstHours * 15 + lon) - ra;
  const phi = rad(lat);
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle));
  const azimuth = Math.atan2(-Math.sin(hourAngle), Math.cos(phi) * Math.tan(dec) - Math.sin(phi) * Math.cos(hourAngle));
  const result = {
    azimuth_deg: round(((deg(azimuth) % 360) + 360) % 360, 1),
    elevation_deg: round(deg(elevation), 1),
  };
  if (result.elevation_deg > 0.5) {
    // Shadow of a 1 m tall vertical object, pointing away from the sun.
    result.shadow_length_per_meter = round(1 / Math.tan(elevation), 2);
    result.shadow_direction_deg = round((result.azimuth_deg + 180) % 360, 1);
  }
  return result;
}

export class OSMError extends Error {}

function pickTags(tags) {
  const keys = Object.keys(tags);
  if (keys.length <= MAX_TAGS) return { ...tags };
  const picked = {};
  for (const k of PRIORITY_TAGS) if (k in tags) picked[k] = tags[k];
  for (const k of keys) {
    if (Object.keys(picked).length >= MAX_TAGS) break;
    if (!(k in picked)) picked[k] = tags[k];
  }
  return picked;
}

const FEATURE_KEYS = ["amenity", "shop", "tourism", "historic", "public_transport", "leisure", "highway", "traffic_sign", "building", "man_made", "office", "craft"];

/** Compact description of an OSM feature: what it is, its name and the few tags that help identify it. */
export function describeFeature(tags) {
  const key = FEATURE_KEYS.find((k) => tags[k]);
  const out = { type: key ? `${key}=${tags[key]}` : "sonstiges" };
  if (tags.name) out.name = tags.name;
  for (const k of ["brand", "operator", "addr:street", "addr:housenumber", "ref", "route_ref", "denomination"]) {
    if (tags[k]) out[k] = tags[k];
  }
  return out;
}

/** Closest point of a polyline ([[lat, lon], ...]) to (lat, lon), with the local street direction there. */
export function closestPointOnLine(points, lat, lon) {
  // Local flat projection in metres is accurate enough over a few kilometres.
  const kx = 111320 * Math.cos(rad(lat));
  const ky = 110540;
  const toXY = ([a, b]) => [(b - lon) * kx, (a - lat) * ky];
  let best = { distance_m: Infinity };
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = toXY(points[i]);
    const [x2, y2] = toXY(points[i + 1]);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, -(x1 * dx + y1 * dy) / len2)) : 0;
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    const d = Math.hypot(px, py);
    if (d < best.distance_m) {
      best = {
        distance_m: Math.round(d),
        lat: round(lat + py / ky, 6),
        lon: round(lon + px / kx, 6),
        street_bearing_deg: Math.round(bearingDeg(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])),
      };
    }
  }
  return best;
}

export function summarizeOverpass(data) {
  const summary = [];
  for (const el of data.elements || []) {
    if (el.type === "count") {
      summary.push({ count: el.tags || {} });
      continue;
    }
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const tags = el.tags || {};
    if (lat == null && !Object.keys(tags).length) continue; // bare geometry nodes of ways
    const item = { type: el.type, id: el.id };
    if (lat != null) {
      item.lat = round(lat, 6);
      item.lon = round(lon, 6);
    }
    if (Object.keys(tags).length) item.tags = pickTags(tags);
    summary.push(item);
  }
  const result = { total: summary.length, elements: summary.slice(0, MAX_OVERPASS_ELEMENTS) };
  if (summary.length > MAX_OVERPASS_ELEMENTS) {
    result.note = `Nur die ersten ${MAX_OVERPASS_ELEMENTS} von ${summary.length} Treffern gezeigt - Abfrage eingrenzen.`;
  }
  if (data.remark) result.remark = data.remark;
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A signal that ends a request after ms (older browsers: none). */
export const timeoutSignal = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
// A server that neither answers nor fails would otherwise hold a tool (e.g. the 3D view) for good.
const NOMINATIM_TIMEOUT_MS = 15000;
const OVERPASS_TIMEOUT_MS = 30000; // the queries ask the server for at most 25 s
const OVERPASS_BUDGET_MS = 60000; // all servers together

/** Polite client for the public Nominatim and Overpass services (rate limited + cached). */
export class OSMClient {
  constructor({
    fetchImpl = globalThis.fetch.bind(globalThis), nominatimUrl = "https://nominatim.openstreetmap.org", overpassUrls = DEFAULT_OVERPASS, minIntervalMs = 1050,
    nominatimTimeoutMs = NOMINATIM_TIMEOUT_MS, overpassTimeoutMs = OVERPASS_TIMEOUT_MS, overpassBudgetMs = OVERPASS_BUDGET_MS,
  } = {}) {
    this.fetch = fetchImpl;
    this.timeouts = { nominatim: nominatimTimeoutMs, overpass: overpassTimeoutMs, budget: overpassBudgetMs };
    this.nominatimUrl = nominatimUrl.replace(/\/$/, "");
    this.overpassUrls = overpassUrls;
    this.minIntervalMs = minIntervalMs;
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.lastNominatim = 0;
  }

  async nominatim(path, params) {
    const query = new URLSearchParams({ ...params, format: "jsonv2", "accept-language": "de" });
    const url = `${this.nominatimUrl}/${path}?${query}`;
    if (this.cache.has(url)) return this.cache.get(url);
    // Nominatim usage policy: at most one request per second, so requests are serialized.
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastNominatim);
      if (wait > 0) await sleep(wait);
      try {
        return await this.fetch(url, { signal: timeoutSignal(this.timeouts.nominatim) });
      } finally {
        this.lastNominatim = Date.now();
      }
    });
    this.queue = run.catch(() => {});
    let resp;
    try {
      resp = await run;
    } catch (err) {
      throw new OSMError(`Nominatim nicht erreichbar (${err.name || "Netzwerkfehler"})`);
    }
    if (resp.status === 429) throw new OSMError("Nominatim: zu viele Anfragen (HTTP 429). Etwas warten oder Overpass/Websuche nutzen.");
    if (!resp.ok) throw new OSMError(`Nominatim antwortete mit HTTP ${resp.status}`);
    const data = await resp.json();
    this.cache.set(url, data);
    return data;
  }

  async geocode(query, countryCodes = "", limit = 5) {
    const params = { q: query, limit: String(Math.max(1, Math.min(Number(limit) || 5, 10))), addressdetails: "1" };
    if (countryCodes.trim()) params.countrycodes = countryCodes.trim().toLowerCase();
    const data = await this.nominatim("search", params);
    return data.map((item) => ({
      name: item.display_name,
      lat: Number(item.lat),
      lon: Number(item.lon),
      kind: `${item.category ?? item.class ?? ""}/${item.type ?? ""}`,
      importance: round(Number(item.importance || 0), 3),
    }));
  }

  async reverse(lat, lon, zoom = 18) {
    const data = await this.nominatim("reverse", {
      lat: lat.toFixed(7), lon: lon.toFixed(7), zoom: String(Math.max(3, Math.min(Math.round(zoom), 18))), addressdetails: "1",
    });
    if (data.error) return { error: data.error };
    return { name: data.display_name, address: data.address || {}, kind: `${data.category ?? ""}/${data.type ?? ""}` };
  }

  async overpass(query) {
    return summarizeOverpass(await this.overpassRaw(query));
  }

  /** Named places and street furniture around a point, with distance and direction from it. */
  async nearbyFeatures(lat, lon, radiusM = 150) {
    const r = Math.round(Math.min(Math.max(radiusM, 20), 1000));
    const at = `(around:${r},${lat.toFixed(6)},${lon.toFixed(6)})`;
    const data = await this.overpassRaw(
      `[out:json][timeout:25];(nwr${at}["name"];nwr${at}["amenity"];nwr${at}["shop"];nwr${at}["tourism"];` +
        `nwr${at}["historic"];nwr${at}["public_transport"];nwr${at}["leisure"];` +
        `node${at}["highway"~"^(bus_stop|traffic_signals|crossing|stop|give_way|street_lamp)$"];node${at}["traffic_sign"];);out center tags 150;`,
    );
    const features = [];
    for (const el of data.elements || []) {
      const fLat = el.lat ?? el.center?.lat;
      const fLon = el.lon ?? el.center?.lon;
      if (fLat == null || !el.tags) continue;
      features.push({ ...describeFeature(el.tags), distance_m: Math.round(haversineKm(lat, lon, fLat, fLon) * 1000), bearing_deg: Math.round(bearingDeg(lat, lon, fLat, fLon)), lat: round(fLat, 6), lon: round(fLon, 6) });
    }
    features.sort((a, b) => a.distance_m - b.distance_m);
    return { center: { lat, lon }, radius_m: r, total: features.length, features: features.slice(0, 70) };
  }

  /** Course of a named street near a point: simplified geometry, segment directions, closest point. */
  async streetGeometry(name, lat, lon, radiusM = 1500) {
    const r = Math.round(Math.min(Math.max(radiusM, 50), 5000));
    const safe = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const data = await this.overpassRaw(`[out:json][timeout:25];way["highway"]["name"="${safe}"](around:${r},${lat.toFixed(6)},${lon.toFixed(6)});out geom tags 25;`);
    const ways = (data.elements || []).filter((el) => Array.isArray(el.geometry) && el.geometry.length > 1);
    if (!ways.length) return { name, found: false, note: "Keine Straße mit diesem Namen im Umkreis gefunden (Schreibweise prüfen, Radius vergrößern)." };
    let best = null;
    const result = ways.map((way) => {
      const pts = way.geometry.map((g) => [g.lat, g.lon]);
      const closest = closestPointOnLine(pts, lat, lon);
      if (!best || closest.distance_m < best.distance_m) best = { ...closest, way_id: way.id };
      const step = Math.max(1, Math.ceil(pts.length / 20));
      const simplified = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
      return {
        way_id: way.id,
        highway: way.tags?.highway,
        oneway: way.tags?.oneway === "yes" || undefined,
        lanes: way.tags?.lanes,
        length_m: Math.round(pts.slice(1).reduce((sum, p, i) => sum + haversineKm(pts[i][0], pts[i][1], p[0], p[1]) * 1000, 0)),
        points: simplified.map(([a, b]) => [round(a, 6), round(b, 6)]),
        segment_bearings_deg: simplified.slice(1).map((p, i) => Math.round(bearingDeg(simplified[i][0], simplified[i][1], p[0], p[1]))),
      };
    });
    return { name, found: true, closest_point: best, ways: result.slice(0, 8) };
  }

  async overpassRaw(query) {
    let q = query.trim();
    if (!q.startsWith("[")) q = "[out:json][timeout:25];" + q;
    const key = "overpass:" + q;
    if (this.cache.has(key)) return this.cache.get(key);
    const problems = [];
    const started = Date.now();
    for (const url of this.overpassUrls) {
      const left = this.timeouts.budget - (Date.now() - started);
      if (left < Math.min(5000, this.timeouts.overpass)) {
        problems.push("keine Zeit mehr für weitere Server");
        break;
      }
      const ms = Math.min(this.timeouts.overpass, left);
      let resp;
      let data;
      try {
        // Form-encoded POST is a "simple" CORS request, so no preflight is needed. The time limit covers the
        // whole answer (a server that stalls mid-answer is just as stuck).
        const signal = timeoutSignal(ms);
        resp = await this.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: q }).toString(),
          signal,
        });
        if (resp.ok) data = await resp.json().catch((err) => (err?.name === "TimeoutError" || err?.name === "AbortError" ? Promise.reject(err) : undefined));
      } catch (err) {
        problems.push(err?.name === "TimeoutError" || err?.name === "AbortError" ? `keine Antwort nach ${Math.round(ms / 1000)} s` : `nicht erreichbar (${err.name || "Netzwerkfehler"})`);
        continue;
      }
      if ([429, 502, 503, 504].includes(resp.status)) {
        problems.push(`HTTP ${resp.status}`);
        continue;
      }
      if (resp.status === 400) {
        // Syntax errors are the query's fault; another server won't help.
        throw new OSMError(`Overpass-Syntaxfehler: ${(await resp.text()).slice(0, 400)}`);
      }
      if (!resp.ok) {
        problems.push(`HTTP ${resp.status}`);
        continue;
      }
      if (data === undefined) throw new OSMError("Overpass lieferte kein JSON - fehlt [out:json]?");
      this.cache.set(key, data);
      return data;
    }
    throw new OSMError(
      `Overpass ist gerade nicht verfügbar oder überlastet (${problems.join(", ")}). ` +
        "Suchgebiet verkleinern (around-Filter statt ganzes Land) oder Ortssuche/Websuche nutzen.",
    );
  }
}

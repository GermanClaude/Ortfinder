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

/** Polite client for the public Nominatim and Overpass services (rate limited + cached). */
export class OSMClient {
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), nominatimUrl = "https://nominatim.openstreetmap.org", overpassUrls = DEFAULT_OVERPASS, minIntervalMs = 1050 } = {}) {
    this.fetch = fetchImpl;
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
        return await this.fetch(url);
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
    let q = query.trim();
    if (!q.startsWith("[")) q = "[out:json][timeout:25];" + q;
    const key = "overpass:" + q;
    if (this.cache.has(key)) return this.cache.get(key);
    const problems = [];
    for (const url of this.overpassUrls) {
      let resp;
      try {
        // Form-encoded POST is a "simple" CORS request, so no preflight is needed.
        resp = await this.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: q }).toString(),
        });
      } catch (err) {
        problems.push(`nicht erreichbar (${err.name || "Netzwerkfehler"})`);
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
      let data;
      try {
        data = await resp.json();
      } catch {
        throw new OSMError("Overpass lieferte kein JSON - fehlt [out:json]?");
      }
      const result = summarizeOverpass(data);
      this.cache.set(key, result);
      return result;
    }
    throw new OSMError(
      `Overpass ist gerade nicht verfügbar oder überlastet (${problems.join(", ")}). ` +
        "Suchgebiet verkleinern (around-Filter statt ganzes Land) oder Ortssuche/Websuche nutzen.",
    );
  }
}

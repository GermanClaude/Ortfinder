// Looking things up on the internet without API keys: photos other people took near a place (Wikimedia
// Commons, Panoramax street-level pictures – like Street View or review photos, but open), Wikipedia
// articles with coordinates, and – with an optional Google Cloud Vision key – a reverse image search like
// Google Lens (web pages showing the same picture, recognised landmarks with coordinates).
// Parsers are pure (tested in Node); fetching and the contact sheet run in the browser.

import { bearingDeg, haversineKm } from "./geo.js";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const around = (lat, lon, item) => ({
  ...item,
  distance_m: Math.round(haversineKm(lat, lon, item.lat, item.lon) * 1000),
  bearing_deg: Math.round(bearingDeg(lat, lon, item.lat, item.lon)),
});

// ---------- photos near a place ----------

/** Wikimedia Commons: files with coordinates within radiusM (max 10 km), with 400 px thumbnails. */
export function commonsNearbyUrl(lat, lon, radiusM, limit = 12) {
  const p = new URLSearchParams({
    action: "query", format: "json", origin: "*", generator: "geosearch", ggscoord: `${lat}|${lon}`,
    ggsradius: String(Math.round(clamp(radiusM, 10, 10000))), ggsnamespace: "6", ggslimit: String(limit),
    prop: "imageinfo|coordinates", iiprop: "url|extmetadata", iiurlwidth: "400",
    iiextmetadatafilter: "ImageDescription|DateTimeOriginal",
  });
  return `https://commons.wikimedia.org/w/api.php?${p}`;
}

export function parseCommons(json, lat, lon) {
  const out = [];
  for (const page of Object.values(json?.query?.pages || {})) {
    const info = page.imageinfo?.[0];
    const c = page.coordinates?.[0];
    if (!info?.thumburl || !c || !/\.(jpe?g|png|webp|tiff?)$/i.test(page.title || "")) continue;
    const meta = info.extmetadata || {};
    out.push(around(lat, lon, {
      source: "Commons",
      title: String(page.title).replace(/^[^:]+:/, "").replace(/\.[a-z]+$/i, "").replace(/_/g, " "),
      description: plain(meta.ImageDescription?.value).slice(0, 140),
      date: plain(meta.DateTimeOriginal?.value).slice(0, 10),
      thumb: info.thumburl, url: info.descriptionurl, lat: c.lat, lon: c.lon, heading: null,
    }));
  }
  return out.sort((a, b) => a.distance_m - b.distance_m);
}

/** Panoramax (open street-level imagery): pictures in a box around the point. */
export function panoramaxUrl(lat, lon, radiusM, limit = 30) {
  const dLat = radiusM / 111195;
  const dLon = radiusM / (111195 * Math.cos((lat * Math.PI) / 180));
  const f = (v) => v.toFixed(6);
  return `https://api.panoramax.xyz/api/search?bbox=${f(lon - dLon)},${f(lat - dLat)},${f(lon + dLon)},${f(lat + dLat)}&limit=${limit}`;
}

export function parsePanoramax(json, lat, lon) {
  const out = [];
  for (const f of json?.features || []) {
    const [plon, plat] = f.geometry?.coordinates || [];
    const thumb = f.assets?.thumb?.href || f.properties?.["geovisio:thumbnail"];
    if (!Number.isFinite(plat) || !thumb) continue;
    const p = f.properties || {};
    out.push(around(lat, lon, {
      source: "Panoramax", title: "Straßenbild", description: "",
      date: String(p.datetime || "").slice(0, 10), thumb, url: `https://api.panoramax.xyz/#focus=pic&pic=${f.id}`,
      lat: plat, lon: plon, heading: Number.isFinite(p["view:azimuth"]) ? p["view:azimuth"] : null,
    }));
  }
  return out.sort((a, b) => a.distance_m - b.distance_m);
}

/**
 * Mix both sources: nearest first, but spread over directions (street pictures one after another along
 * the same road look alike). At most `max` entries.
 */
export function pickPhotos(commons, streets, max = 8) {
  const out = [];
  const take = (list, n) => {
    for (const p of list) {
      if (out.length >= max || n <= 0) break;
      if (out.includes(p)) continue;
      // Street pictures closer than 25 m to one already taken add little.
      if (p.source === "Panoramax" && out.some((q) => q.source === "Panoramax" && haversineKm(p.lat, p.lon, q.lat, q.lon) < 0.025)) continue;
      out.push(p);
      n--;
    }
  };
  take(commons, Math.max(max - Math.min(3, streets.length), 0));
  take(streets, max - out.length);
  take(commons, max - out.length);
  return out;
}

// ---------- Wikipedia ----------

export function wikiSearchUrl(lang, query, limit = 5) {
  const p = new URLSearchParams({
    action: "query", format: "json", origin: "*", generator: "search", gsrsearch: query, gsrlimit: String(limit),
    prop: "coordinates|extracts|info", exintro: "1", explaintext: "1", exsentences: "2", exlimit: "max", inprop: "url", redirects: "1",
  });
  return `https://${lang}.wikipedia.org/w/api.php?${p}`;
}

export function parseWiki(json, lang) {
  return Object.values(json?.query?.pages || {})
    .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
    .map((p) => ({
      lang, title: p.title, url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
      extract: plain(p.extract).slice(0, 240),
      ...(p.coordinates?.[0] ? { lat: Math.round(p.coordinates[0].lat * 1e5) / 1e5, lon: Math.round(p.coordinates[0].lon * 1e5) / 1e5 } : {}),
    }));
}

/** "de, EN,fr" → ["de", "en", "fr"] (two-/three-letter codes, at most three). */
export function languages(text, fallback = ["de", "en"]) {
  const list = String(text || "").toLowerCase().split(/[\s,;]+/).filter((l) => /^[a-z]{2,3}$/.test(l));
  return (list.length ? [...new Set(list)] : fallback).slice(0, 3);
}

// ---------- reverse image search (Google Cloud Vision, optional own key) ----------

export const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";

export function visionRequest(base64) {
  return {
    requests: [{
      image: { content: base64 },
      features: [{ type: "WEB_DETECTION", maxResults: 12 }, { type: "LANDMARK_DETECTION", maxResults: 5 }],
    }],
  };
}

/** The useful parts of a Cloud Vision answer: what the web calls this picture, where it appears, landmarks. */
export function parseVision(json) {
  const r = json?.responses?.[0] || {};
  const web = r.webDetection || {};
  return {
    labels: (web.bestGuessLabels || []).map((l) => l.label).filter(Boolean),
    entities: (web.webEntities || []).filter((e) => e.description).slice(0, 10).map((e) => ({ name: e.description, score: Math.round((e.score || 0) * 100) / 100 })),
    pages: (web.pagesWithMatchingImages || []).slice(0, 8).map((p) => ({ title: plain(p.pageTitle).slice(0, 120), url: p.url })),
    matches: (web.fullMatchingImages || []).length + (web.partialMatchingImages || []).length,
    similar: (web.visuallySimilarImages || []).length,
    landmarks: (r.landmarkAnnotations || []).map((l) => ({
      name: l.description, score: Math.round((l.score || 0) * 100) / 100,
      lat: l.locations?.[0]?.latLng?.latitude ?? null, lon: l.locations?.[0]?.latLng?.longitude ?? null,
    })),
    error: r.error?.message || null,
  };
}

/** Short German summary for the AI (goes into the first message). */
export function visionSummary(v) {
  const lines = [];
  if (v.landmarks.length) {
    lines.push(`Erkannte Wahrzeichen: ${v.landmarks.map((l) => `${l.name}${l.lat != null ? ` (${l.lat.toFixed(5)}, ${l.lon.toFixed(5)})` : ""}, Sicherheit ${l.score}`).join("; ")}`);
  }
  if (v.labels.length) lines.push(`Beste Vermutung der Bildersuche: ${v.labels.join(", ")}`);
  if (v.entities.length) lines.push(`Stichworte aus dem Web: ${v.entities.map((e) => `${e.name} (${e.score})`).join(", ")}`);
  if (v.pages.length) lines.push(`Seiten mit demselben Bild:\n${v.pages.map((p) => `  - ${p.title || "(ohne Titel)"} – ${p.url}`).join("\n")}`);
  if (!lines.length) lines.push("Keine Treffer (das Bild ist so nicht im Web zu finden).");
  return lines.join("\n");
}

/** Readable reasons for Cloud Vision failures (key wrong, API off, billing missing). */
export function describeVisionError(status, json) {
  const msg = json?.error?.message || "";
  if (status === 400 && /API key not valid/i.test(msg)) return "Cloud-Vision-Key ungültig.";
  if (status === 403 && /billing/i.test(msg)) return "Im Google-Cloud-Projekt ist keine Abrechnung aktiviert (für die 1000 Gratis-Bilder pro Monat nötig).";
  if (status === 403 && /(not been used|disabled|SERVICE_DISABLED)/i.test(msg)) return "Die „Cloud Vision API“ ist im Google-Cloud-Projekt noch nicht aktiviert.";
  if (status === 403) return `Zugriff verweigert (${msg.slice(0, 160) || "Key-Einschränkungen prüfen"}).`;
  if (status === 429) return "Kontingent der Cloud Vision API erschöpft.";
  return `Cloud Vision antwortete mit HTTP ${status}${msg ? `: ${msg.slice(0, 160)}` : ""}.`;
}

// ---------- browser ----------

async function getJson(fetchImpl, url, init) {
  const resp = await fetchImpl(url, init);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** Photos near a point from both sources; a source that fails is reported, not fatal. */
export async function photosNearby(fetchImpl, lat, lon, radiusM = 300, max = 8) {
  const problems = [];
  const [commons, streets] = await Promise.all([
    getJson(fetchImpl, commonsNearbyUrl(lat, lon, radiusM)).then((j) => parseCommons(j, lat, lon)).catch((err) => { problems.push(`Commons: ${err.message}`); return []; }),
    getJson(fetchImpl, panoramaxUrl(lat, lon, radiusM)).then((j) => parsePanoramax(j, lat, lon).filter((p) => p.distance_m <= radiusM))
      .catch((err) => { problems.push(`Panoramax: ${err.message}`); return []; }),
  ]);
  return { items: pickPhotos(commons, streets, max), found: commons.length + streets.length, problems };
}

/** Wikipedia search in up to three languages. */
export async function wikiSearch(fetchImpl, query, langs = ["de", "en"]) {
  const problems = [];
  const lists = await Promise.all(langs.map((lang) => getJson(fetchImpl, wikiSearchUrl(lang, query)).then((j) => parseWiki(j, lang))
    .catch((err) => { problems.push(`${lang}.wikipedia: ${err.message}`); return []; })));
  return { results: lists.flat(), problems };
}

/** Reverse image search with the user's own Cloud Vision key (the photo is sent to Google). */
export async function reverseImageSearch(fetchImpl, apiKey, base64) {
  const resp = await fetchImpl(`${VISION_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(visionRequest(base64)),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(describeVisionError(resp.status, json));
  const v = parseVision(json);
  if (v.error) throw new Error(`Cloud Vision: ${v.error}`);
  return v;
}

/**
 * Browser: the photos as one numbered contact sheet (one image for the AI instead of eight).
 * loadImage(url) → HTMLImageElement or null.
 */
export async function contactSheet(items, loadImage, { cols = 4, cell = 300 } = {}) {
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const ch = Math.round(cell * 0.75);
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(items.length, cols) * cell;
  canvas.height = rows * (ch + 18);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const imgs = await Promise.all(items.map((p) => loadImage(p.thumb).catch(() => null)));
  let shown = 0;
  items.forEach((p, i) => {
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * (ch + 18);
    const img = imgs[i];
    if (img) {
      // Cover-fit into the cell.
      const s = Math.max(cell / img.width, ch / img.height);
      const w = cell / s;
      const h = ch / s;
      ctx.drawImage(img, (img.width - w) / 2, (img.height - h) / 2, w, h, x, y, cell, ch);
      shown++;
    }
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x, y, 28, 22);
    ctx.fillStyle = "#ffd400";
    ctx.font = "bold 16px sans-serif";
    ctx.fillText(String(i + 1), x + 8, y + 17);
    ctx.fillStyle = "#fff";
    ctx.font = "11px sans-serif";
    ctx.fillText(`${p.source} · ${p.distance_m} m · ${p.bearing_deg}°${p.heading != null ? ` · Blick ${Math.round(p.heading)}°` : ""}`, x + 4, y + ch + 13);
  });
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  const thumb = document.createElement("canvas");
  thumb.width = 240;
  thumb.height = Math.round((240 * canvas.height) / canvas.width);
  thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return { data: dataUrl.split(",")[1], dataUrl, thumbnail: thumb.toDataURL("image/jpeg", 0.8), width: canvas.width, height: canvas.height, shown };
}

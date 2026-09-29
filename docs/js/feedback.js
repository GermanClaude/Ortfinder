// Feedback and learning. After an analysis the user can say where the photo really was taken (map click,
// coordinates, a maps link or a screenshot of the gallery's details) and what should be better. Ortfinder
// then measures the error and asks the AI for short, general lessons ("what would have found it") that go
// along with future analyses on this device. Lessons others shared (docs/lessons.json, curated in new
// versions) go along for everyone. The models themselves cannot be retrained from a website – these
// lessons are instructions, visible and deletable, capped so they cannot crowd out the method.

import { haversineKm } from "./geo.js";

export const LESSONS_KEY = "ortfinder.lessons.v1";
export const FEEDBACK_KEY = "ortfinder.feedback.v1";
export const MAX_LESSONS = 12;
export const MAX_LESSON_CHARS = 220;

// ---------- where was it really? ----------

const inRange = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

function dms(deg, min, sec, hemi) {
  const v = Number(deg) + Number(min || 0) / 60 + Number(String(sec || 0).replace(",", ".")) / 3600;
  return /[SWsw]/.test(hemi || "") ? -v : v;
}

/**
 * A location from what people paste: "46.4012, 9.1045", "46°24'04.4"N 9°06'16.4"E", Google/Apple/OSM
 * map links, "geo:" URIs. Returns { lat, lon } or, for anything else with letters, { query } to geocode.
 */
export function parseLocation(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  let s = text;
  try {
    s = decodeURIComponent(text);
  } catch {
    // keep as is
  }
  const num = "(-?\\d{1,3}(?:\\.\\d+)?)";
  const tries = [
    new RegExp(`!3d${num}!4d${num}`), // Google Maps place data (most exact)
    new RegExp(`@${num},${num}`), // Google Maps view centre
    new RegExp(`[?&](?:q|query|ll|sll|daddr|destination|coordinate|center)=${num}\\s*,\\s*${num}`), // Google/Apple Maps
    new RegExp(`#map=\\d+(?:\\.\\d+)?/${num}/${num}`), // OpenStreetMap
    new RegExp(`geo:${num},${num}`),
  ];
  for (const re of tries) {
    const m = re.exec(s);
    if (m && inRange(+m[1], +m[2])) return { lat: +m[1], lon: +m[2] };
  }
  const mlat = /[?&]mlat=(-?[\d.]+)/.exec(s);
  const mlon = /[?&]mlon=(-?[\d.]+)/.exec(s);
  if (mlat && mlon && inRange(+mlat[1], +mlon[1])) return { lat: +mlat[1], lon: +mlon[1] };
  // Degrees, minutes, seconds: 46°24'04.4"N 9°06'16.4"E (also with ′ ″ or spaces).
  const d = /(\d{1,3})\s*°\s*(\d{1,2})?\s*['′]?\s*([\d.,]+)?\s*["″]?\s*([NSns])[\s,;]+(\d{1,3})\s*°\s*(\d{1,2})?\s*['′]?\s*([\d.,]+)?\s*["″]?\s*([EOWewo])/.exec(s);
  if (d) {
    const lat = dms(d[1], d[2], d[3], d[4]);
    const lon = dms(d[5], d[6], d[7], d[8]);
    if (inRange(lat, lon)) return { lat, lon };
  }
  // Plain decimals with optional hemisphere letters: "N 46.4012, E 9.1045" or "46.4012 9.1045".
  const plain = /^\s*([NS])?\s*(-?\d{1,2}(?:\.\d+))\s*°?\s*([NS])?[\s,;]+([EOW])?\s*(-?\d{1,3}(?:\.\d+))\s*°?\s*([EOW])?\s*$/i.exec(s);
  if (plain) {
    let lat = +plain[2];
    let lon = +plain[5];
    if (/s/i.test(plain[1] || plain[3] || "")) lat = -Math.abs(lat);
    if (/w/i.test(plain[4] || plain[6] || "")) lon = -Math.abs(lon);
    if (inRange(lat, lon)) return { lat, lon };
  }
  return /[a-zäöüß]{2}/i.test(text) && !/^https?:\/\//i.test(text) ? { query: text.slice(0, 200) } : null;
}

// ---------- lessons ----------

/** One lesson: trimmed, one line, no coordinates (lessons are about method, not about this place). */
export function cleanLesson(text) {
  let t = String(text || "").replace(/\s+/g, " ").replace(/^[-–•*\d.)\s]+/, "").trim();
  if (/-?\d{1,3}\.\d{3,}\s*[,/ ]\s*-?\d{1,3}\.\d{3,}/.test(t)) return ""; // contains coordinates
  if (t.length > MAX_LESSON_CHARS) t = `${t.slice(0, MAX_LESSON_CHARS - 1).replace(/\s+\S*$/, "")} …`;
  return t.length >= 15 ? t : "";
}

/** The AI's answer → lessons: JSON {"lessons": [...]} or, failing that, bullet lines. */
export function parseLessons(answer) {
  const text = String(answer || "");
  const m = /\{[\s\S]*\}/.exec(text);
  let list = null;
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (Array.isArray(obj.lessons)) list = obj.lessons;
    } catch {
      // fall through to lines
    }
  }
  list ??= text.split("\n").filter((l) => /^\s*([-–•*]|\d+[.)])\s+/.test(l));
  return list.map(cleanLesson).filter(Boolean).slice(0, 3);
}

/** Add new lessons in front (same text only once), keep at most MAX_LESSONS. */
export function mergeLessons(existing, fresh, meta = {}) {
  const seen = new Set();
  const out = [];
  for (const l of [...fresh.map((text) => ({ text, date: meta.date || new Date().toISOString().slice(0, 10), ...meta })), ...existing]) {
    const key = l.text.toLowerCase().replace(/[^a-zäöüß0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out.slice(0, MAX_LESSONS);
}

/** Text that goes with the first message of an analysis (nothing when there are no lessons). */
export function lessonsBlock(personal = [], shared = [], max = 8) {
  const own = personal.slice(0, Math.min(max, 6)).map((l) => l.text);
  const all = [...own, ...shared.map((l) => l.text ?? l).filter((t) => !own.includes(t))].slice(0, max);
  if (!all.length) return "";
  return "Erfahrungen aus früheren Rückmeldungen (Hinweise zur Methode, keine Ortsvorgaben – nur anwenden, wenn sie zum Foto passen):\n" +
    all.map((t) => `- ${t}`).join("\n");
}

/** The question to the AI after feedback. The photo goes along (small), the answer is JSON. */
export function lessonPrompt({ analysis, truth, truthName = "", errorKm, comment = "" }) {
  const a = analysis || {};
  const clues = (a.clues || []).slice(0, 8).map((c) => `- ${c.category}: ${c.description} → ${c.implication}`).join("\n");
  return [
    "Du hast dieses Foto zur Geolokalisierung analysiert. Jetzt ist der wahre Aufnahmeort bekannt.",
    `Deine Antwort: ${a.camera?.name || "?"} (${a.camera?.lat?.toFixed?.(5)}, ${a.camera?.lon?.toFixed?.(5)}), Radius ${a.camera?.radius_km} km, ` +
      `Genauigkeit „${a.precision || "?"}“, Konfidenz ${Math.round((a.camera?.confidence || 0) * 100)} %.`,
    `Zusammenfassung: ${a.summary || "–"}`,
    clues ? `Deine Hinweise:\n${clues}` : "",
    `Wahrer Ort: ${truthName || "(ohne Adresse)"} (${truth.lat.toFixed(5)}, ${truth.lon.toFixed(5)}). Abweichung: ${formatKm(errorKm)}.`,
    comment ? `Anmerkung der Person: ${comment}` : "",
    "Aufgabe: Formuliere 1–3 kurze, ALLGEMEINE Lehren für künftige Analysen anderer Fotos (je höchstens 200 Zeichen): " +
      "Was im Bild hätte zum richtigen Ort geführt, was war falsch gewichtet, welche Methode/Werkzeug hätte geholfen? " +
      "Keine Ortsnamen, Koordinaten oder Länder-Vorlieben aus diesem Fall; keine Aussagen über Personen. Wenn die Antwort " +
      "schon gut war (Ort im Radius), eine Lehre dazu, was sie gut gemacht hat, oder gar keine.",
    'Antworte nur mit JSON: {"lessons": ["…", "…"]}',
  ].filter(Boolean).join("\n\n");
}

export const SCREENSHOT_PROMPT = "Dieses Bild ist ein Screenshot aus einer Fotogalerie oder Karten-App (Details eines Fotos). " +
  "Lies daraus den Aufnahmeort: Koordinaten, falls sichtbar, sonst die genaueste Adresse bzw. den Ortsnamen mit Land. " +
  'Antworte nur mit JSON: {"lat": Zahl oder null, "lon": Zahl oder null, "address": "…"}';

/** The AI's reading of a location screenshot → { lat, lon } or { query } or null. */
export function parseScreenshotAnswer(answer) {
  const m = /\{[\s\S]*\}/.exec(String(answer || ""));
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (inRange(Number(obj.lat), Number(obj.lon))) return { lat: Number(obj.lat), lon: Number(obj.lon), address: obj.address || "" };
    if (typeof obj.address === "string" && obj.address.trim()) return { query: obj.address.trim().slice(0, 200) };
  } catch {
    // not JSON
  }
  return null;
}

// ---------- records and statistics ----------

export function formatKm(km) {
  if (km == null || !Number.isFinite(km)) return "?";
  return km < 1 ? `${Math.round(km * 1000)} m` : `${(km < 10 ? km.toFixed(1) : Math.round(km)).toString().replace(".", ",")} km`;
}

/** One piece of feedback: what the analysis said, the truth, the error. */
export function feedbackRecord({ analysis, truth, comment = "", date = new Date().toISOString() }) {
  const cam = analysis?.camera;
  const errorKm = cam ? haversineKm(cam.lat, cam.lon, truth.lat, truth.lon) : null;
  return {
    date, error_km: errorKm == null ? null : Math.round(errorKm * 1000) / 1000,
    within_radius: cam && errorKm != null ? errorKm <= cam.radius_km : null,
    radius_km: cam?.radius_km ?? null, precision: analysis?.precision ?? null, comment: String(comment).slice(0, 1000),
  };
}

/** Count, share within the stated radius, median error. */
export function feedbackStats(records) {
  const withErr = records.filter((r) => r.error_km != null);
  if (!withErr.length) return { count: records.length, within: 0, median_km: null };
  const errs = withErr.map((r) => r.error_km).sort((a, b) => a - b);
  return { count: records.length, within: withErr.filter((r) => r.within_radius).length, median_km: errs[Math.floor(errs.length / 2)] };
}

/**
 * A prefilled GitHub issue, so lessons can reach everyone with the next version. Nothing is sent by
 * Ortfinder: the person sees the text on GitHub and decides. The exact place only when they tick it.
 */
export function shareIssueUrl({ record, lessons, comment, truth = null, repo = "GermanClaude/Ortfinder" }) {
  const body = [
    "Rückmeldung aus Ortfinder (automatisch vorbereitet, vor dem Absenden anpassbar).",
    "",
    `- Abweichung: ${formatKm(record.error_km)} (angegebener Radius ${formatKm(record.radius_km)}, ${record.within_radius ? "im Radius" : "außerhalb"})`,
    `- Genauigkeitsstufe: ${record.precision || "?"}`,
    truth ? `- Wahrer Ort: ${truth.lat.toFixed(5)}, ${truth.lon.toFixed(5)}` : "- Wahrer Ort: nicht mitgeteilt",
    "",
    comment ? `Anmerkung:\n${comment}\n` : "",
    lessons.length ? `Vorgeschlagene Lehren:\n${lessons.map((l) => `- ${l}`).join("\n")}` : "",
  ].filter((l) => l !== "").join("\n");
  const q = new URLSearchParams({ title: `Rückmeldung: ${formatKm(record.error_km)} daneben`, body, labels: "rueckmeldung" });
  return `https://github.com/${repo}/issues/new?${q}`;
}

// ---------- storage (localStorage-like: getItem/setItem) ----------

function readJson(storage, key, fallback) {
  try {
    const v = JSON.parse(storage?.getItem(key) || "null");
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // private mode or full: learning simply is not remembered
  }
}

export const loadLessons = (storage) => readJson(storage, LESSONS_KEY, []);
export const saveLessons = (storage, list) => writeJson(storage, LESSONS_KEY, list.slice(0, MAX_LESSONS));
export const loadFeedback = (storage) => readJson(storage, FEEDBACK_KEY, []);
export const saveFeedback = (storage, list) => writeJson(storage, FEEDBACK_KEY, list.slice(-50));

// ---------- one question to the chosen AI (no tools) ----------

/**
 * Ask the configured AI one question about an image; returns the answer text. `ai` holds the provider and
 * its key/model: { provider, apiKey, model, claudeKey, claudeModel, puterModel, openrouterKey, openrouterModel,
 * ollamaUrl, ollamaModel }. image: base64 JPEG (optional).
 */
export async function askAI(ai, { text, image = null, fetchImpl = globalThis.fetch?.bind(globalThis), loadClaude = null, puter = globalThis.puter }) {
  const dataUrl = image ? `data:image/jpeg;base64,${image}` : null;
  if (ai.compatUrl) {
    // Any service with an OpenAI-style API (providers.js).
    const content = [...(dataUrl ? [{ type: "image_url", image_url: { url: dataUrl } }] : []), { type: "text", text }];
    const resp = await fetchImpl(`${ai.compatUrl}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.compatKey}` },
      body: JSON.stringify({ model: ai.compatModel, messages: [{ role: "user", content }] }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(data.error?.message || `HTTP ${resp.status}`);
    const c = data.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : Array.isArray(c) ? c.map((part) => part.text || "").join("") : "";
  }
  switch (ai.provider) {
    case "claude": {
      const { default: Anthropic } = await loadClaude();
      const client = new Anthropic({ apiKey: ai.claudeKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
      const msg = await client.messages.create({
        model: ai.claudeModel, max_tokens: 1500,
        messages: [{ role: "user", content: [...(image ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }] : []), { type: "text", text }] }],
      });
      return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    case "puter": {
      const content = [...(dataUrl ? [{ type: "image_url", image_url: { url: dataUrl } }] : []), { type: "text", text }];
      const r = await puter.ai.chat([{ role: "user", content }], { model: ai.puterModel });
      const c = r?.message?.content;
      return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text || "").join("") : String(r ?? "");
    }
    case "openrouter": {
      const content = [...(dataUrl ? [{ type: "image_url", image_url: { url: dataUrl } }] : []), { type: "text", text }];
      const resp = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.openrouterKey}`, "X-Title": "Ortfinder" },
        body: JSON.stringify({ model: ai.openrouterModel, messages: [{ role: "user", content }] }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) throw new Error(data.error?.message || `OpenRouter: HTTP ${resp.status}`);
      return data.choices?.[0]?.message?.content || "";
    }
    case "ollama": {
      const resp = await fetchImpl(`${ai.ollamaUrl}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ai.ollamaModel, stream: false, messages: [{ role: "user", content: text, ...(image ? { images: [image] } : {}) }], options: { num_ctx: 8192 } }),
      });
      if (!resp.ok) throw new Error(`Ollama: HTTP ${resp.status}`);
      return (await resp.json()).message?.content || "";
    }
    default: {
      const resp = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": ai.apiKey },
        body: JSON.stringify({
          model: ai.model, store: false,
          input: [{ type: "user_input", content: [{ type: "text", text }, ...(image ? [{ type: "image", mime_type: "image/jpeg", data: image }] : [])] }],
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error?.message || `Gemini: HTTP ${resp.status}`);
      return (data.steps || data.outputs || []).filter((s) => s.type === "model_output" || s.type === "text")
        .flatMap((s) => (s.content ? s.content.filter((c) => c.type === "text").map((c) => c.text) : [s.text || ""])).join("\n");
    }
  }
}

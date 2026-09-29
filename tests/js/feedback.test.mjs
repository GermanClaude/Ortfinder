import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_LESSONS, askAI, cleanLesson, feedbackRecord, feedbackStats, lessonPrompt, lessonsBlock, loadLessons, mergeLessons, parseLessons,
  parseLocation, parseScreenshotAnswer, saveLessons, shareIssueUrl,
} from "../../docs/js/feedback.js";

test("parseLocation: coordinates, DMS, map links of Google/Apple/OSM, geo: URIs, addresses", () => {
  const near = (p, lat, lon) => assert.ok(p && Math.abs(p.lat - lat) < 1e-4 && Math.abs(p.lon - lon) < 1e-4, JSON.stringify(p));
  near(parseLocation("46.40123, 9.10456"), 46.40123, 9.10456);
  near(parseLocation("46.40123 9.10456"), 46.40123, 9.10456);
  near(parseLocation("N 46.40123, E 9.10456"), 46.40123, 9.10456);
  near(parseLocation("33.8688 S, 151.2093 E"), -33.8688, 151.2093);
  near(parseLocation(`46°24'04.4"N 9°06'16.4"E`), 46.40122, 9.10456);
  near(parseLocation("https://www.google.com/maps/place/X/@46.4012,9.1045,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d46.40123!4d9.10456"), 46.40123, 9.10456);
  near(parseLocation("https://www.google.com/maps/@46.4012,9.1045,15z"), 46.4012, 9.1045);
  near(parseLocation("https://maps.google.com/?q=46.4012,9.1045"), 46.4012, 9.1045);
  near(parseLocation("https://maps.apple.com/?ll=46.4012,9.1045&q=Pin"), 46.4012, 9.1045);
  near(parseLocation("https://www.openstreetmap.org/?mlat=46.4012&mlon=9.1045#map=17/46.4012/9.1045"), 46.4012, 9.1045);
  near(parseLocation("https://www.openstreetmap.org/#map=18/46.40120/9.10450"), 46.4012, 9.1045);
  near(parseLocation("geo:46.4012,9.1045?z=16"), 46.4012, 9.1045);
  assert.deepEqual(parseLocation("Bahnhofstrasse 1, 8001 Zürich"), { query: "Bahnhofstrasse 1, 8001 Zürich" });
  assert.equal(parseLocation(""), null);
  assert.equal(parseLocation("123"), null);
  assert.equal(parseLocation("https://maps.app.goo.gl/abc"), null, "short links cannot be resolved in the browser");
  assert.equal(parseLocation("0, 0"), null);
});

test("lessons: parsed from JSON or bullets, cleaned, never with coordinates, merged without duplicates", () => {
  assert.deepEqual(parseLessons('Hier: {"lessons": ["  Kennzeichen zuerst zoomen, auch winzige.  ", "kurz", "Ort bei 46.40123, 9.10456 prüfen"]}'),
    ["Kennzeichen zuerst zoomen, auch winzige."]);
  assert.deepEqual(parseLessons("Lehren:\n- Bei Fernsicht erst skyline_match nutzen.\n2) Schatten gegen Sonnenstand prüfen, wenn Uhrzeit bekannt.\nSonstiges"),
    ["Bei Fernsicht erst skyline_match nutzen.", "Schatten gegen Sonnenstand prüfen, wenn Uhrzeit bekannt."]);
  const long = cleanLesson("Wort ".repeat(80));
  assert.ok(long.length <= 220 && long.endsWith("…"));
  const merged = mergeLessons([{ text: "A alt lesson here long enough", date: "2026-01-01" }], ["Neue Lehre, lang genug zum Behalten.", "a alt lesson here long enough!"], { date: "2026-09-29" });
  assert.deepEqual(merged.map((l) => l.text), ["Neue Lehre, lang genug zum Behalten.", "a alt lesson here long enough!"]);
  const many = mergeLessons([], Array.from({ length: 20 }, (_, i) => `Lehre Nummer ${i} mit genug Text`));
  assert.equal(many.length, MAX_LESSONS);
  assert.equal(lessonsBlock([], []), "");
  const block = lessonsBlock([{ text: "Eigene Lehre A" }], ["Gemeinsame Lehre B", "Eigene Lehre A"]);
  assert.match(block, /^Erfahrungen aus früheren Rückmeldungen \(Hinweise zur Methode, keine Ortsvorgaben/);
  assert.equal(block.split("\n- ").length - 1, 2, "no duplicates");
  // Storage round trip; a broken store does not throw.
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  saveLessons(storage, merged);
  assert.equal(loadLessons(storage).length, 2);
  assert.deepEqual(loadLessons({ getItem: () => "{kaputt" }), []);
  saveLessons({ setItem: () => { throw new Error("voll"); } }, merged);
});

test("feedback record, statistics, lesson question and shareable issue", () => {
  const analysis = {
    precision: "strasse", summary: "Schild gelesen.", camera: { name: "Hauptstraße", lat: 46.4, lon: 9.1, radius_km: 0.3, confidence: 0.7 },
    clues: [{ category: "schild", description: "Ortsschild", implication: "Kanton" }],
  };
  const rec = feedbackRecord({ analysis, truth: { lat: 46.401, lon: 9.1 }, comment: "Fast!", date: "2026-09-29T10:00:00Z" });
  assert.deepEqual(rec, { date: "2026-09-29T10:00:00Z", error_km: 0.111, within_radius: true, radius_km: 0.3, precision: "strasse", comment: "Fast!" });
  const far = feedbackRecord({ analysis, truth: { lat: 46.5, lon: 9.1 } });
  assert.deepEqual(feedbackStats([rec, far, { comment: "nur Text", error_km: null }]), { count: 3, within: 1, median_km: 11.12 });
  const q = lessonPrompt({ analysis, truth: { lat: 46.5, lon: 9.1 }, truthName: "Testdorf", errorKm: far.error_km, comment: "Bergform übersehen" });
  assert.match(q, /Abweichung: 11 km/);
  assert.match(q, /Keine Ortsnamen, Koordinaten oder Länder-Vorlieben/);
  assert.match(q, /Anmerkung der Person: Bergform übersehen/);
  assert.match(q, /\{"lessons"/);
  const url = new URL(shareIssueUrl({ record: far, lessons: ["Lehre eins, allgemein."], comment: "Bergform übersehen" }));
  assert.equal(url.origin + url.pathname, "https://github.com/GermanClaude/Ortfinder/issues/new");
  const body = url.searchParams.get("body");
  assert.match(body, /Wahrer Ort: nicht mitgeteilt/);
  assert.match(body, /- Lehre eins, allgemein\./);
  assert.match(new URL(shareIssueUrl({ record: far, lessons: [], truth: { lat: 46.5, lon: 9.1 } })).searchParams.get("body"), /Wahrer Ort: 46\.50000, 9\.10000/);
});

test("screenshot of the gallery details: coordinates or an address to look up", () => {
  assert.deepEqual(parseScreenshotAnswer('{"lat": 46.4, "lon": 9.1, "address": "Testweg 1"}'), { lat: 46.4, lon: 9.1, address: "Testweg 1" });
  assert.deepEqual(parseScreenshotAnswer('Gelesen: {"lat": null, "lon": null, "address": "Hauptstrasse 5, 7000 Chur"}'), { query: "Hauptstrasse 5, 7000 Chur" });
  assert.equal(parseScreenshotAnswer("keine Ahnung"), null);
});

test("askAI: one question with an image to each provider", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (url.includes("generativelanguage")) return { ok: true, json: async () => ({ steps: [{ type: "thought" }, { type: "model_output", content: [{ type: "text", text: "G" }] }] }) };
    if (url.includes("openrouter")) return { ok: true, json: async () => ({ choices: [{ message: { content: "O" } }] }) };
    return { ok: true, json: async () => ({ message: { content: "L" } }) };
  };
  const base = { apiKey: "AQ.k", model: "gemini-3.8-flash", openrouterKey: "sk-or", openrouterModel: "m:free", ollamaUrl: "http://localhost:11434", ollamaModel: "gemma4:12b" };
  assert.equal(await askAI({ ...base, provider: "gemini" }, { text: "Frage", image: "QUJD", fetchImpl }), "G");
  assert.deepEqual(calls[0].body.input[0].content, [{ type: "text", text: "Frage" }, { type: "image", mime_type: "image/jpeg", data: "QUJD" }]);
  assert.equal(calls[0].headers["x-goog-api-key"], "AQ.k");
  assert.equal(await askAI({ ...base, provider: "openrouter" }, { text: "Frage", image: "QUJD", fetchImpl }), "O");
  assert.equal(calls[1].body.messages[0].content[0].image_url.url, "data:image/jpeg;base64,QUJD");
  assert.equal(await askAI({ ...base, provider: "ollama" }, { text: "Frage", image: "QUJD", fetchImpl }), "L");
  assert.deepEqual(calls[2].body.messages[0], { role: "user", content: "Frage", images: ["QUJD"] });
  const puter = { ai: { chat: async (messages, opts) => ({ message: { content: `P:${opts.model}:${messages[0].content.length}` } }) } };
  assert.equal(await askAI({ provider: "puter", puterModel: "gemini-3.8-flash" }, { text: "Frage", image: "QUJD", puter }), "P:gemini-3.8-flash:2");
  let claudeArgs = null;
  class FakeAnthropic {
    constructor(opts) { this.opts = opts; this.messages = { create: async (args) => { claudeArgs = args; return { content: [{ type: "text", text: "C" }] }; } }; }
  }
  assert.equal(await askAI({ provider: "claude", claudeKey: "sk-ant-x", claudeModel: "claude-opus-5" }, { text: "Frage", image: "QUJD", loadClaude: async () => ({ default: FakeAnthropic }) }), "C");
  assert.equal(claudeArgs.model, "claude-opus-5");
  assert.equal(claudeArgs.messages[0].content[0].source.data, "QUJD");
  const failing = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "API key not valid" } }) });
  await assert.rejects(askAI({ ...base, provider: "gemini" }, { text: "x", fetchImpl: failing }), /API key not valid/);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { API_URL, GeminiAgent, GeminiError, assembleResult, preview } from "../../docs/js/agent.js";
import { ToolExecutor } from "../../docs/js/tools.js";
import { VALID_SUBMISSION } from "./fixtures.mjs";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const interaction = (steps, status = "requires_action") => ({
  id: "", status, steps,
  usage: { total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 50, total_cached_tokens: 400 },
});
const call = (id, name, args) => ({ type: "function_call", id, name, arguments: args });

function fakeGemini(responses) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, API_URL);
    requests.push({ at: Date.now(), headers: init.headers, body: JSON.parse(init.body) });
    const next = responses.shift();
    return typeof next === "function" ? next(init) : json(200, next);
  };
  return { fetchImpl, requests };
}

function setup(responses, options = {}) {
  const { fetchImpl, requests } = fakeGemini(responses);
  const events = [];
  const emit = (t, d) => events.push([t, d]);
  const osmCalls = [];
  const osm = {
    geocode: async (...args) => { osmCalls.push(args); return [{ name: "Bahnhofstraße, Freiburg", lat: 47.99, lon: 7.85, kind: "highway/residential" }]; },
    reverse: async () => ({ name: "x" }),
    overpass: async () => ({ total: 0, elements: [] }),
  };
  const executor = new ToolExecutor({
    zoom: async () => ({ data: "Wk9PTQ==", width: 1024, height: 768, sourceWidth: 120, sourceHeight: 90, thumbnail: "data:," }),
    osm, emit,
  });
  const agent = new GeminiAgent({ apiKey: "AIza-test", maxSteps: 6, fetchImpl, emit, ...options });
  const run = () => agent.run({ intro: "Wo ist das?", images: [{ type: "image", mime_type: "image/jpeg", data: "QkFTRQ==", resolution: "high" }], executor });
  return { agent, run, requests, events, osmCalls, executor };
}

test("full loop: zoom + geocode, then submit", async () => {
  const thought = { type: "thought", signature: "c2lnLTE=", summary: [{ type: "text", text: "Schild unten rechts prüfen." }] };
  const { run, requests, events, osmCalls } = setup([
    interaction([
      thought,
      { type: "model_output", content: [{ type: "text", text: "Ich zoome auf das Schild." }] },
      { type: "google_search_call", id: "s1", arguments: { queries: ["Bahnhofstraße Freiburg"] } },
      { type: "google_search_result", call_id: "s1", result: [{ search_suggestions: "<div/>" }] },
      call("c1", "zoom_image", { x_min: 0.7, y_min: 0.6, x_max: 0.9, y_max: 0.8, enhance: true, purpose: "Schild" }),
      call("c2", "geocode", { query: "Bahnhofstraße", country_codes: "de" }),
    ]),
    interaction([call("c3", "submit_result", VALID_SUBMISSION)]),
  ]);
  const { analysis, usage } = await run();
  assert.equal(analysis.city, "Freiburg");
  assert.equal(usage.requests, 2);
  assert.equal(usage.input_tokens, 2000);

  const first = requests[0];
  assert.equal(first.headers["x-goog-api-key"], "AIza-test");
  assert.equal(first.body.model, "gemini-3.8-flash");
  assert.equal(first.body.store, false);
  assert.match(first.body.system_instruction, /Ortfinder/);
  assert.deepEqual(first.body.generation_config, { thinking_level: "medium", thinking_summaries: "auto" });
  assert.deepEqual(first.body.tools.at(-1), { type: "google_search" });
  assert.equal(first.body.input.length, 1);
  assert.equal(first.body.input[0].type, "user_input");
  assert.match(first.body.input[0].content[0].text, /^Wo ist das\?\n\nBudget: höchstens 6 Runden/);

  // Stateless: second request carries full history, model steps echoed verbatim.
  const history = requests[1].body.input;
  assert.deepEqual(history.map((s) => s.type), [
    "user_input", "thought", "model_output", "google_search_call", "google_search_result",
    "function_call", "function_call", "function_result", "function_result",
  ]);
  assert.deepEqual(history[1], thought);
  const [zoomResult, geoResult] = history.slice(-2);
  assert.equal(zoomResult.call_id, "c1");
  assert.equal(zoomResult.name, "zoom_image");
  assert.equal(zoomResult.result[1].type, "image");
  assert.equal(geoResult.call_id, "c2");
  assert.equal(JSON.parse(geoResult.result)[0].lat, 47.99);
  assert.deepEqual(osmCalls[0], ["Bahnhofstraße", "de", 5]);

  const types = events.map(([t]) => t);
  for (const t of ["step", "thinking", "note", "web_search", "web_results", "zoom", "tool_call", "tool_result"]) assert.ok(types.includes(t), t);
});

test("google search unavailable: retries once without it", async () => {
  const { run, requests, events } = setup([
    () => json(400, [{ error: { code: 400, message: "Grounding with Google Search is not supported for this tier.", status: "INVALID_ARGUMENT" } }]),
    interaction([call("c1", "submit_result", VALID_SUBMISSION)]),
  ]);
  await run();
  assert.ok(requests[0].body.tools.some((t) => t.type === "google_search"));
  assert.ok(!requests[1].body.tools.some((t) => t.type === "google_search"));
  assert.ok(events.some(([t, d]) => t === "warning" && /Google-Suche/.test(d.message)));
});

test("free tier: quota error caused by Google Search switches search off", async () => {
  // Real response observed with a free-tier key when google_search is in the tools.
  const { run, requests, events } = setup([
    () => json(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "too_many_requests" } }),
    interaction([call("c1", "submit_result", VALID_SUBMISSION)]),
  ]);
  await run();
  assert.equal(requests.length, 2);
  assert.ok(!requests[1].body.tools.some((t) => t.type === "google_search"));
  assert.ok(events.some(([t, d]) => t === "warning" && /Google-Suche/.test(d.message)));
});

test("rate limit is retried with the server's delay", async () => {
  const { run, requests } = setup([
    () => json(429, { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.01s" }] } }),
    interaction([call("c1", "submit_result", VALID_SUBMISSION)]),
  ], { webSearch: false });
  await run();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, requests[1].body);
});

test("free-tier RPM limit: waits the announced time, then paces further requests", async () => {
  // Shape of the real Interactions API error for a free-tier key (limit lowered to keep the test fast).
  const limit = "Rate limit exceeded for model gemini-3.8-flash (limit: 100 requests per minute on Free Tier). Please retry in 0.01s or upgrade your tier.";
  const { run, requests, events } = setup([
    () => json(429, { error: { message: limit, code: "too_many_requests" } }),
    interaction([call("c1", "geocode", { query: "x" })]),
    interaction([call("c2", "submit_result", VALID_SUBMISSION)]),
  ], { webSearch: false });
  await run();
  assert.equal(requests.length, 3);
  const retryGap = requests[1].at - requests[0].at;
  assert.ok(retryGap >= 1000 && retryGap < 1900, `retry after announced 0.01 s + 1 s margin, not the 2 s default (${retryGap} ms)`);
  const pacedGap = requests[2].at - requests[1].at;
  assert.ok(pacedGap >= 1050, `requests paced to 60 s / 100 + 0.5 s (${pacedGap} ms)`);
  assert.ok(events.some(([t, d]) => t === "status" && /100 Anfragen pro Minute/.test(d.message)));
});

test("daily free-tier limit stops immediately with a clear message", async () => {
  // Real message observed with a free-tier key after 20 requests.
  const daily = "Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). Please retry in 58s or upgrade your tier at https://ai.dev/rate-limit.";
  const { run, requests } = setup([() => json(429, { error: { message: daily, code: "too_many_requests" } })]);
  await assert.rejects(run(), (err) => err.code === "DAILY_LIMIT" && /Tageslimit.*20 Anfragen pro Tag/.test(err.message));
  assert.equal(requests.length, 1, "no retries, and search is not blamed");
});

test("daily limit with a fallback model: continues with its own quota, starting over with the photo", async () => {
  const daily = "Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). Please retry in 58s.";
  const exhausted = [];
  const { run, requests, events } = setup([
    interaction([call("c1", "geocode", { query: "Bahnhofstraße" })]),
    () => json(429, { error: { message: daily, code: "too_many_requests" } }),
    interaction([call("c2", "geocode", { query: "Bahnhofstraße" })]),
    interaction([call("c3", "submit_result", VALID_SUBMISSION)]),
  ], { fallbackModels: ["gemini-3.7-flash"], onModelExhausted: (m) => exhausted.push(m) });
  const { analysis } = await run();
  assert.equal(analysis.city, "Freiburg");
  assert.deepEqual(requests.map((r) => r.body.model), ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.7-flash"]);
  assert.equal(requests[2].body.input.length, 1, "the new model starts with the photo only");
  assert.deepEqual(exhausted, ["gemini-3.8-flash"]);
  assert.ok(events.some(([t, d]) => t === "status" && /Tageslimit von gemini-3.8-flash erreicht – Ortfinder macht mit gemini-3.7-flash weiter/.test(d.message)));
});

test("Gemini overloaded (503) after the retries: the other free model takes over", async () => {
  const busy = () => json(503, { error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } });
  const exhausted = [];
  const { run, requests, events } = setup([
    busy, busy, busy, busy,
    interaction([call("c1", "submit_result", VALID_SUBMISSION)]),
  ], { fallbackModels: ["gemini-3.7-flash"], onModelExhausted: (m) => exhausted.push(m), retryBaseMs: 1, webSearch: false });
  const { analysis } = await run();
  assert.equal(analysis.city, "Freiburg");
  assert.deepEqual(requests.map((r) => r.body.model), ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.7-flash"]);
  assert.deepEqual(exhausted, [], "busy is not used up: it stays available for later analyses");
  assert.ok(events.some(([t, d]) => t === "status" && /^Gemini ist gerade überlastet \(HTTP 503\) – neuer Versuch/.test(d.message)));
  assert.ok(events.some(([t, d]) => t === "status" && d.message === "gemini-3.8-flash ist gerade überlastet – Ortfinder macht mit gemini-3.7-flash weiter."));
});

test("the model is told its round budget", async () => {
  const { run, requests } = setup([interaction([call("c1", "submit_result", VALID_SUBMISSION)])], { maxSteps: 7 });
  await run();
  assert.match(requests[0].body.input[0].content[0].text, /höchstens 7 Runden/);
});

test("dropped connections are retried", async () => {
  const { run, requests } = setup([
    () => { throw new TypeError("Failed to fetch"); },
    interaction([call("c1", "submit_result", VALID_SUBMISSION)]),
  ], { webSearch: false });
  const started = Date.now();
  await run();
  assert.equal(requests.length, 2);
  assert.ok(Date.now() - started >= 1900);
});

test("invalid API key gives a clear German error", async () => {
  const { run } = setup([
    () => json(400, [{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }]),
  ]);
  await assert.rejects(run(), (err) => err instanceof GeminiError && /API-Key ist ungültig/.test(err.message));
});

test("text-only answer is nudged, invalid submission gets an error result", async () => {
  const bad = { ...structuredClone(VALID_SUBMISSION), precision: "irgendwo" };
  const { run, requests } = setup([
    interaction([{ type: "model_output", content: [{ type: "text", text: "Freiburg." }] }], "completed"),
    interaction([call("c1", "submit_result", bad)]),
    interaction([call("c2", "submit_result", VALID_SUBMISSION)]),
  ]);
  const { analysis } = await run();
  assert.equal(analysis.precision, "strasse");
  const nudge = requests[1].body.input.at(-1);
  assert.equal(nudge.type, "user_input");
  assert.match(nudge.content[0].text, /submit_result/);
  const errorResult = requests[2].body.input.at(-1);
  assert.equal(errorResult.is_error, true);
  assert.match(errorResult.result, /precision/);
});

test("failed interaction and step limit raise", async () => {
  const failed = setup([interaction([], "failed")]);
  await assert.rejects(failed.run(), /fehlgeschlagen/);

  const loop = Array.from({ length: 3 }, (_, i) => interaction([call(`c${i}`, "geocode", { query: "x" })]));
  const limited = setup(loop, { maxSteps: 3 });
  await assert.rejects(limited.run(), /Schrittlimit/);
  const lastResult = limited.requests[2].body.input.at(-1);
  assert.match(lastResult.result, /Nur noch 1 Runde/);
});

test("abort stops the loop", async () => {
  const controller = new AbortController();
  controller.abort();
  const { run } = setup([interaction([])], { signal: controller.signal });
  await assert.rejects(run(), (err) => err.name === "AbortError");
});

test("assembleResult prefers EXIF GPS and reports the blind-test distance", () => {
  const analysis = { precision: "strasse", camera: { name: "X", lat: 47.99, lon: 7.85, radius_km: 1, confidence: 0.5 } };
  const r = assembleResult({ metadata: {}, exifLocation: { lat: 48.0, lon: 7.85, address: "Y" }, analysis, usage: {}, model: "m", seconds: 1 });
  assert.equal(r.final.source, "exif_gps");
  assert.ok(Math.abs(r.exif_vs_analysis_km - 1.11) < 0.05);
  const visual = assembleResult({ metadata: {}, exifLocation: null, analysis, usage: {}, model: "m", seconds: 1 });
  assert.equal(visual.final.source, "visual_analysis");
  assert.equal(assembleResult({ metadata: {}, exifLocation: null, analysis: null }).final, null);
});

test("preview makes OSM results readable", () => {
  assert.match(preview(JSON.stringify([{ name: "A", lat: 1, lon: 2 }])), /^1 Treffer: A \(1\.00000, 2\.00000\)/);
  assert.equal(preview(JSON.stringify({ total: 2, elements: [{ type: "node", tags: { name: "B" } }, { type: "way" }] })), "2 OSM-Treffer: B, way");
  assert.equal(preview([{ type: "text", text: "Ausschnitt" }, { type: "image" }]), "Ausschnitt [Bild]");
});

test("tools of one round run in parallel", async () => {
  const started = [];
  const finished = [];
  const { fetchImpl } = fakeGemini([
    interaction([call("c1", "geocode", { query: "a" }), call("c2", "geocode", { query: "b" })]),
    interaction([call("c3", "submit_result", VALID_SUBMISSION)]),
  ]);
  const slowOsm = {
    geocode: async (q) => {
      started.push(q);
      await new Promise((r) => setTimeout(r, 150));
      finished.push(q);
      return [{ name: q, lat: 1, lon: 2 }];
    },
  };
  const executor = new ToolExecutor({ zoom: async () => ({}), osm: slowOsm });
  const agent = new GeminiAgent({ apiKey: "k", webSearch: false, fetchImpl });
  const t0 = Date.now();
  await agent.run({ intro: "x", images: [], executor });
  assert.deepEqual(started, ["a", "b"]);
  assert.ok(Date.now() - t0 < 290, "both lookups overlapped");
});

test("a checkpoint after every round lets a new agent continue where the page was interrupted", async () => {
  const saved = [];
  const first = setup([interaction([call("c1", "geocode", { query: "Bahnhofstraße" })])], {
    webSearch: true,
    // The browser discards the page right after round 1 was saved.
    checkpoint: async (s) => { saved.push(structuredClone(s)); throw new Error("Seite verworfen"); },
  });
  await assert.rejects(first.run(), /Seite verworfen/);
  assert.equal(saved.length, 1);
  const [state] = saved;
  assert.equal(state.step, 1);
  assert.deepEqual(state.conversation.map((s) => s.type), ["user_input", "function_call", "function_result"]);
  assert.equal(state.usage.requests, 1);

  const second = setup([interaction([call("c2", "submit_result", VALID_SUBMISSION)])]);
  const { analysis, usage } = await second.agent.run({ intro: "egal", images: [], executor: second.executor, resume: state });
  assert.equal(analysis.city, "Freiburg");
  assert.deepEqual(second.requests[0].body.input, state.conversation, "continues with the saved history, not from scratch");
  assert.deepEqual(second.events.filter(([t]) => t === "step").map(([, d]) => d.step), [2]);
  assert.equal(usage.requests, 2);
});

test("while the page is in the background, dropped requests wait instead of failing", async () => {
  const drop = () => { throw new TypeError("Failed to fetch"); };
  let waits = 0;
  const started = Date.now();
  const { run, requests } = setup([drop, drop, drop, drop, interaction([call("c1", "submit_result", VALID_SUBMISSION)])], {
    whenActive: async () => (waits++ < 4), // hidden for the first four failures, then visible
  });
  const { analysis } = await run();
  assert.equal(analysis.city, "Freiburg");
  assert.equal(requests.length, 5, "four dropped requests, then the successful one");
  assert.ok(Date.now() - started < 1500, "no retry back-off: the wait for visibility replaces it");
});

test("the background wait is announced when it actually waits", async () => {
  let first = true;
  const { run, events } = setup([() => { throw new TypeError("Failed to fetch"); }, interaction([call("c1", "submit_result", VALID_SUBMISSION)])], {
    whenActive: () => (first ? ((first = false), new Promise((r) => setTimeout(() => r(true), 120))) : Promise.resolve(false)),
  });
  await run();
  assert.ok(events.some(([t, d]) => t === "status" && /im Hintergrund/.test(d.message)));
});

test("a request without any answer is aborted after the stall limit and sent again", async () => {
  let aborted = null;
  const { run, requests, events } = setup([
    (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => { aborted = init.signal.reason; reject(init.signal.reason); })),
    interaction([call("c1", "submit_result", VALID_SUBMISSION)]),
  ], { webSearch: false, stallMs: 40 });
  const { analysis } = await run();
  assert.equal(analysis.subject.name, "Martinstor");
  assert.equal(requests.length, 2);
  assert.equal(aborted?.name, "StallError", "the hanging connection was closed");
  assert.ok(events.some(([t, d]) => t === "warning" && /kein Lebenszeichen/.test(d.message)));
});

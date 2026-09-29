// A typical analysis (8 rounds: zooms, place search, aerial images, 3D, resection, top view, submit) played
// through each agent's real request code with fake transports. Returns the estimated tokens of every request,
// so the token budget can be measured and guarded by a test (see token-budget.test.mjs).

import Anthropic from "../../docs/vendor/anthropic-sdk.mjs";
import { GeminiAgent } from "../../docs/js/agent.js";
import { ClaudeAgent, loadSdk } from "../../docs/js/claude-agent.js";
import { OllamaAgent } from "../../docs/js/ollama-agent.js";
import { PuterAgent } from "../../docs/js/puter-agent.js";
import { ToolExecutor } from "../../docs/js/tools.js";

// ---------- fake JPEGs that only carry their size ----------

/** Minimal JPEG bytes with an SOF0 header (enough for token estimates), as base64. */
export function fakeJpeg(w, h) {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
  return Buffer.from(bytes).toString("base64");
}

export function jpegSize(b64) {
  const buf = Buffer.from(b64.replace(/^data:[^,]+,/, ""), "base64");
  for (let i = 2; i + 8 < buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
  }
  return [0, 0];
}

// ---------- token estimates ----------

const textTokens = (s) => Math.ceil(String(s).length / 3.6);
/** Claude/OpenAI-style vision: about w·h/750 tokens after fitting into 1568 px and 1.15 MP. */
export function pixelImageTokens(w, h) {
  let s = Math.min(1, 1568 / Math.max(w, h));
  s = Math.min(s, Math.sqrt(1.15e6 / (w * h)));
  return Math.ceil((w * s * h * s) / 750);
}
const GEMINI_IMAGE = { high: 1120, medium: 560, low: 280 };

// ---------- the scenario ----------

const P = { lat: 47.99, lon: 7.85 };
export const ROUNDS = [
  [["zoom_image", { x_min: 0.66, y_min: 0.6, x_max: 0.95, y_max: 0.76, enhance: true, purpose: "Schild" }],
    ["zoom_image", { x_min: 0.1, y_min: 0.3, x_max: 0.4, y_max: 0.6, purpose: "Fassade" }],
    ["zoom_image", { x_min: 0.4, y_min: 0.1, x_max: 0.7, y_max: 0.4, purpose: "Turm" }],
    ["geocode", { query: "Bahnhofstraße Freiburg", country_codes: "de" }],
    ["mark_hypothesis", { label: "Südbaden", camera_lat: P.lat, camera_lon: P.lon, radius_km: 30 }]],
  [["zoom_image", { x_min: 0.2, y_min: 0.7, x_max: 0.3, y_max: 0.8, purpose: "Kennzeichen" }],
    ["overpass_query", { query: "[out:json];node(47.9,7.8,48,7.9)[shop];out center 30;", purpose: "Geschäfte" }],
    ["nearby_features", { lat: P.lat, lon: P.lon, radius_m: 150 }]],
  [["map_view", { lat: P.lat, lon: P.lon, zoom: 18, layer: "satellit" }],
    ["map_view", { lat: P.lat + 0.001, lon: P.lon, zoom: 18, layer: "satellit" }],
    ["street_geometry", { name: "Bahnhofstraße", lat: P.lat, lon: P.lon }]],
  [["map_view", { lat: P.lat, lon: P.lon, zoom: 19, layer: "satellit" }],
    ["render_view", { lat: P.lat, lon: P.lon, bearing_deg: 350, fov_deg: 65 }]],
  [["solve_camera", { camera_lat: P.lat, camera_lon: P.lon, eye_height_m: 1.6, points: [
    { x: 0.2, y: 0.8, lat: 47.9902, lon: 7.8499 }, { x: 0.8, y: 0.8, lat: 47.9902, lon: 7.8501 },
    { x: 0.45, y: 0.62, lat: 47.991, lon: 7.84995 }, { x: 0.6, y: 0.6, lat: 47.9915, lon: 7.8501 }] }]],
  [["top_view", { camera_lat: P.lat, camera_lon: P.lon, bearing_deg: 350, fov_deg: 65, pitch_deg: -3 }]],
  [["render_view", { lat: P.lat, lon: P.lon, bearing_deg: 350, fov_deg: 65, texture: "satellit" }]],
  [["submit_result", null]],
];
/** The same analysis now that solve_camera brings the top view along (one round fewer). */
export const ROUNDS_NOW = ROUNDS.filter((r) => r[0][0] !== "top_view");

const SUBMISSION = {
  summary: "Freiburg, Bahnhofstraße.", precision: "strasse", country: "Deutschland", region: "Baden-Württemberg", city: "Freiburg",
  camera: { name: "Bahnhofstraße", lat: 47.99, lon: 7.85, radius_km: 0.05, confidence: 0.8 },
  subject: { name: "Martinstor", lat: 47.9925, lon: 7.8495, radius_km: 0.05 },
  view: { bearing_deg: 350, fov_deg: 65, distance_m: 280 },
  candidates: [], clues: [{ category: "schild", description: "Straßenschild", implication: "Deutschland", strength: "stark", box: [0.7, 0.6, 0.9, 0.7] }],
  text_found: ["Bahnhofstraße"], verification: "per geocode bestätigt",
};

/** Realistic tool outputs (sizes as the real tools produce them). */
function makeExecutor() {
  const features = Array.from({ length: 70 }, (_, i) => ({ name: `Geschäft ${i}`, kind: "shop/bakery", distance_m: 20 + i, bearing_deg: (i * 37) % 360, lat: 47.99 + i * 1e-5, lon: 7.85 + i * 1e-5, tags: { "addr:street": "Bahnhofstraße", "addr:housenumber": String(i), opening_hours: "Mo-Fr 07:00-18:00" } }));
  const elements = Array.from({ length: 60 }, (_, i) => ({ type: "node", id: 1e9 + i, lat: 47.99, lon: 7.85, tags: { name: `Laden ${i}`, shop: "clothes", "addr:street": "Kaiser-Joseph-Straße", "addr:housenumber": String(i), website: `https://example.org/${i}` } }));
  const osm = {
    geocode: async (q) => Array.from({ length: 5 }, (_, i) => ({ name: `${q} ${i}, 79098 Freiburg im Breisgau, Baden-Württemberg, Deutschland`, lat: 47.99 + i / 100, lon: 7.85, kind: "highway/residential", importance: 0.4 })),
    reverse: async () => ({ name: "Bahnhofstraße 1, Freiburg" }),
    overpass: async () => ({ total: 60, elements }),
    nearbyFeatures: async (lat, lon, r) => ({ center: { lat, lon }, radius_m: r, total: 70, features }),
    streetGeometry: async (name) => ({ name, found: true, closest_point: { lat: 47.99, lon: 7.85, distance_m: 12 }, ways: Array.from({ length: 8 }, (_, i) => ({ id: i, segments: Array.from({ length: 6 }, (_, j) => ({ from: [47.99 + j / 1e4, 7.85], to: [47.99 + (j + 1) / 1e4, 7.85], street_bearing_deg: 350 + j })) })) }),
  };
  return new ToolExecutor({
    zoom: async () => ({ data: fakeJpeg(1536, 800), width: 1536, height: 800, sourceWidth: 480, sourceHeight: 250, thumbnail: "data:," }),
    mapView: async () => ({ data: fakeJpeg(768, 768), width: 768, height: 768, metersPerPixel: 0.3, spanM: 230, gridM: 25, thumbnail: "data:," }),
    renderView: async () => ({ data: fakeJpeg(768, 480), thumbnail: "data:,", note: "", stats: { buildings: 30, heights_from_osm_pct: 40, terrain: true, ground_m: 278, building_ahead_m: 41, skyline_distance_m: 5400, texture: "modell" } }),
    topView: async () => ({ data: fakeJpeg(1288, 470), thumbnail: "data:,", stats: { covered_pct: 44, width_m: 674, height_m: 444, m_per_px: 1.05, grid_m: 200, nearest_m: 60, farthest_m: 650, terrain: true, ground_m: 278, imagery_tiles: 16 } }),
    solveCamera: async ({ points }) => ({
      camera: { lat: 47.99, lon: 7.85, eye_height_m: 1.6, moved_m: 0 }, view: { bearing_deg: 350, pitch_deg: -3, roll_deg: 0, fov_deg: 65 },
      points: points.map((p, i) => ({ index: i + 1, error_px: 8, error_pct: 0.5 })), rms_px: 8, rms_pct: 0.5, solved_position: false,
      geometry: { spreadDeg: 20, depthRatio: 2, strong: false },
    }),
    osm,
  });
}

/** First message images exactly as app.js builds them (photo ≥ 2000 px). */
export function firstImages(builder) {
  return builder({ fakeJpeg });
}

const THOUGHT = "Ich prüfe das Schild unten rechts und vergleiche mit der Karte. ".repeat(6);
let SCRIPT = ROUNDS;

// ---------- per provider: drive the agent, collect request token estimates ----------

async function runGemini(images, intro) {
  const requests = [];
  let round = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(estimateGemini(body));
    const calls = SCRIPT[round++];
    const steps = [{ type: "thought", signature: "c2ln".repeat(200), summary: [{ type: "text", text: THOUGHT }] },
      ...calls.map(([name, args], i) => ({ type: "function_call", id: `c${round}-${i}`, name, arguments: name === "submit_result" ? SUBMISSION : args }))];
    return new Response(JSON.stringify({ id: "", status: "requires_action", steps, usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const agent = new GeminiAgent({ apiKey: "x", fetchImpl, webSearch: false, maxSteps: 12 });
  await agent.run({ intro, images, executor: makeExecutor() });
  return requests;
}

function estimateGemini(body) {
  let text = 0;
  let img = 0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (v.type === "image") { img += GEMINI_IMAGE[v.resolution || "high"] ?? 1120; return; }
    for (const [k, val] of Object.entries(v)) {
      if (k === "signature") continue;
      if (typeof val === "string") text += textTokens(val);
      else walk(val);
    }
  };
  walk(body.input);
  text += textTokens(JSON.stringify(body.tools || [])) + textTokens(JSON.stringify(body.system_instruction || ""));
  return { text, images: img, total: text + img };
}

function estimateOpenAI(messages, tools, imageTokens) {
  let text = textTokens(JSON.stringify(tools || []));
  let img = 0;
  for (const m of messages) {
    if (typeof m.content === "string") text += textTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "image_url") { const [w, h] = jpegSize(p.image_url.url); img += imageTokens(w, h); } else text += textTokens(p.text || "");
      }
    }
    if (m.tool_calls) text += textTokens(JSON.stringify(m.tool_calls));
    if (m.reasoning) text += textTokens(m.reasoning);
  }
  return { text, images: img, total: text + img };
}

async function runOpenAIStyle(images, intro, { imageTokens, ...options }) {
  const requests = [];
  let round = 0;
  const chat = async (messages, opts) => {
    requests.push(estimateOpenAI(messages, opts.tools, imageTokens));
    const calls = SCRIPT[round++];
    return {
      message: {
        role: "assistant", content: null, reasoning: THOUGHT,
        tool_calls: calls.map(([name, args], i) => ({ id: `c${round}-${i}`, type: "function", function: { name, arguments: JSON.stringify(name === "submit_result" ? SUBMISSION : args) } })),
      },
      finish_reason: "tool_calls", usage: {},
    };
  };
  const agent = new PuterAgent({ chat, maxSteps: 12, ...options });
  await agent.run({ intro, images, executor: makeExecutor() });
  return requests;
}

async function runOllama(images, intro) {
  const requests = [];
  let round = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    let text = textTokens(JSON.stringify(body.tools || []));
    let img = 0;
    for (const m of body.messages) {
      text += textTokens(m.content || "") + (m.tool_calls ? textTokens(JSON.stringify(m.tool_calls)) : 0);
      for (const b64 of m.images || []) { const [w, h] = jpegSize(b64); img += pixelImageTokens(w, h); }
    }
    requests.push({ text, images: img, total: text + img });
    const calls = SCRIPT[round++];
    const line = { message: { role: "assistant", content: "", tool_calls: calls.map(([name, args]) => ({ function: { name, arguments: name === "submit_result" ? SUBMISSION : args } })) }, done: true, done_reason: "stop" };
    return new Response(`${JSON.stringify(line)}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };
  const agent = new OllamaAgent({ fetchImpl, maxSteps: 12 });
  await agent.run({ intro, images, executor: makeExecutor() });
  return requests;
}

function sse(content) {
  const ev = [["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }]];
  content.forEach((b, index) => {
    if (b.type === "thinking") {
      ev.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } }]);
    } else {
      ev.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    ev.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 50 } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return new Response(ev.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** Claude: tokens written to / read from the prompt cache as well (cache reads cost a tenth). */
async function runClaude(images, intro) {
  await loadSdk();
  const requests = [];
  let round = 0;
  let previous = null;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    // Tokens of each top-level piece, in order; the cached prefix is what the previous request already sent.
    const pieces = [textTokens(JSON.stringify(body.tools)) + textTokens(body.system)];
    for (const m of body.messages) {
      for (const b of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) {
        if (b.type === "image") { const [w, h] = jpegSize(b.source.data); pieces.push(pixelImageTokens(w, h)); continue; }
        if (b.type === "tool_result") {
          const parts = typeof b.content === "string" ? [{ type: "text", text: b.content }] : b.content;
          for (const p of parts) pieces.push(p.type === "image" ? pixelImageTokens(...jpegSize(p.source.data)) : textTokens(p.text));
          continue;
        }
        pieces.push(textTokens(JSON.stringify(b)));
      }
    }
    const signature = JSON.stringify(body.messages).length;
    let same = 0;
    if (previous) {
      const a = JSON.stringify([body.tools, body.system, body.messages]);
      const b = previous.raw;
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      same = i / a.length; // share of the request identical to the previous prefix (≈ cache hit)
    }
    const total = pieces.reduce((s, v) => s + v, 0);
    previous = { raw: JSON.stringify([body.tools, body.system, body.messages]), signature };
    const cacheRead = Math.round(total * same);
    requests.push({ text: total, images: 0, total, cacheRead, fresh: total - cacheRead, cost: Math.round((total - cacheRead) * 1.25 + cacheRead * 0.1) });
    const calls = SCRIPT[round++];
    return sse([{ type: "thinking", thinking: THOUGHT }, ...calls.map(([name, args], i) => ({ type: "tool_use", id: `t${round}-${i}`, name, input: name === "submit_result" ? SUBMISSION : args }))]);
  };
  const client = new Anthropic({ apiKey: "x", dangerouslyAllowBrowser: true, fetch, maxRetries: 0 });
  const agent = new ClaudeAgent({ client, maxSteps: 12 });
  await agent.run({ intro, images, executor: makeExecutor() });
  return requests;
}

export async function measureAll({ intro, images, rounds = ROUNDS }) {
  SCRIPT = rounds;
  const sum = (reqs, key = "total") => reqs.reduce((s, r) => s + (r[key] ?? 0), 0);
  const out = {};
  // perRequest: the estimate of every request (text and images apart), e.g. for the estimate's profile.
  const gem = await runGemini(images, intro);
  out.gemini = { requests: gem.length, tokens: sum(gem), images: sum(gem, "images"), perRequest: gem };
  const puter = await runOpenAIStyle(images, intro, { imageTokens: () => 1120 });
  out.puter = { requests: puter.length, tokens: sum(puter), images: sum(puter, "images"), perRequest: puter };
  const orouter = await runOpenAIStyle(images, intro, { imageTokens: pixelImageTokens });
  out.openrouter = { requests: orouter.length, tokens: sum(orouter), images: sum(orouter, "images"), perRequest: orouter };
  const ollama = await runOllama(images, intro);
  out.ollama = { requests: ollama.length, tokens: sum(ollama), images: sum(ollama, "images"), perRequest: ollama };
  const claude = await runClaude(images, intro);
  out.claude = { requests: claude.length, tokens: sum(claude), billed_equivalent: sum(claude, "cost"), perRequest: claude };
  return out;
}

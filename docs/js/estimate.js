// Before an analysis: what it will probably do round by round, how many tokens that takes and – for paid
// services – what it costs, plus what is left of a free allowance. The text per round comes from a
// typical analysis played through each service's real request code (tests/js/token-scenario.mjs; a test
// keeps these numbers in step with it); the pictures are counted for the actual photo.

import { fitSize, MODEL_MAX_SIDE, ZOOM_MAX_SIDE } from "./imaging.js";

/** Text tokens each request sends in the typical analysis (system prompt, tools, history, results). */
export const TEXT_PROFILE = {
  gemini: [5220, 5741, 13435, 8026, 7504, 7906, 8166],
  chat: [5247, 5985, 13750, 8606, 8316, 9004, 9373], // OpenAI style: Puter, OpenRouter, the other services, own PC
  claude: [5289, 5908, 13560, 15122, 15492, 15902, 16144], // Claude keeps its history unchanged (prompt cache)
};

/**
 * What the typical analysis does in each round, and the pictures its tools bring back (they go along with
 * the next round). Rounds beyond these are a reserve the AI only uses when needed.
 */
export const PLAN = [
  { steps: "Überblick: Zooms auf Schrift und Schilder, erste Ortssuche", images: [[1536, 800], [1536, 800], [1536, 800]] },
  { steps: "Weiterer Zoom, Geschäfte und Umgebung abfragen", images: [[1536, 800]] },
  { steps: "Luftbilder vergleichen, Straßenverlauf prüfen", images: [[768, 768], [768, 768]] },
  { steps: "Luftbild im Detail, 3D-Nachbau oder Bergkamm-Abgleich", images: [[768, 768], [768, 480]] },
  { steps: "Rückwärtsschnitt: Standpunkt aufs Haus, mit Draufsicht", images: [[1288, 470]] },
  { steps: "Gegenprobe: 3D-Nachbau mit Luftbild", images: [[768, 480]] },
  { steps: "Ergebnis abgeben", images: [] },
];
export const TYPICAL_ROUNDS = PLAN.length;
const RESERVE = { steps: "Reserve für weitere Prüfungen (nur falls nötig)", images: [[768, 768]] };
const VISIBLE_OUTPUT = 250; // tool calls and notes per round
const SUBMISSION_OUTPUT = 900; // the result itself

// ---------- pictures ----------

/** Claude-style vision (also a good guess for most others): about w·h/750 after fitting 1568 px / 1.15 MP. */
export function pixelImageTokens(w, h) {
  let s = Math.min(1, 1568 / Math.max(w, h));
  s = Math.min(s, Math.sqrt(1.15e6 / (w * h)));
  return Math.ceil((w * s * h * s) / 750);
}

/** OpenAI GPT (high detail): fit into 2048², shortest side 768, then 170 per 512-px tile plus 85. */
export function gptImageTokens(w, h) {
  let s = Math.min(1, 2048 / Math.max(w, h));
  s *= Math.min(1, 768 / Math.min(w * s, h * s));
  return 85 + 170 * Math.ceil((w * s) / 512) * Math.ceil((h * s) / 512);
}

/** Tokens of one picture for a service (and model). */
export function imageTokensFor(provider, model = "") {
  if (provider === "gemini" || (provider === "puter" && /gemini/.test(model)) || (provider === "poe" && /gemini/.test(model))) return () => 1120;
  if (provider === "deepseek") return (w, h) => Math.min(1024, pixelImageTokens(w, h));
  if (provider === "groq") return () => 2048;
  if (provider === "openai" || /gpt/.test(model)) return gptImageTokens;
  return pixelImageTokens;
}

/** What goes to the AI of this photo: the overview with its ruler, and the four detail tiles of big photos. */
export function photoParts(width, height) {
  const [w, h] = fitSize(width, height, MODEL_MAX_SIDE);
  const overview = [w + 44, h + 44];
  const tiles = Math.max(width, height) >= 2000 ? Array(4).fill(fitSize(Math.round(width * 0.54), Math.round(height * 0.54), ZOOM_MAX_SIDE)) : [];
  return { overview, tiles };
}

// ---------- thinking and prices ----------

/** Tokens the model thinks per round (billed as output) – rough, by service and model. */
export function thinkingTokens(provider, model = "", level = "medium") {
  if (provider === "gemini") return { low: 600, medium: 1500, high: 3500 }[level] ?? 1500;
  if (provider === "ollama") return 500;
  if (provider === "mistral") return 200;
  if (/opus|astra|pro\b|-pro/.test(model)) return 2500;
  if (/flash-lite|nano|luna|small|qwen3\.5-flash/.test(model)) return 500;
  return 1200;
}

/** US dollars per million tokens [input, output] (standard price, short prompts; as of September 2026). */
export const PRICES = {
  "gemini-3.8-flash": [0.75, 3.75],
  "gemini-3.7-flash": [0.75, 3.75],
  "gemini-3.1-pro-preview": [2, 12],
  "gemini-3.1-flash-lite": [0.25, 1.5],
  "gpt-5.4-mini": [0.68, 4.09],
  "qwen3.5-flash": [0.09, 0.37],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
  "deepseek-flash": [0.3, 1.2],
  "mistral-medium-latest": [1.5, 7.5],
  "mistral-large-latest": [0.5, 1.5],
  "mistral-small-latest": [0.15, 0.6],
  "qwen3.6-plus": [0.5, 3],
  "qwen3.6-flash": [0.25, 1.5],
  "gpt-6-luna": [0.1, 0.5],
  "gpt-6-sol": [2, 10],
  "gpt-6-astra": [10, 50],
  "grok-4.7": [2, 6],
  "grok-4.3": [1.25, 2.5],
};

// ---------- the estimate ----------

/** Which step each round of a budget of `rounds` is: the typical plan, shortened to end with the result. */
export function planFor(rounds) {
  const n = Math.max(1, Math.round(rounds));
  if (n >= TYPICAL_ROUNDS) return [...PLAN, ...Array(n - TYPICAL_ROUNDS).fill(RESERVE)];
  return [...PLAN.slice(0, n - 1), PLAN.at(-1)];
}

/**
 * The analysis round by round: steps, tokens sent and received. rounds = the round budget (Max. Runden); a
 * typical analysis needs about seven, rounds beyond are a reserve (shown, counted only in the maximum).
 * Claude's cached repeats cost a tenth: the costs count its input at a third (measured over a whole run).
 */
export function estimateAnalysis({ provider, model = "", thinking = "medium", width, height, rounds, prices = null }) {
  const imageTokens = imageTokensFor(provider, model);
  const profile = provider === "gemini" ? TEXT_PROFILE.gemini : provider === "claude" ? TEXT_PROFILE.claude : TEXT_PROFILE.chat;
  const growth = profile.at(-1) - profile.at(-2);
  const { overview, tiles } = photoParts(width, height);
  const photo = imageTokens(...overview);
  const tileTokens = tiles.reduce((s, t) => s + imageTokens(...t), 0);
  const maxImages = provider === "groq" ? 3 : Infinity;
  const think = thinkingTokens(provider, model, thinking);
  const steps = planFor(rounds);
  let kept = 0; // Claude sends every earlier picture again
  const plan = steps.map((step, i) => {
    const k = i + 1;
    const text = profile[i] ?? profile.at(-1) + growth * (k - profile.length);
    // Pictures in this request: the photo, and the detail tiles (round 1) or what the last round brought back.
    let pictures = k === 1 ? tiles.map((t) => imageTokens(...t)) : steps[i - 1].images.map((p) => imageTokens(...p));
    if (pictures.length + 1 > maxImages) pictures = pictures.slice(-(maxImages - 1));
    const fresh = pictures.reduce((s, v) => s + v, 0);
    kept += fresh;
    const input = text + photo + (provider === "claude" ? kept : fresh);
    const final = step === PLAN.at(-1);
    return { round: k, steps: step.steps, input, output: VISIBLE_OUTPUT + think + (final ? SUBMISSION_OUTPUT : 0), reserve: step === RESERVE };
  });
  const totals = (rows) => ({ rounds: rows.length, input: rows.reduce((s, r) => s + r.input, 0), output: rows.reduce((s, r) => s + r.output, 0) });
  const typical = totals(plan.filter((r) => !r.reserve));
  const max = totals(plan);
  const price = prices || PRICES[model];
  const billed = provider === "claude" ? 0.33 : 1;
  const cost = price ? (t) => (t.input * billed * price[0] + t.output * price[1]) / 1e6 : null;
  return {
    plan, photo, tiles: tiles.length, tileTokens, typical, max,
    cost: cost ? { typical: cost(typical), max: cost(max), price } : null,
  };
}

// ---------- free allowances counted in this browser ----------

const LEDGER_KEY = "ortfinder.usage.v1";

/** Requests made today per service and model (a day as the service counts it). */
export function usedToday(storage, id, day) {
  try {
    const all = JSON.parse(storage.getItem(LEDGER_KEY) || "{}");
    return all[day]?.[id] || 0;
  } catch {
    return 0;
  }
}

export function recordUse(storage, id, day, requests) {
  try {
    const all = JSON.parse(storage.getItem(LEDGER_KEY) || "{}");
    const keep = Object.fromEntries(Object.entries(all).filter(([d]) => d >= day).slice(-3)); // today (and later) only
    keep[day] = { ...keep[day], [id]: (keep[day]?.[id] || 0) + requests };
    storage.setItem(LEDGER_KEY, JSON.stringify(keep));
  } catch {
    // storage full or blocked: the count just stays unknown
  }
}

const HISTORY_KEY = "ortfinder.actual.v1";

/** Actual use of the last analyses per service and model (tokens and rounds), newest first. */
export function recordActual(storage, id, usage) {
  if (!usage?.requests) return;
  try {
    const all = JSON.parse(storage.getItem(HISTORY_KEY) || "{}");
    const entry = { rounds: usage.requests, input: usage.input_tokens || 0, output: (usage.output_tokens || 0) + (usage.thought_tokens || 0) };
    all[id] = [entry, ...(all[id] || [])].slice(0, 5);
    storage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch {
    // not kept
  }
}

export function actualAverage(storage, id) {
  try {
    const list = JSON.parse(storage.getItem(HISTORY_KEY) || "{}")[id] || [];
    const withTokens = list.filter((e) => e.input > 0);
    if (!withTokens.length) return null;
    const avg = (k) => Math.round(withTokens.reduce((s, e) => s + e[k], 0) / withTokens.length);
    return { count: withTokens.length, rounds: avg("rounds"), input: avg("input"), output: avg("output") };
  } catch {
    return null;
  }
}

// ---------- formatting ----------

export const formatTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 1 })} Mio.` : n >= 1000 ? `${Math.round(n / 1000)} Tsd.` : String(Math.round(n)));

export function formatMoney(usd) {
  if (usd < 0.01) return "unter 1 Cent";
  if (usd < 1) return `ca. ${Math.round(usd * 100)} Cent`;
  return `ca. ${usd.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

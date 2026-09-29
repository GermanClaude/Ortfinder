// Geolocation agent on the Gemini Interactions API (stateless: store=false, full history per request).

import { haversineKm } from "./geo.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { FUNCTION_TOOLS, SUBMIT_TOOL, ToolInputError, buildTools, validateSubmission } from "./tools.js";
import { compactGemini, splitTiles } from "./compact.js";
import { MAX_STALLS, STALL_MS, StallError, stallGiveUp, stallLimit, stallNote, watch } from "./watchdog.js";

export const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const MODELS = [
  { id: "gemini-3.8-flash", label: "3.8 Flash (empfohlen)" },
  { id: "gemini-3.1-pro-preview", label: "3.1 Pro (kostenpflichtig)" },
  { id: "gemini-3.7-flash", label: "3.7 Flash" },
];
const MAX_NUDGES = 2;
const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_RETRIES = 6;
// Switches between the free models in one analysis (away when busy or stuck, back after a pause).
const MAX_SWITCHES = 6;
const BACK_AFTER_MS = 90000;
export const HANDOFF_MARK = "Bisheriger Stand dieser Analyse";
export const cut = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * The analysis so far for another model: its thinking cannot be carried over (it is signed for the model
 * that wrote it), but what was looked up and found can – as a transcript next to the photo, with the
 * latest round's pictures. The detail tiles are left out (zoom_image gives details).
 */
export function handoffHistory(history, from, to) {
  const [first, ...rest] = history;
  if (!rest.length) return history;
  const [blocks] = splitTiles(first.content);
  // An earlier hand-over: its transcript continues, its pictures are old by now.
  const h = blocks.findIndex((b) => b.type === "text" && b.text.startsWith(HANDOFF_MARK));
  const lines = h < 0 ? [] : blocks[h].text.split("\n").slice(1);
  let latest = history.length;
  while (latest > 1 && history[latest - 1].type === "function_result") latest--;
  const images = [];
  const texts = (content) => (Array.isArray(content) ? content : []).filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
  rest.forEach((step, j) => {
    if (step.type === "model_output") {
      const text = texts(step.content);
      if (text) lines.push(`KI: ${cut(text, 600)}`);
    } else if (step.type === "function_call") {
      lines.push(`→ ${step.name} ${cut(JSON.stringify(step.arguments ?? {}), 400)}`);
    } else if (step.type === "function_result") {
      const result = typeof step.result === "string" ? [{ type: "text", text: step.result }] : step.result || [];
      const pictures = result.filter((b) => b.type === "image");
      const current = j + 1 >= latest;
      lines.push(`  ← ${cut(texts(result), 800)}${pictures.length ? ` [${pictures.length} Bild(er)${current ? ", unten angehängt" : ""}]` : ""}`);
      if (current) for (const b of pictures) images.push({ type: "text", text: `Bild aus ${step.name}:` }, b);
    } else if (step.type === "user_input") {
      const text = texts(step.content);
      if (text) lines.push(`Hinweis: ${cut(text, 400)}`);
    }
  });
  const note = `${HANDOFF_MARK} (bis hier mit ${from}; du setzt als ${to} fort – Nachgeschlagenes gilt weiter, nicht nochmals abfragen, ` +
    `sondern darauf aufbauen):\n${lines.join("\n")}`;
  return [{ ...first, content: [...(h < 0 ? blocks : blocks.slice(0, h)), { type: "text", text: note }, ...images.slice(-4)] }];
}

export class GeminiError extends Error {
  constructor(message, { status = 0, code = "", retryable = false, retryAfterMs = 0, requestsPerMinute = 0 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.requestsPerMinute = requestsPerMinute;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Abgebrochen", "AbortError"));
    }, { once: true });
  });

function describeHttpError(status, body) {
  const err = (Array.isArray(body) ? body[0] : body)?.error || {};
  const message = err.message || `HTTP ${status}`;
  const reasons = (err.details || []).map((d) => d.reason).filter(Boolean);
  const retryInfo = (err.details || []).find((d) => d.retryDelay);
  // The Interactions API puts the hints into the message: "limit: 5 requests per minute … retry in 48s".
  const retryMatch = message.match(/retry in ([\d.]+)\s*s/i);
  const retryAfterMs = retryInfo ? parseFloat(retryInfo.retryDelay) * 1000 || 0 : retryMatch ? parseFloat(retryMatch[1]) * 1000 : 0;
  const rpmMatch = message.match(/limit:\s*(\d+)\s*requests? per minute/i);
  if (reasons.includes("API_KEY_INVALID") || /api key not valid/i.test(message)) {
    return new GeminiError("Der Gemini-API-Key ist ungültig. Einen neuen Key gibt es unter aistudio.google.com/apikey.", { status, code: "API_KEY_INVALID" });
  }
  if (status === 403) return new GeminiError(`Kein Zugriff: ${message}`, { status, code: err.status });
  if (status === 404) return new GeminiError(`Modell nicht gefunden oder nicht freigeschaltet: ${message}`, { status, code: err.status });
  const perDay = message.match(/limit:\s*(\d+)\s*requests? per day/i);
  if (status === 429 && perDay) {
    // Waiting doesn't help here; the quota resets daily (free tier: 20 requests per day).
    return new GeminiError(
      `Tageslimit des Gemini-Tarifs erreicht (${perDay[1]} Anfragen pro Tag). Morgen erneut versuchen – oder heute kostenlos unter ⚙ mit „OpenRouter“ weitermachen.`,
      { status, code: "DAILY_LIMIT" },
    );
  }
  if (status === 429) {
    return new GeminiError(`Kontingent/Rate-Limit erreicht: ${message}`, {
      status, code: err.status || err.code, retryable: true, retryAfterMs, requestsPerMinute: rpmMatch ? Number(rpmMatch[1]) : 0,
    });
  }
  if (status === 503 || /overloaded|unavailable/i.test(message)) {
    return new GeminiError(`Gemini ist gerade überlastet (HTTP ${status}): ${message}`, { status, code: err.status, retryable: true });
  }
  if (status >= 500) return new GeminiError(`Gemini-Serverfehler (HTTP ${status}): ${message}`, { status, code: err.status, retryable: true });
  return new GeminiError(`Anfrage abgelehnt (HTTP ${status}): ${message}`, { status, code: err.status });
}

const looksLikeSearchProblem = (err) => /search|grounding|google_search/i.test(err.message);

/** Short human-readable version of a tool result for the live log. */
export function preview(result) {
  let text;
  if (typeof result !== "string") {
    text = result.map((c) => (c.type === "text" ? c.text : "[Bild]")).join(" ");
  } else {
    text = result;
    let data;
    try {
      data = JSON.parse(result);
    } catch {
      data = null;
    }
    if (Array.isArray(data) && data.length && data.every((d) => d && typeof d === "object" && "name" in d)) {
      text = `${data.length} Treffer: ` + data.slice(0, 5).map((d) => `${d.name} (${d.lat.toFixed(5)}, ${d.lon.toFixed(5)})`).join(" | ");
    } else if (data && typeof data === "object" && Array.isArray(data.elements)) {
      const names = data.elements.slice(0, 8).map((el) => el.tags?.name || el.type);
      text = `${data.total} OSM-Treffer` + (names.length ? ": " + names.join(", ") : "");
    } else if (data && typeof data === "object" && "name" in data) {
      text = String(data.name);
    }
  }
  return text.length <= 600 ? text : text.slice(0, 600) + " …";
}

export class GeminiAgent {
  /**
   * `checkpoint(state)` is awaited after every round (state can be passed back as `resume` to run());
   * `whenActive()` resolves to true after waiting for a page that was in the background.
   */
  /**
   * fallbackModels: free models with their own daily quota to continue with when `model` has used up its
   * requests for today (Google counts the free tier per model); onModelExhausted(model) is told about it.
   */
  constructor({
    apiKey, model = MODELS[0].id, thinkingLevel = "medium", webSearch = true, maxSteps = 10, fetchImpl = globalThis.fetch.bind(globalThis),
    emit = () => {}, signal, checkpoint = async () => {}, whenActive = async () => false, fallbackModels = [], onModelExhausted = () => {},
    retryBaseMs = 2000, stallMs = STALL_MS, backAfterMs = BACK_AFTER_MS, tools = FUNCTION_TOOLS,
  } = {}) {
    this.tools = tools;
    this.backAfterMs = backAfterMs;
    this.retryBaseMs = retryBaseMs;
    this.stallMs = stallMs;
    this.slowestMs = 0;
    this.canSwitch = true; // set by run(): whether a busy or stuck model may be left for a fallback
    this.apiKey = apiKey;
    this.model = model;
    this.fallbackModels = [...fallbackModels];
    this.onModelExhausted = onModelExhausted;
    this.thinkingLevel = thinkingLevel;
    this.webSearch = webSearch;
    this.maxSteps = maxSteps;
    this.fetch = fetchImpl;
    this.emit = emit;
    this.signal = signal;
    this.checkpoint = checkpoint;
    this.whenActive = whenActive;
    this.usage = { requests: 0, input_tokens: 0, output_tokens: 0, thought_tokens: 0, cached_tokens: 0 };
    this.minIntervalMs = 0; // raised when Google reports a requests-per-minute limit (free tier: 5/min)
    this.lastRequestAt = 0;
  }

  async pace() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 1000) this.emit("status", { message: `Tarif-Limit: warte ${Math.ceil(wait / 1000)} s bis zur nächsten Anfrage …` });
    if (wait > 0) await sleep(wait, this.signal);
    this.lastRequestAt = Date.now();
  }

  async request(input) {
    const body = {
      model: this.model,
      store: false,
      system_instruction: SYSTEM_PROMPT,
      input: compactGemini(input), // earlier rounds' images and long results as short notes
      generation_config: { thinking_level: this.thinkingLevel, thinking_summaries: "auto" },
    };
    let stalls = 0;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let resp;
      const started = Date.now();
      try {
        // The answer is read under the watchdog, too: a body that stops arriving is just as stuck.
        resp = await watch(async (signal) => {
          const r = await this.fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
            body: JSON.stringify({ ...body, tools: buildTools(this.webSearch, this.tools) }),
            signal,
          });
          return r.ok ? { ok: true, data: await r.json() } : { ok: false, status: r.status, data: await r.json().catch(() => ({})) };
        }, stallLimit(this.slowestMs, stalls, this.stallMs), this.signal);
      } catch (err) {
        if (err.name === "AbortError") throw err;
        if (err instanceof StallError) {
          // No answer at all: another free model takes over, or the same round is asked again (a page in the
          // background waits to be visible first).
          if (!(await this.waitIfBackground())) {
            if (this.canSwitch && this.fallbackModels.length) {
              throw Object.assign(new GeminiError(`${this.model} antwortet nicht (${err.message}).`, { code: "STALLED", status: 504, retryable: true }), { switchable: true });
            }
            stalls += 1;
            if (stalls > MAX_STALLS) throw new GeminiError(stallGiveUp(stalls));
            this.emit("warning", { message: stallNote(err, stalls) });
          }
          attempt -= 1;
          continue;
        }
        // Browsers cut connections of pages in the background: wait until Ortfinder is visible again.
        if (await this.waitIfBackground()) {
          attempt = -1;
          continue;
        }
        // Dropped connections (mobile networks, long thinking turns) are usually transient.
        if (attempt < MAX_RETRIES) {
          this.emit("status", { message: `Verbindung zu Gemini unterbrochen – neuer Versuch in ${2 * 2 ** attempt} s …` });
          await sleep(2000 * 2 ** attempt, this.signal);
          continue;
        }
        throw new GeminiError(`Keine Verbindung zur Gemini API (${err.message || err.name}).`);
      }
      if (resp.ok) {
        this.slowestMs = Math.max(this.slowestMs, Date.now() - started);
        this.usage.requests += 1;
        return resp.data;
      }
      const err = describeHttpError(resp.status, resp.data);
      // Google Search grounding is not part of the free tier. Depending on the case Google reports that as
      // a search/grounding error or simply as 429 "exceeded your current quota", so both switch it off.
      if (this.webSearch && (looksLikeSearchProblem(err) || err.status === 429) && !["API_KEY_INVALID", "DAILY_LIMIT"].includes(err.code)) {
        this.webSearch = false;
        this.emit("warning", { message: "Google-Suche ist mit diesem Key/Tarif nicht verfügbar – weiter ohne Websuche." });
        continue;
      }
      if (err.requestsPerMinute) this.minIntervalMs = Math.ceil(60000 / err.requestsPerMinute) + 500;
      if (err.status >= 500 && (await this.waitIfBackground())) {
        attempt = -1;
        continue;
      }
      // Overloaded with another free model at hand: one short retry, then that model takes over.
      const switchable = err.status >= 500 && this.canSwitch && this.fallbackModels.length > 0;
      const maxRetries = err.status === 429 ? MAX_RATE_LIMIT_RETRIES : switchable ? 1 : MAX_RETRIES;
      if (err.retryable && attempt < maxRetries) {
        const wait = Math.min(err.retryAfterMs ? err.retryAfterMs + 1000 : this.retryBaseMs * 2 ** attempt, 90000);
        const why = err.requestsPerMinute ? `Tarif erlaubt ${err.requestsPerMinute} Anfragen pro Minute` : err.message.split(":")[0];
        this.emit("status", { message: `${why} – neuer Versuch in ${Math.round(wait / 1000)} s …` });
        await sleep(wait, this.signal);
        this.lastRequestAt = 0; // the wait above already covered the pacing interval
        continue;
      }
      if (switchable) err.switchable = true;
      throw err;
    }
  }

  async waitIfBackground() {
    const pending = this.whenActive();
    // Only announce the wait when there is one (whenActive resolves at once for a visible page).
    const waited = await Promise.race([pending, new Promise((r) => setTimeout(() => r("waiting"), 50))]);
    if (waited !== "waiting") return waited;
    this.emit("status", { message: "Ortfinder ist im Hintergrund – die Anfrage wird wiederholt, sobald die Seite wieder sichtbar ist." });
    return pending;
  }

  addUsage(usage = {}) {
    this.usage.input_tokens += usage.total_input_tokens || 0;
    this.usage.output_tokens += usage.total_output_tokens || 0;
    this.usage.thought_tokens += usage.total_thought_tokens || 0;
    this.usage.cached_tokens += usage.total_cached_tokens || 0;
  }

  emitSteps(steps) {
    for (const step of steps) {
      if (step.type === "thought") {
        const text = (step.summary || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        if (text) this.emit("thinking", { text });
      } else if (step.type === "model_output") {
        const text = (step.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        if (text) this.emit("note", { text });
      } else if (step.type === "google_search_call") {
        for (const query of step.arguments?.queries || []) this.emit("web_search", { query });
      } else if (step.type === "google_search_result") {
        this.emit("web_results", { count: (step.result || []).length, error: step.is_error ? "Suche fehlgeschlagen" : undefined });
      }
    }
  }

  /**
   * Run the agent loop.
   * @param {object} opts
   * @param {string} opts.intro - text for the first user turn
   * @param {Array} opts.images - image content blocks for the first user turn
   * @param {import('./tools.js').ToolExecutor} opts.executor
   * @param {object} [opts.resume] - a state from `checkpoint`: continue after that round
   */
  async run({ intro, images, executor, resume = null }) {
    const budget =
      `Budget: höchstens ${this.maxSteps} Runden (jede Antwort von dir ist eine Runde und kostet eine API-Anfrage). ` +
      "Bündle deshalb alle Zooms und Kartenabfragen, die du gerade brauchst, parallel in EINER Antwort.";
    let history = resume ? [...resume.conversation] : [{ type: "user_input", content: [{ type: "text", text: `${intro}\n\n${budget}` }, ...images] }];
    let nudges = resume?.nudges ?? 0;
    // A model left because it was busy or stuck (not used up) gets another chance after a pause.
    let switches = 0;
    let preferred = null;
    let backAt = 0;
    let pause = this.backAfterMs;
    let justSwitched = false; // the fallback first has to get a round done
    if (resume) {
      this.usage = { ...this.usage, ...resume.usage };
      if (resume.webSearch === false) this.webSearch = false;
      if (resume.model) {
        this.model = resume.model;
        this.fallbackModels = this.fallbackModels.filter((m) => m !== resume.model);
      }
    }
    const save = (step) => this.checkpoint({ conversation: history, step, nudges, usage: this.usage, webSearch: this.webSearch, model: this.model });

    for (let step = (resume?.step ?? 0) + 1; step <= this.maxSteps; step++) {
      this.signal?.throwIfAborted();
      if (preferred && !justSwitched && Date.now() >= backAt && switches < MAX_SWITCHES) {
        // Back to the model that was busy, so the free quotas are used evenly; the analysis so far goes along.
        const back = preferred;
        preferred = null;
        switches += 1;
        this.emit("status", { message: `Ortfinder versucht es wieder mit ${back} (der bisherige Stand geht mit).` });
        this.fallbackModels = [this.model, ...this.fallbackModels.filter((m) => m !== back && m !== this.model)];
        history = handoffHistory(history, this.model, back);
        this.model = back;
      }
      this.canSwitch = switches < MAX_SWITCHES;
      this.emit("step", { step, max_steps: this.maxSteps });
      let interaction;
      try {
        interaction = await this.request(history);
      } catch (err) {
        if ((err.code !== "DAILY_LIMIT" && !err.switchable) || !this.fallbackModels.length) throw err;
        // Today's free requests of this model are used up, or it is busy or stuck: the next free model has its
        // own quota and servers. It continues from a transcript of the analysis so far (see handoffHistory).
        const used = this.model;
        const next = this.fallbackModels.shift();
        if (err.code === "DAILY_LIMIT") {
          this.onModelExhausted(used);
          this.emit("status", { message: `Tageslimit von ${used} erreicht – Ortfinder macht mit ${next} weiter (eigenes Tageskontingent, der bisherige Stand geht mit).` });
        } else {
          switches += 1;
          this.fallbackModels.push(used); // only busy for now
          preferred = used;
          backAt = Date.now() + pause;
          this.emit("status", {
            message: `${used} ${err.code === "STALLED" ? "antwortet nicht" : "ist gerade überlastet"} – Ortfinder macht mit ${next} weiter ` +
              `(der bisherige Stand geht mit) und versucht es in ${Math.round(pause / 1000)} s wieder mit ${used}.`,
          });
          pause *= 2;
        }
        if (preferred === next) preferred = null;
        history = handoffHistory(history, used, next);
        this.model = next;
        justSwitched = true;
        nudges = 0;
        step -= 1;
        continue;
      }
      justSwitched = false;
      this.addUsage(interaction.usage);
      // Echo model steps exactly as received (thought signatures included); inputs are ours already.
      const steps = (interaction.steps || []).filter((s) => s.type !== "user_input" && s.type !== "function_result");
      this.emitSteps(steps);
      history.push(...steps);

      if (interaction.status === "failed") {
        const reason = (interaction.errors || []).map((e) => e.message).filter(Boolean).join("; ");
        throw new GeminiError(`Die Analyse ist fehlgeschlagen${reason ? ": " + reason : "."}`);
      }

      const calls = steps.filter((s) => s.type === "function_call");
      if (!calls.length) {
        nudges += 1;
        if (nudges > MAX_NUDGES) break;
        history.push({ type: "user_input", content: [{ type: "text", text: `Bitte gib dein Ergebnis jetzt mit \`${SUBMIT_TOOL}\` ab.` }] });
        await save(step);
        continue;
      }

      let submission = null;
      // Tools of one round run in parallel (OpenStreetMap lookups queue themselves for rate limits);
      // results keep the order of the calls.
      const results = await Promise.all(calls.map(async (call) => {
        if (call.name === SUBMIT_TOOL) {
          try {
            submission = validateSubmission(call.arguments);
            return { type: "function_result", name: call.name, call_id: call.id, result: "Ergebnis übernommen." };
          } catch (err) {
            if (!(err instanceof ToolInputError)) throw err;
            return { type: "function_result", name: call.name, call_id: call.id, is_error: true, result: `Ergebnis ungültig: ${err.message}. Bitte korrigiert erneut abgeben.` };
          }
        }
        this.emit("tool_call", { tool: call.name, input: call.arguments });
        const { result, isError } = await executor.run(call.name, call.arguments);
        this.emit("tool_result", { tool: call.name, is_error: isError, preview: preview(result) });
        return { type: "function_result", name: call.name, call_id: call.id, result, ...(isError ? { is_error: true } : {}) };
      }));
      if (submission) return { analysis: submission, usage: this.usage };

      const remaining = this.maxSteps - step;
      if (remaining <= 2) {
        // Budget warning rides along inside the last result, so the history stays call → result.
        const last = results[results.length - 1];
        const note = `Hinweis: Nur noch ${remaining} Runde(n) übrig – gib dein Ergebnis jetzt mit \`${SUBMIT_TOOL}\` ab.`;
        last.result = typeof last.result === "string" ? `${last.result}\n\n${note}` : [...last.result, { type: "text", text: note }];
      }
      history.push(...results);
      await save(step);
    }
    throw new GeminiError("Der Agent hat innerhalb des Schrittlimits kein Ergebnis abgegeben (in den Einstellungen mehr Runden erlauben).");
  }
}

/** Combine EXIF GPS and the visual analysis into the final answer. */
export function assembleResult({ metadata, exifLocation, analysis, usage, model, seconds }) {
  const result = { metadata, model, seconds };
  if (exifLocation) result.exif_location = exifLocation;
  if (analysis) {
    result.analysis = analysis;
    result.usage = usage;
    if (exifLocation) {
      // EXIF GPS is where the camera was, so it is compared with the estimated standpoint.
      const b = analysis.camera;
      result.exif_vs_analysis_km = Math.round(haversineKm(exifLocation.lat, exifLocation.lon, b.lat, b.lon) * 1000) / 1000;
    }
  }
  if (exifLocation) {
    result.final = { source: "exif_gps", name: exifLocation.address || "GPS-Position aus den Bild-Metadaten", lat: exifLocation.lat, lon: exifLocation.lon, radius_km: 0.05, confidence: 0.99, precision: "exakt" };
  } else if (analysis) {
    result.final = { source: "visual_analysis", ...analysis.camera, precision: analysis.precision };
  } else {
    result.final = null;
  }
  return result;
}

// Geolocation agent on the Claude API (Anthropic) with the visitor's own API key from the Claude Console.
// Uses the official SDK in the browser; the key stays in this browser and goes only to api.anthropic.com.
// The SDK (200 KB) is loaded on the first request, so other providers don't pay for it.

import { preview } from "./agent.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { FUNCTION_TOOLS, SUBMIT_TOOL, ToolInputError, validateSubmission } from "./tools.js";
import { MAX_STALLS, StallError, stallGiveUp, stallLimit, stallNote, watch } from "./watchdog.js";

export const CLAUDE_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5 (am genauesten, empfohlen)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (schneller, günstiger)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (am günstigsten)" },
];
export const CLAUDE_DEFAULT_MODEL = CLAUDE_MODELS[0].id;
export const CLAUDE_KEY_PATTERN = /^sk-ant-[\w-]{20,}$/;
export const CLAUDE_CONSOLE = "https://platform.claude.com";

// Opus 5: a request its safety filter declines is re-run server-side on the model Anthropic recommends for it.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set(["claude-opus-5"]);
const MAX_NUDGES = 2;
const MAX_REISSUES = 2;
const MAX_RETRIES = 3;

let sdkLoader = null;
let sdk = null;
/** Load the bundled SDK once (tests pass their own client and never need it). */
export function loadSdk() {
  sdkLoader ??= import("../vendor/anthropic-sdk.mjs").then((module) => (sdk = module));
  return sdkLoader;
}

export class ClaudeError extends Error {
  /** retryable: worth asking again after a pause; reissue: the answer was garbled, ask again at once. */
  constructor(message, { code = "", status = 0, retryable = false, retryAfterMs = 0, reissue = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.reissue = reissue;
  }
}

const apiMessage = (err) => String(err?.error?.error?.message || err?.message || err);

function retryAfter(err) {
  const value = Number(err?.headers?.get?.("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 120) * 1000 : 0;
}

/** Turn SDK errors into clear German messages with a hint what to do. */
export function describeClaudeError(err) {
  if (err instanceof ClaudeError) return err;
  if (sdk && err instanceof sdk.APIConnectionError) {
    return new ClaudeError("Keine Verbindung zu Claude (api.anthropic.com).", { code: "NETWORK", retryable: true });
  }
  if (sdk && err instanceof sdk.APIError) {
    const { status } = err;
    const message = apiMessage(err);
    if (status === 401) {
      return new ClaudeError(
        "Der Claude-API-Key ist ungültig oder wurde gelöscht. Unter platform.claude.com → API Keys einen neuen erstellen und unter ⚙ eintragen.",
        { code: "AUTH", status });
    }
    if (status === 400 && /credit balance|billing|purchase credits/i.test(message)) {
      return new ClaudeError(
        "Dein Guthaben bei Anthropic ist leer. Unter platform.claude.com → Settings → Billing Guthaben kaufen (ab 5 $) und das Foto erneut analysieren.",
        { code: "CREDITS", status });
    }
    if (status === 403) return new ClaudeError(`Dieser Claude-API-Key darf das nicht: ${message}`, { code: "PERMISSION", status });
    if (status === 404) {
      return new ClaudeError(`Das Modell ist für dein Anthropic-Konto nicht verfügbar (${message}). Unter ⚙ ein anderes Claude-Modell wählen.`, { code: "MODEL", status });
    }
    if (status === 413) {
      return new ClaudeError("Die Anfrage ist zu groß geworden (zu viele Bilder). Unter ⚙ weniger Runden einstellen.", { code: "TOO_LARGE", status });
    }
    if (status === 429) {
      return new ClaudeError(
        "Das Ratenlimit deines Anthropic-Kontos ist erreicht (neue Konten haben niedrige Limits, sie steigen mit der Nutzung).",
        { code: "RATE_LIMIT", status, retryable: true, retryAfterMs: retryAfter(err) || 20000 });
    }
    if (status === 529 || /overloaded/i.test(message)) {
      return new ClaudeError("Claude ist gerade überlastet.", { code: "OVERLOADED", status, retryable: true, retryAfterMs: retryAfter(err) });
    }
    if (status >= 500) return new ClaudeError(`Serverfehler bei Anthropic (HTTP ${status}).`, { code: "SERVER", status, retryable: true });
    return new ClaudeError(`Anfrage von Claude abgelehnt (HTTP ${status}): ${message.slice(0, 300)}`, { code: "REQUEST", status });
  }
  // Anything else broke while the SDK assembled the streamed answer (e.g. tool input that is not valid JSON).
  return new ClaudeError(`Die Antwort von Claude kam unvollständig an (${String(err?.message || err).slice(0, 120)}).`, { code: "STREAM", reissue: true });
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Abgebrochen", "AbortError"));
    }, { once: true });
  });

/** Our tool declarations in the Claude format; inputs stream as they are written (validated before use). */
export const CLAUDE_TOOLS = FUNCTION_TOOLS.map(({ name, description, parameters }) => ({
  name, description, input_schema: parameters, eager_input_streaming: true,
}));

/** Convert our content blocks (text / base64 image) to Claude content blocks. */
export function toClaudeBlocks(blocks) {
  return blocks
    .filter((b) => b.type === "image" || (b.type === "text" && b.text))
    .map((b) => b.type === "image"
      ? { type: "image", source: { type: "base64", media_type: b.mime_type, data: b.data } }
      : { type: "text", text: b.text });
}

function toolResult(id, result, isError = false) {
  const content = typeof result === "string" ? result : toClaudeBlocks(result);
  return { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

/**
 * The assistant turn as it goes back to the API. After a mid-answer switch to the fallback model, the
 * declined part keeps only its text: its thinking and tool calls are not continued.
 */
export function echoable(content) {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback");
  if (boundary < 0) return content;
  return content.filter((b, i) => i > boundary || (i < boundary && b.type === "text"));
}

export class ClaudeAgent {
  /**
   * `checkpoint(state)` is awaited after every round (state can be passed back as `resume` to run());
   * `whenActive()` resolves to true after waiting for a page that was in the background.
   * `client` replaces the SDK client (tests); otherwise one is made from `apiKey` (and `fetch`).
   */
  constructor({
    apiKey = "", model = CLAUDE_DEFAULT_MODEL, maxSteps = 10, client = null, fetch = undefined,
    emit = () => {}, signal, checkpoint = async () => {}, whenActive = async () => false, stallMs = 120000,
  } = {}) {
    this.apiKey = apiKey;
    // The stream carries thinking summaries, text and tool input as they are written; a long silence means stuck.
    this.stallMs = stallMs;
    this.model = model;
    this.maxSteps = maxSteps;
    this.client = client;
    this.fetch = fetch;
    this.emit = emit;
    this.signal = signal;
    this.checkpoint = checkpoint;
    this.whenActive = whenActive;
    this.announcedFallback = false;
    this.usage = { requests: 0, input_tokens: 0, output_tokens: 0, thought_tokens: 0, cached_tokens: 0 };
  }

  async getClient() {
    if (this.client) return this.client;
    const { default: Anthropic } = await loadSdk();
    // The key belongs to the visitor and never leaves their browser except to Anthropic.
    this.client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(this.fetch ? { fetch: this.fetch } : {}) });
    return this.client;
  }

  params(messages) {
    const haiku = this.model.startsWith("claude-haiku");
    return {
      model: this.model,
      max_tokens: haiku ? 32000 : 64000,
      // Haiku 4.5 predates adaptive thinking and takes a fixed budget instead.
      thinking: haiku ? { type: "enabled", budget_tokens: 8000 } : { type: "adaptive", display: "summarized" },
      cache_control: { type: "ephemeral" }, // each round re-reads the growing conversation from the cache
      system: SYSTEM_PROMPT,
      tools: CLAUDE_TOOLS,
      messages,
    };
  }

  async waitIfBackground() {
    const pending = this.whenActive();
    // Only announce the wait when there is one (whenActive resolves at once for a visible page).
    const waited = await Promise.race([pending, new Promise((r) => setTimeout(() => r("waiting"), 50))]);
    if (waited !== "waiting") return waited;
    this.emit("status", { message: "Ortfinder ist im Hintergrund – die Anfrage wird wiederholt, sobald die Seite wieder sichtbar ist." });
    return pending;
  }

  /** One streamed request (streaming avoids timeouts on long answers); returns the complete message. */
  async request(messages) {
    const client = await this.getClient();
    let stalls = 0;
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      try {
        const params = this.params(messages);
        const message = await watch((signal, alive) => {
          const stream = FALLBACK_MODELS.has(this.model)
            ? client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" }, { signal })
            : client.messages.stream(params, { signal });
          stream.on?.("streamEvent", () => alive());
          return stream.finalMessage();
        }, stallLimit(0, stalls, this.stallMs), this.signal);
        this.usage.requests += 1;
        return message;
      } catch (raw) {
        if (this.signal?.aborted) throw this.signal.reason ?? new DOMException("Abgebrochen", "AbortError");
        if (raw instanceof StallError) {
          if (!(await this.waitIfBackground())) {
            stalls += 1;
            if (stalls > MAX_STALLS) throw new ClaudeError(stallGiveUp(stalls), { code: "STALLED" });
            this.emit("warning", { message: stallNote(raw, stalls) });
          }
          attempt -= 1;
          continue;
        }
        const err = describeClaudeError(raw);
        if (err.reissue && attempt < MAX_REISSUES) {
          this.emit("status", { message: `${err.message} Frage erneut …` });
          continue;
        }
        // Browsers cut connections of pages in the background: wait until Ortfinder is visible again.
        if (err.retryable && (await this.waitIfBackground())) {
          attempt = -1;
          continue;
        }
        if (err.retryable && attempt < MAX_RETRIES) {
          const wait = err.retryAfterMs || Math.min(5000 * 2 ** attempt, 60000);
          this.emit("status", { message: `${err.message} Neuer Versuch in ${Math.round(wait / 1000)} s …` });
          await sleep(wait, this.signal);
          continue;
        }
        throw err;
      }
    }
  }

  addUsage(usage = {}) {
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    this.usage.input_tokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cacheRead;
    this.usage.cached_tokens += cacheRead;
    this.usage.output_tokens += usage.output_tokens ?? 0;
  }

  /** Tell the user once when Anthropic answered with its fallback model after Opus 5 declined. */
  noteFallback(message) {
    const switched = message.content.some((b) => b.type === "fallback") ||
      (message.usage?.iterations ?? []).some((entry) => entry.type === "fallback_message");
    if (!switched || this.announcedFallback) return;
    this.announcedFallback = true;
    this.emit("status", { message: `${this.model} hat einen Teil abgelehnt – Anthropic hat automatisch mit ${message.model} weitergemacht.` });
  }

  async run({ intro, images, executor, resume = null }) {
    const budget =
      `Budget: höchstens ${this.maxSteps} Runden (jede Antwort von dir ist eine Runde). ` +
      "Bündle deshalb alle Zooms und Kartenabfragen, die du gerade brauchst, parallel in EINER Antwort.";
    // Append-only history: earlier turns are sent back unchanged (prompt cache, thinking blocks).
    const messages = resume ? [...resume.conversation] : [
      { role: "user", content: [{ type: "text", text: `${intro}\n\n${budget}` }, ...toClaudeBlocks(images)] },
    ];
    let nudges = resume?.nudges ?? 0;
    if (resume) this.usage = { ...this.usage, ...resume.usage };
    const save = (step) => this.checkpoint({ conversation: messages, step, nudges, usage: this.usage });

    for (let step = (resume?.step ?? 0) + 1; step <= this.maxSteps; step++) {
      this.emit("step", { step, max_steps: this.maxSteps });
      let message;
      for (let cut = 0; ; cut++) {
        message = await this.request(messages);
        this.addUsage(message.usage);
        // A tool call cut off by the output limit can look complete: ask again instead of running it.
        const truncated = message.stop_reason === "max_tokens" && message.content.some((b) => b.type === "tool_use");
        if (!truncated) break;
        if (cut >= MAX_REISSUES) throw new ClaudeError("Die Antwort von Claude wurde mehrfach abgeschnitten. Bitte erneut versuchen.", { code: "TRUNCATED" });
      }
      // Checked before the content: a declined answer may hold half a tool call.
      if (message.stop_reason === "refusal") {
        throw new ClaudeError(
          "Claude hat die Analyse dieses Bildes abgelehnt (Sicherheitsfilter von Anthropic). Mit einem anderen Foto oder einem anderen KI-Anbieter unter ⚙ versuchen.",
          { code: "REFUSAL" });
      }
      this.noteFallback(message);
      const content = echoable(message.content);
      for (const block of content) {
        if (block.type === "thinking" && block.thinking?.trim()) this.emit("thinking", { text: block.thinking.trim() });
        if (block.type === "text" && block.text.trim()) this.emit("note", { text: block.text.trim() });
      }
      if (content.length) messages.push({ role: "assistant", content });

      const calls = content.filter((b) => b.type === "tool_use");
      if (!calls.length) {
        nudges += 1;
        if (nudges > MAX_NUDGES) break;
        messages.push({ role: "user", content: `Bitte gib dein Ergebnis jetzt mit dem Werkzeug \`${SUBMIT_TOOL}\` ab.` });
        await save(step);
        continue;
      }

      let submission = null;
      const results = await Promise.all(calls.map(async (call) => {
        const args = call.input;
        if (call.name === SUBMIT_TOOL) {
          try {
            submission = validateSubmission(args);
            return toolResult(call.id, "Ergebnis übernommen.");
          } catch (err) {
            if (!(err instanceof ToolInputError)) throw err;
            return toolResult(call.id, `Ergebnis ungültig: ${err.message}. Bitte korrigiert erneut abgeben.`, true);
          }
        }
        this.emit("tool_call", { tool: call.name, input: args });
        // The executor checks every input against the tool's rules and answers mistakes with an error result.
        const { result, isError } = await executor.run(call.name, args);
        this.emit("tool_result", { tool: call.name, is_error: isError, preview: preview(result) });
        return toolResult(call.id, result, isError);
      }));
      // All results of a round go back in one message, tool results first.
      const reply = [...results];
      const remaining = this.maxSteps - step;
      if (!submission && remaining <= 2) {
        reply.push({ type: "text", text: `Hinweis: Nur noch ${remaining} Runde(n) übrig – gib dein Ergebnis jetzt mit \`${SUBMIT_TOOL}\` ab.` });
      }
      messages.push({ role: "user", content: reply });
      if (submission) return { analysis: submission, usage: this.usage };
      await save(step);
    }
    throw new ClaudeError("Die KI hat innerhalb des Schrittlimits kein Ergebnis abgegeben (unter ⚙ mehr Runden erlauben).");
  }
}

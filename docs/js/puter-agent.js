// Geolocation agent on Puter.js: no API key; each visitor signs in once with a free Puter account
// and uses their own free monthly allowance ("user pays"). OpenAI-style chat with tool calls.

import { preview } from "./agent.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { FUNCTION_TOOLS, SUBMIT_TOOL, ToolInputError, validateSubmission } from "./tools.js";

export const PUTER_SCRIPT = "https://js.puter.com/v2/";
export const PUTER_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (empfohlen)" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite (sparsam)" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "qwen3.5-flash", label: "Qwen 3.5 Flash (sehr sparsam)" },
];
const MAX_NUDGES = 2;
const MAX_RETRIES = 3;

let loader = null;
/** Load Puter.js once, on first use (it is only needed when an analysis starts). */
export function loadPuter(doc = globalThis.document) {
  if (globalThis.puter?.ai) return Promise.resolve(globalThis.puter);
  loader ??= new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = PUTER_SCRIPT;
    script.onload = () => (globalThis.puter?.ai ? resolve(globalThis.puter) : reject(new Error("Puter.js hat sich nicht initialisiert.")));
    script.onerror = () => {
      loader = null;
      reject(new Error("Puter.js konnte nicht geladen werden (Werbeblocker oder keine Verbindung?)."));
    };
    doc.head.append(script);
  });
  return loader;
}

export class PuterError extends Error {
  constructor(message, { code = "", retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** Puter rejects with objects of varying shape; turn them into clear German messages. */
export function describePuterError(err) {
  if (err instanceof PuterError) return err;
  const inner = err?.error ?? err;
  const code = String(inner?.code ?? inner?.status ?? err?.code ?? "");
  const message = String(inner?.message ?? err?.message ?? (typeof err === "string" ? err : JSON.stringify(err)));
  const text = `${code} ${message}`.toLowerCase();
  if (/insufficient|funds|allowance|usage.?limit|credits|quota|upgrade/.test(text)) {
    return new PuterError("Das kostenlose Puter-Guthaben für diesen Monat ist aufgebraucht. Puter bietet an, es aufzustocken – oder unter ⚙ einen eigenen Gemini-API-Key verwenden.", { code: "ALLOWANCE" });
  }
  if (/cancel|denied|abort|closed|not.?signed|unauthori[sz]ed|auth/.test(text)) {
    return new PuterError("Die Anmeldung bei Puter wurde abgebrochen. Für die KI-Analyse ist einmalig eine kostenlose Anmeldung nötig (Google, Microsoft, Apple oder E-Mail).", { code: "AUTH" });
  }
  if (/429|rate|too many|overload|503|502|timeout|network|fetch/.test(text)) {
    return new PuterError(`Puter ist gerade ausgelastet (${message.slice(0, 120)}).`, { code: "BUSY", retryable: true });
  }
  return new PuterError(`Fehler bei Puter: ${message.slice(0, 300)}`);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Abgebrochen", "AbortError"));
    }, { once: true });
  });

/** Our tool declarations in the OpenAI "function" format Puter expects. */
export const OPENAI_TOOLS = FUNCTION_TOOLS.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));

/** Convert our content blocks (text / base64 image) to OpenAI message parts. */
function toParts(blocks) {
  return blocks.map((b) =>
    b.type === "image"
      ? { type: "image_url", image_url: { url: `data:${b.mime_type};base64,${b.data}` } }
      : { type: "text", text: b.text });
}

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

export class PuterAgent {
  constructor({ model = PUTER_MODELS[0].id, maxSteps = 8, chat, emit = () => {}, signal } = {}) {
    this.model = model;
    this.maxSteps = maxSteps;
    this.chat = chat ?? ((messages, options) => globalThis.puter.ai.chat(messages, options));
    this.emit = emit;
    this.signal = signal;
    this.usage = { requests: 0, input_tokens: 0, output_tokens: 0, thought_tokens: 0, cached_tokens: 0 };
  }

  async request(messages) {
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      try {
        // puter.ai.chat has no abort option, so a cancelled analysis just stops waiting for it.
        const call = this.chat(messages, { model: this.model, tools: OPENAI_TOOLS, normalize: true });
        const response = await (this.signal
          ? Promise.race([call, new Promise((_, reject) => this.signal.addEventListener("abort", () => reject(this.signal.reason ?? new DOMException("Abgebrochen", "AbortError")), { once: true }))])
          : call);
        this.usage.requests += 1;
        return response;
      } catch (raw) {
        if (raw?.name === "AbortError") throw raw;
        const err = describePuterError(raw);
        if (err.retryable && attempt < MAX_RETRIES) {
          this.emit("status", { message: `${err.message} Neuer Versuch in ${2 * 2 ** attempt} s …` });
          await sleep(2000 * 2 ** attempt, this.signal);
          continue;
        }
        throw err;
      }
    }
  }

  addUsage(usage = {}) {
    // Key names differ between vendors; count what is there.
    this.usage.input_tokens += usage.prompt_tokens ?? usage.input_tokens ?? 0;
    this.usage.output_tokens += usage.completion_tokens ?? usage.output_tokens ?? 0;
  }

  async run({ intro, images, executor }) {
    const budget =
      `Budget: höchstens ${this.maxSteps} Runden (jede Antwort von dir ist eine Runde). ` +
      "Bündle deshalb alle Zooms und Kartenabfragen, die du gerade brauchst, parallel in EINER Antwort.";
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: `${intro}\n\n${budget}` }, ...toParts(images)] },
    ];
    let nudges = 0;

    for (let step = 1; step <= this.maxSteps; step++) {
      this.emit("step", { step, max_steps: this.maxSteps });
      const response = await this.request(messages);
      this.addUsage(response?.usage);
      const message = response?.message;
      if (!message) throw new PuterError("Puter hat keine Antwort geliefert.");
      if (response.finish_reason === "content_filter") throw new PuterError("Das Modell hat die Analyse dieses Bildes abgelehnt.");

      if (message.reasoning) this.emit("thinking", { text: String(message.reasoning).trim() });
      const text = typeof message.content === "string" ? message.content.trim() : "";
      if (text) this.emit("note", { text });
      // Resend the assistant turn as received (reasoning_details are needed to continue thinking turns).
      messages.push({ ...message, role: "assistant" });

      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        nudges += 1;
        if (nudges > MAX_NUDGES) break;
        messages.push({ role: "user", content: `Bitte gib dein Ergebnis jetzt mit dem Werkzeug \`${SUBMIT_TOOL}\` ab.` });
        continue;
      }

      let submission = null;
      const images = [];
      const toolMessages = await Promise.all(calls.map(async (call) => {
        const name = call.function?.name;
        const args = parseArguments(call.function?.arguments);
        if (args === null) return { role: "tool", tool_call_id: call.id, content: `Ungültige Eingabe: Argumente sind kein gültiges JSON.` };
        if (name === SUBMIT_TOOL) {
          try {
            submission = validateSubmission(args);
            return { role: "tool", tool_call_id: call.id, content: "Ergebnis übernommen." };
          } catch (err) {
            if (!(err instanceof ToolInputError)) throw err;
            return { role: "tool", tool_call_id: call.id, content: `Ergebnis ungültig: ${err.message}. Bitte korrigiert erneut abgeben.` };
          }
        }
        this.emit("tool_call", { tool: name, input: args });
        const { result, isError } = await executor.run(name, args);
        this.emit("tool_result", { tool: name, is_error: isError, preview: preview(result) });
        if (typeof result === "string") return { role: "tool", tool_call_id: call.id, content: result };
        // Tool messages carry text only; images (zoom crops) follow in one user message below.
        const texts = result.filter((b) => b.type === "text").map((b) => b.text);
        for (const b of result.filter((part) => part.type === "image")) images.push({ label: texts[0] || name, block: b });
        return { role: "tool", tool_call_id: call.id, content: `${texts.join("\n")}\n(Bild folgt in der nächsten Nachricht.)` };
      }));
      messages.push(...toolMessages);
      if (submission) return { analysis: submission, usage: this.usage };

      const remaining = this.maxSteps - step;
      const followUp = [];
      for (const { label, block } of images) followUp.push({ type: "text", text: label }, ...toParts([block]));
      if (remaining <= 2) followUp.push({ type: "text", text: `Hinweis: Nur noch ${remaining} Runde(n) übrig – gib dein Ergebnis jetzt mit \`${SUBMIT_TOOL}\` ab.` });
      if (followUp.length) messages.push({ role: "user", content: followUp });
    }
    throw new PuterError("Die KI hat innerhalb des Schrittlimits kein Ergebnis abgegeben (unter ⚙ mehr Runden erlauben).");
  }
}

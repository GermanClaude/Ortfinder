// Geolocation agent on Puter.js: no API key; each visitor signs in once with a free Puter account
// and uses their own free monthly allowance ("user pays"). OpenAI-style chat with tool calls.

import { HANDOFF_MARK, cut, preview } from "./agent.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { FUNCTION_TOOLS, SUBMIT_TOOL, ToolInputError, validateSubmission } from "./tools.js";
import { compactOpenAI, splitTiles } from "./compact.js";
import { MAX_STALLS, STALL_MS, StallError, stallGiveUp, stallLimit, stallNote, watch } from "./watchdog.js";

export const PUTER_SCRIPT = "https://js.puter.com/v2/";
export const PUTER_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (empfohlen)" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite (sparsam)" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "qwen3.5-flash", label: "Qwen 3.5 Flash (sehr sparsam)" },
];
const MAX_NUDGES = 2;
const MAX_RETRIES = 3;
// Switches between models in one analysis (away when busy or stuck, back after a pause).
const MAX_SWITCHES = 6;
const BACK_AFTER_MS = 90000;

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
  /** retryAfterMs: wait asked for by the service; backoffMs/maxRetries: retry schedule (default 2 s, 4 s, 8 s). */
  constructor(message, { code = "", retryable = false, retryAfterMs = 0, backoffMs = 2000, maxRetries = MAX_RETRIES } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.backoffMs = backoffMs;
    this.maxRetries = maxRetries;
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
    return new PuterError("Das kostenlose Puter-Guthaben für diesen Monat ist aufgebraucht. Weiter geht es kostenlos unter ⚙ mit „OpenRouter“ (50 Anfragen am Tag, Anmeldung z.B. mit Google).", { code: "ALLOWANCE" });
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

/**
 * The analysis so far for another model (OpenAI-style messages): one model's thinking and signatures do not
 * carry over to another, but what was looked up and found does – as a transcript next to the photo, with
 * the latest round's pictures. The detail tiles are left out (zoom_image gives details).
 */
export function handoffMessages(messages, from, to) {
  const firstUser = messages.findIndex((m) => m.role === "user");
  if (firstUser < 0 || firstUser === messages.length - 1) return messages;
  const first = messages[firstUser];
  const [blocks] = splitTiles(typeof first.content === "string" ? [{ type: "text", text: first.content }] : first.content);
  // An earlier hand-over: its transcript continues, its pictures are old by now.
  const h = blocks.findIndex((b) => b.type === "text" && b.text.startsWith(HANDOFF_MARK));
  const lines = h < 0 ? [] : blocks[h].text.split("\n").slice(1);
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  const images = [];
  messages.forEach((m, i) => {
    if (i <= firstUser) return;
    if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (text) lines.push(`KI: ${cut(text, 600)}`);
      for (const c of m.tool_calls || []) {
        const args = c.function?.arguments;
        lines.push(`→ ${c.function?.name} ${cut(typeof args === "string" ? args : JSON.stringify(args ?? {}), 400)}`);
      }
    } else if (m.role === "tool") {
      lines.push(`  ← ${cut(String(m.content ?? ""), 800)}`);
    } else if (m.role === "user" && typeof m.content === "string") {
      lines.push(`Hinweis: ${cut(m.content, 400)}`);
    } else if (m.role === "user") {
      let label = "";
      for (const part of m.content) {
        if (part.type === "text") label = part.text;
        else if (part.type === "image_url" && i > lastAssistant) images.push({ type: "text", text: label || "Bild:" }, part);
        else if (part.type === "image_url") lines.push(`  [Bild: ${cut(label, 120)}]`);
      }
    }
  });
  const note = `${HANDOFF_MARK} (bis hier mit ${from}; du setzt als ${to} fort – Nachgeschlagenes gilt weiter, nicht nochmals abfragen, ` +
    `sondern darauf aufbauen):\n${lines.join("\n")}`;
  return [...messages.slice(0, firstUser), { role: "user", content: [...(h < 0 ? blocks : blocks.slice(0, h)), { type: "text", text: note }, ...images.slice(-4)] }];
}

export class PuterAgent {
  /**
   * `checkpoint(state)` is awaited after every round (state can be passed back as `resume` to run());
   * `whenActive()` resolves to true after waiting for a page that was in the background.
   */
  /** Also drives other OpenAI-style services (OpenRouter): pass their `chat` function and an error translator. */
  constructor({
    model = PUTER_MODELS[0].id, maxSteps = 10, chat, emit = () => {}, signal, checkpoint = async () => {}, whenActive = async () => false,
    describeError = describePuterError, stallMs = STALL_MS, fallbackModels = [], backAfterMs = BACK_AFTER_MS,
  } = {}) {
    this.model = model;
    // Other models to continue with when this one is busy or stuck (the analysis so far goes along).
    this.fallbackModels = [...fallbackModels];
    this.backAfterMs = backAfterMs;
    this.canSwitch = true;
    this.maxSteps = maxSteps;
    this.describeError = describeError;
    this.chat = chat ?? ((messages, options) => globalThis.puter.ai.chat(messages, options));
    this.emit = emit;
    this.signal = signal;
    this.checkpoint = checkpoint;
    this.whenActive = whenActive;
    this.stallMs = stallMs;
    this.slowestMs = 0;
    this.usage = { requests: 0, input_tokens: 0, output_tokens: 0, thought_tokens: 0, cached_tokens: 0 };
  }

  async waitIfBackground() {
    const pending = this.whenActive();
    // Only announce the wait when there is one (whenActive resolves at once for a visible page).
    const waited = await Promise.race([pending, new Promise((r) => setTimeout(() => r("waiting"), 50))]);
    if (waited !== "waiting") return waited;
    this.emit("status", { message: "Ortfinder ist im Hintergrund – die Anfrage wird wiederholt, sobald die Seite wieder sichtbar ist." });
    return pending;
  }

  async request(messages) {
    let stalls = 0;
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      const started = Date.now();
      try {
        // puter.ai.chat has no abort option: after a cancel or a stall its late answer is ignored.
        // Earlier rounds' images and long results go as short notes (see compact.js).
        const response = await watch(
          (signal) => this.chat(compactOpenAI(messages), { model: this.model, tools: OPENAI_TOOLS, normalize: true }, signal),
          stallLimit(this.slowestMs, stalls, this.stallMs), this.signal);
        this.slowestMs = Math.max(this.slowestMs, Date.now() - started);
        this.usage.requests += 1;
        return response;
      } catch (raw) {
        if (raw?.name === "AbortError") throw raw;
        if (raw instanceof StallError) {
          // No answer at all: another model takes over, or the same round is asked again (a page in the
          // background waits to be visible first).
          if (!(await this.waitIfBackground())) {
            if (this.canSwitch && this.fallbackModels.length) {
              throw Object.assign(new PuterError(`${this.model} antwortet nicht (${raw.message}).`, { code: "STALLED", retryable: true }), { switchable: true });
            }
            stalls += 1;
            if (stalls > MAX_STALLS) throw new PuterError(stallGiveUp(stalls), { code: "STALLED" });
            this.emit("warning", { message: stallNote(raw, stalls) });
          }
          attempt -= 1;
          continue;
        }
        const err = this.describeError(raw);
        // Browsers cut connections of pages in the background: wait until Ortfinder is visible again.
        if (err.retryable && (await this.waitIfBackground())) {
          attempt = -1;
          continue;
        }
        // Busy with another model at hand: one short retry, then that model takes over. An explicit wait
        // (a rate limit of the account) is waited out instead – another model would not help there.
        const switchable = err.code === "BUSY" && err.retryable && !err.retryAfterMs && this.canSwitch && this.fallbackModels.length > 0;
        if (err.retryable && attempt < (switchable ? Math.min(1, err.maxRetries) : err.maxRetries)) {
          const wait = err.retryAfterMs || Math.min(err.backoffMs * 2 ** attempt, 60000);
          this.emit("status", { message: `${err.message} Neuer Versuch in ${Math.round(wait / 1000)} s …` });
          await sleep(wait, this.signal);
          continue;
        }
        if (switchable) err.switchable = true;
        throw err;
      }
    }
  }

  addUsage(usage = {}) {
    // Key names differ between vendors; count what is there.
    this.usage.input_tokens += usage.prompt_tokens ?? usage.input_tokens ?? 0;
    this.usage.output_tokens += usage.completion_tokens ?? usage.output_tokens ?? 0;
  }

  async run({ intro, images, executor, resume = null }) {
    const budget =
      `Budget: höchstens ${this.maxSteps} Runden (jede Antwort von dir ist eine Runde). ` +
      "Bündle deshalb alle Zooms und Kartenabfragen, die du gerade brauchst, parallel in EINER Antwort.";
    let messages = resume ? [...resume.conversation] : [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: `${intro}\n\n${budget}` }, ...toParts(images)] },
    ];
    let nudges = resume?.nudges ?? 0;
    if (resume) {
      this.usage = { ...this.usage, ...resume.usage };
      if (resume.model && resume.model !== this.model) {
        // Continue with the model the page was using when it was interrupted.
        this.fallbackModels = [this.model, ...this.fallbackModels.filter((m) => m !== resume.model)];
        this.model = resume.model;
      }
    }
    const save = (step) => this.checkpoint({ conversation: messages, step, nudges, usage: this.usage, model: this.model });
    // A model left because it was busy or stuck gets another chance after a pause.
    let switches = 0;
    let preferred = null;
    let backAt = 0;
    let pause = this.backAfterMs;
    let justSwitched = false; // the other model first has to get a round done

    for (let step = (resume?.step ?? 0) + 1; step <= this.maxSteps; step++) {
      if (preferred && !justSwitched && Date.now() >= backAt && switches < MAX_SWITCHES) {
        const back = preferred;
        preferred = null;
        switches += 1;
        this.emit("status", { message: `Ortfinder versucht es wieder mit ${back} (der bisherige Stand geht mit).` });
        this.fallbackModels = [this.model, ...this.fallbackModels.filter((m) => m !== back && m !== this.model)];
        messages = handoffMessages(messages, this.model, back);
        this.model = back;
      }
      this.canSwitch = switches < MAX_SWITCHES;
      this.emit("step", { step, max_steps: this.maxSteps });
      let response;
      try {
        response = await this.request(messages);
      } catch (err) {
        if (!err.switchable || !this.fallbackModels.length) throw err;
        const used = this.model;
        const next = this.fallbackModels.shift();
        switches += 1;
        this.fallbackModels.push(used); // only busy for now
        preferred = used === next ? null : used;
        backAt = Date.now() + pause;
        this.emit("status", {
          message: `${used} ${err.code === "STALLED" ? "antwortet nicht" : "ist gerade überlastet"} – Ortfinder macht mit ${next} weiter ` +
            `(der bisherige Stand geht mit) und versucht es in ${Math.round(pause / 1000)} s wieder mit ${used}.`,
        });
        pause *= 2;
        messages = handoffMessages(messages, used, next);
        this.model = next;
        justSwitched = true;
        nudges = 0;
        step -= 1;
        continue;
      }
      justSwitched = false;
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
        await save(step);
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
      await save(step);
    }
    throw new PuterError("Die KI hat innerhalb des Schrittlimits kein Ergebnis abgegeben (unter ⚙ mehr Runden erlauben).");
  }
}

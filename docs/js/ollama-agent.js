// Geolocation agent on Ollama: an open model on your own computer – unlimited and free, no account.
// Uses Ollama's native /api/chat (not the OpenAI-compatible one) so the context window can be set per
// request; Ollama's default of 4096 tokens is far too small for photos.

import { preview } from "./agent.js";
import { compactOllama, splitTiles } from "./compact.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { OPENAI_TOOLS } from "./puter-agent.js";
import { SUBMIT_TOOL, ToolInputError, validateSubmission } from "./tools.js";
import { MAX_STALLS, StallError, stallGiveUp, stallLimit, stallNote, watch } from "./watchdog.js";

export const OLLAMA_DEFAULT_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "gemma4:12b";
/** Suggestions for `ollama pull`; all of them understand images and can call tools. */
export const OLLAMA_SUGGESTIONS = [
  { id: "gemma4:12b", label: "Gemma 4 12B – empfohlen (7,6 GB, PC ab 16 GB RAM)" },
  { id: "qwen3.5:9b", label: "Qwen 3.5 9B (6,6 GB)" },
  { id: "qwen3.5:4b", label: "Qwen 3.5 4B – für schwächere PCs (3,4 GB)" },
  { id: "gemma4:26b", label: "Gemma 4 26B – für starke PCs (19 GB)" },
  { id: "qwen3.5:27b", label: "Qwen 3.5 27B – für starke PCs (17 GB)" },
];
const MAX_NUDGES = 2;
const MAX_RETRIES = 3;
// Older photos and zooms are dropped from what is sent, so the conversation fits a local context window.

export class OllamaError extends Error {
  constructor(message, { code = "", retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** "localhost:11434/" → "http://localhost:11434" */
export function normalizeOllamaUrl(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  if (!u) return OLLAMA_DEFAULT_URL;
  if (!/^https?:\/\//i.test(u)) u = `${/^(localhost|127\.|\[?::1)/i.test(u) ? "http" : "https"}://${u}`;
  return u.replace(/\/api$/, "");
}

export function unreachableMessage(baseUrl) {
  return `Ollama ist unter ${baseUrl} nicht erreichbar. Läuft Ollama (bzw. das Ortfinder-Startskript) auf dem PC, ` +
    "und ist Ortfinder freigegeben (OLLAMA_ORIGINS)? Anleitung unter ⚙ → Eigener PC.";
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Abgebrochen", "AbortError"));
    }, { once: true });
  });

/**
 * Installed models with what they can do. Only models with "vision" and "tools" can run Ortfinder.
 * Newer Ollama versions list capabilities in /api/tags; older ones need /api/show per model.
 */
export async function listOllamaModels(baseUrl, fetchImpl = globalThis.fetch.bind(globalThis)) {
  let resp;
  try {
    resp = await fetchImpl(`${baseUrl}/api/tags`);
  } catch {
    throw new OllamaError(unreachableMessage(baseUrl), { code: "UNREACHABLE" });
  }
  if (!resp.ok) throw new OllamaError(`Ollama antwortete mit HTTP ${resp.status}.`);
  const { models = [] } = await resp.json();
  return Promise.all(models.map(async (m) => {
    let capabilities = m.capabilities;
    if (!Array.isArray(capabilities)) {
      try {
        const show = await fetchImpl(`${baseUrl}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m.name }) });
        capabilities = show.ok ? (await show.json()).capabilities ?? [] : [];
      } catch {
        capabilities = [];
      }
    }
    return {
      name: m.name,
      sizeGb: Math.round((m.size || 0) / 1e8) / 10,
      params: m.details?.parameter_size || "",
      capabilities,
      usable: capabilities.includes("vision") && capabilities.includes("tools"),
    };
  }));
}

export class OllamaAgent {
  /**
   * `checkpoint(state)` is awaited after every round (state can be passed back as `resume` to run());
   * `whenActive()` resolves to true after waiting for a page that was in the background.
   */
  constructor({
    baseUrl = OLLAMA_DEFAULT_URL, model = OLLAMA_DEFAULT_MODEL, numCtx = 32768, maxSteps = 10, fetchImpl = globalThis.fetch.bind(globalThis),
    emit = () => {}, signal, checkpoint = async () => {}, whenActive = async () => false, stallMs = 180000,
  } = {}) {
    this.baseUrl = normalizeOllamaUrl(baseUrl);
    // A PC may think for a while about a big photo before the first word; after that words keep coming.
    this.stallMs = stallMs;
    this.model = model;
    this.numCtx = numCtx;
    this.maxSteps = maxSteps;
    this.fetch = fetchImpl;
    this.emit = emit;
    this.signal = signal;
    this.checkpoint = checkpoint;
    this.whenActive = whenActive;
    this.usage = { requests: 0, input_tokens: 0, output_tokens: 0, thought_tokens: 0, cached_tokens: 0 };
  }

  async waitIfBackground() {
    const pending = this.whenActive();
    const waited = await Promise.race([pending, new Promise((r) => setTimeout(() => r("waiting"), 50))]);
    if (waited !== "waiting") return waited;
    this.emit("status", { message: "Ortfinder ist im Hintergrund – die Anfrage wird wiederholt, sobald die Seite wieder sichtbar ist." });
    return pending;
  }

  /** One streamed chat turn; streaming keeps tunnels (Cloudflare) from timing out on long answers. */
  async chatOnce(messages, signal = this.signal, alive = () => {}) {
    const resp = await this.fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: compactOllama(messages), // earlier rounds' images and long results as short notes
        tools: OPENAI_TOOLS,
        stream: true,
        keep_alive: "30m",
        options: { num_ctx: this.numCtx },
      }),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {
        // plain text error
      }
      if (resp.status === 404 && /not found/i.test(message)) {
        throw new OllamaError(`Das Modell „${this.model}“ ist auf dem PC nicht installiert. Dort ausführen: ollama pull ${this.model}`, { code: "MODEL_MISSING" });
      }
      if (/does not support tools/i.test(message)) {
        throw new OllamaError(`„${this.model}“ kann keine Werkzeuge benutzen. Bitte ein Modell mit Bild- und Werkzeug-Unterstützung wählen, z.B. ${OLLAMA_DEFAULT_MODEL}.`, { code: "NO_TOOLS" });
      }
      throw new OllamaError(`Ollama-Fehler (HTTP ${resp.status}): ${String(message).slice(0, 300)}`, { retryable: resp.status >= 500 });
    }
    const message = { role: "assistant", content: "", thinking: "", tool_calls: [] };
    let final = {};
    const handleLine = (line) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line);
      if (chunk.error) throw new OllamaError(`Ollama-Fehler: ${chunk.error}`);
      message.content += chunk.message?.content || "";
      message.thinking += chunk.message?.thinking || "";
      if (chunk.message?.tool_calls?.length) message.tool_calls.push(...chunk.message.tool_calls);
      if (chunk.done) final = chunk;
    };
    if (resp.body?.getReader) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        alive();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        lines.forEach(handleLine);
      }
      handleLine(buffer + decoder.decode());
    } else {
      (await resp.text()).split("\n").forEach(handleLine);
    }
    this.usage.requests += 1;
    this.usage.input_tokens += final.prompt_eval_count || 0;
    this.usage.output_tokens += final.eval_count || 0;
    return { message, doneReason: final.done_reason };
  }

  async request(messages) {
    let stalls = 0;
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      try {
        return await watch((signal, alive) => this.chatOnce(messages, signal, alive), stallLimit(0, stalls, this.stallMs), this.signal);
      } catch (raw) {
        if (raw?.name === "AbortError") throw raw;
        if (raw instanceof StallError) {
          if (!(await this.waitIfBackground())) {
            stalls += 1;
            if (stalls > MAX_STALLS) throw new OllamaError(stallGiveUp(stalls), { code: "STALLED" });
            this.emit("warning", { message: stallNote(raw, stalls) });
          }
          attempt -= 1;
          continue;
        }
        const err = raw instanceof OllamaError ? raw : new OllamaError(unreachableMessage(this.baseUrl), { code: "UNREACHABLE", retryable: true });
        if (err.retryable && (await this.waitIfBackground())) {
          attempt = -1;
          continue;
        }
        if (err.retryable && attempt < MAX_RETRIES) {
          this.emit("status", { message: `${err.code === "UNREACHABLE" ? "Keine Verbindung zu Ollama" : err.message} – neuer Versuch in ${3 * 2 ** attempt} s …` });
          await sleep(3000 * 2 ** attempt, this.signal);
          continue;
        }
        throw err;
      }
    }
  }

  async run({ intro, images, executor, resume = null }) {
    const budget =
      `Budget: höchstens ${this.maxSteps} Runden (jede Antwort von dir ist eine Runde). ` +
      "Bündle deshalb alle Zooms und Kartenabfragen, die du gerade brauchst, parallel in EINER Antwort.";
    let messages;
    if (resume) {
      messages = [...resume.conversation];
      this.usage = { ...this.usage, ...resume.usage };
    } else {
      // Ollama takes images as a list per message: the photo first, the detail tiles in a second
      // message that is dropped after the first answer (see compact.js).
      const [keep, tiles] = splitTiles(images);
      messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${intro}\n\n${budget}`, images: keep.filter((b) => b.type === "image").map((b) => b.data) },
      ];
      if (tiles.some((b) => b.type === "image")) {
        const labels = tiles.filter((b) => b.type === "text").map((b) => b.text);
        messages.push({ role: "user", content: labels.join("\n"), images: tiles.filter((b) => b.type === "image").map((b) => b.data) });
      }
    }
    let nudges = resume?.nudges ?? 0;
    const save = (step) => this.checkpoint({ conversation: messages, step, nudges, usage: this.usage });

    for (let step = (resume?.step ?? 0) + 1; step <= this.maxSteps; step++) {
      this.emit("step", { step, max_steps: this.maxSteps });
      const { message } = await this.request(messages);
      if (message.thinking.trim()) this.emit("thinking", { text: message.thinking.trim() });
      const text = message.content.trim();
      if (text) this.emit("note", { text });
      // Earlier thinking is not sent back (it only costs context).
      const calls = message.tool_calls;
      messages.push({ role: "assistant", content: message.content, ...(calls.length ? { tool_calls: calls } : {}) });

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
        const reply = (content) => ({ role: "tool", tool_name: name, ...(call.id ? { tool_call_id: call.id } : {}), content });
        let args = call.function?.arguments ?? {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args || "{}");
          } catch {
            return reply("Ungültige Eingabe: Argumente sind kein gültiges JSON.");
          }
        }
        if (name === SUBMIT_TOOL) {
          try {
            submission = validateSubmission(args);
            return reply("Ergebnis übernommen.");
          } catch (err) {
            if (!(err instanceof ToolInputError)) throw err;
            return reply(`Ergebnis ungültig: ${err.message}. Bitte korrigiert erneut abgeben.`);
          }
        }
        this.emit("tool_call", { tool: name, input: args });
        const { result, isError } = await executor.run(name, args);
        this.emit("tool_result", { tool: name, is_error: isError, preview: preview(result) });
        if (typeof result === "string") return reply(result);
        const texts = result.filter((b) => b.type === "text").map((b) => b.text);
        for (const b of result.filter((part) => part.type === "image")) images.push({ label: texts[0] || name, data: b.data });
        return reply(`${texts.join("\n")}\n(Bild folgt in der nächsten Nachricht.)`);
      }));
      messages.push(...toolMessages);
      if (submission) return { analysis: submission, usage: this.usage };

      const remaining = this.maxSteps - step;
      const notes = images.map((img, i) => `Bild ${i + 1}: ${img.label}`);
      if (remaining <= 2) notes.push(`Hinweis: Nur noch ${remaining} Runde(n) übrig – gib dein Ergebnis jetzt mit \`${SUBMIT_TOOL}\` ab.`);
      if (notes.length) messages.push({ role: "user", content: notes.join("\n"), ...(images.length ? { images: images.map((img) => img.data) } : {}) });
      await save(step);
    }
    throw new OllamaError("Die KI hat innerhalb des Schrittlimits kein Ergebnis abgegeben (unter ⚙ mehr Runden erlauben oder ein größeres Modell wählen).");
  }
}

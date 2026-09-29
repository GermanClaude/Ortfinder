// More AI services with an OpenAI-compatible chat API that answer requests straight from the browser
// (CORS, checked for each one). Every visitor brings their own key; it stays in their browser and goes
// only to that service. They run on the same loop as Puter and OpenRouter (see puter-agent.js).
//
// Grouped by how they can be used (as of September 2026 – services change their offers often, so the
// notes say what to check). Model lists can be loaded from the service itself ("Modelle laden").

import { PuterError } from "./puter-agent.js";

export const PROVIDER_GROUPS = [
  { id: "free", label: "Kostenlos" },
  { id: "trial", label: "Einmaliges Startguthaben, danach bezahlen" },
  { id: "paypal", label: "Bezahlen – auch mit PayPal" },
  { id: "card", label: "Bezahlen mit Kreditkarte" },
];

/**
 * name, group, baseUrl, keyUrl (where to create a key), keyHint (placeholder), models (first = default,
 * all with image input and tool calls), maxImages (per request, if the service limits it), keep (extra
 * fields of the service's own answers that must go back unchanged), paypal, lines (what to know).
 */
export const COMPAT_PROVIDERS = {
  mistral: {
    name: "Mistral",
    label: "Mistral (Frankreich) – kostenloser Plan, eigener Key",
    group: "free",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyHint: "Mistral-API-Key",
    models: [
      { id: "mistral-medium-latest", label: "Mistral Medium (Bilder, empfohlen)" },
      { id: "mistral-large-latest", label: "Mistral Large" },
      { id: "mistral-small-latest", label: "Mistral Small (sparsam)" },
    ],
    lines: [
      "Kostenloser Plan ohne Kreditkarte (Konto mit Telefonnummer). Mistral hat ihn im August 2026 umgestellt – wie viel er gerade enthält, steht im Konto unter „Limits“ bzw. „Billing“.",
      "Im kostenlosen Plan darf Mistral die Eingaben zum Training verwenden – keine privaten Fotos anderer hochladen.",
    ],
  },
  groq: {
    name: "Groq",
    label: "Groq – kostenlos, eigener Key (sehr schnell)",
    group: "free",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "gsk_…",
    models: [{ id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B (Bilder)" }],
    maxImages: 3,
    lines: [
      "Kostenlos ohne Kreditkarte, mit Tages- und Minutenlimits. Sehr schnell, aber ein kleineres Modell als Gemini – eher grob als hausgenau.",
      "Groq nimmt höchstens 3 Bilder pro Anfrage; Ortfinder schickt dann das Foto und die neuesten Zooms.",
    ],
  },
  deepseek: {
    name: "DeepSeek",
    label: "DeepSeek – Startguthaben, danach sehr günstig (auch PayPal)",
    group: "trial",
    baseUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
    models: [{ id: "deepseek-flash", label: "DeepSeek Flash (V4.1, Bilder)" }],
    keep: ["reasoning_content"],
    paypal: true,
    lines: [
      "Neue Konten bekommen meist ein einmaliges Startguthaben (Berichten zufolge einige Millionen Tokens für 30 Tage; im Konto unter „Usage“ zu sehen).",
      "Danach sehr günstig: eine Analyse kostet etwa 1–3 Cent. Aufladen geht per Karte und – je nach Land – mit PayPal (unter „Top up“).",
      "DeepSeek sitzt in China; die Daten werden dort verarbeitet.",
    ],
  },
  qwen: {
    name: "Qwen (Alibaba Cloud)",
    label: "Qwen (Alibaba Cloud) – Startguthaben 90 Tage, danach bezahlen",
    group: "trial",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://modelstudio.console.alibabacloud.com/",
    keyHint: "sk-…",
    models: [
      { id: "qwen3.6-plus", label: "Qwen 3.6 Plus (Bilder, empfohlen)" },
      { id: "qwen3.6-flash", label: "Qwen 3.6 Flash (sparsam)" },
    ],
    lines: [
      "Neue Konten bekommen je Modell 1 Mio. Tokens gratis, 90 Tage lang (Region Singapur/International). Das reicht für viele Analysen.",
      "Tipp: In der Model Studio Console „Free quota only“ einschalten – dann wird nach dem Gratis-Kontingent nichts berechnet.",
    ],
  },
  poe: {
    name: "Poe",
    label: "Poe – Gemini, Claude, GPT, Grok mit einem Key; Abo auch per PayPal",
    group: "paypal",
    baseUrl: "https://api.poe.com/v1",
    keyUrl: "https://poe.com/api/keys",
    keyHint: "Poe-API-Key",
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (empfohlen)" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro (stärker)" },
      { id: "claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
      { id: "claude-opus-4.8", label: "Claude Opus 4.8" },
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "grok-4.7", label: "Grok 4.7" },
    ],
    paypal: true,
    lines: [
      "Ein Key für viele Spitzenmodelle, abgerechnet über Poe-„Punkte“ zu ähnlichen Preisen wie beim Hersteller (Gemini 3.8 Flash: grob 5–10 Cent pro Analyse).",
      "PayPal: das Poe-Abo (ab etwa 5 $ im Monat) in der Poe-App über Google Play oder den App Store abschließen – dort lässt sich PayPal als Zahlungsart hinterlegen. Die Abo-Punkte gelten auch für den Key.",
      "Das kostenlose Tageskontingent von Poe ist für eine ganze Analyse meist zu klein.",
    ],
  },
  openai: {
    name: "OpenAI",
    label: "OpenAI (GPT) – eigener Key, Kreditkarte",
    group: "card",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    models: [
      { id: "gpt-6-luna", label: "GPT-6 Luna (sparsam)" },
      { id: "gpt-6-sol", label: "GPT-6 Sol (empfohlen)" },
      { id: "gpt-6-astra", label: "GPT-6 Astra (am stärksten, teuer)" },
    ],
    lines: ["Abrechnung pro Anfrage über ein Guthaben bei OpenAI (vorher mit Kreditkarte aufladen). Ein ChatGPT-Abo gilt hier nicht."],
  },
  xai: {
    name: "xAI",
    label: "xAI (Grok) – eigener Key, Kreditkarte",
    group: "card",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai/",
    keyHint: "xai-…",
    models: [
      { id: "grok-4.7", label: "Grok 4.7 (Bilder)" },
      { id: "grok-4.3", label: "Grok 4.3 (günstiger)" },
    ],
    lines: ["Abrechnung pro Anfrage über ein Guthaben bei xAI (Kreditkarte)."],
  },
  custom: {
    name: "Anderer Anbieter",
    label: "Anderer Anbieter (OpenAI-kompatibel, für Fortgeschrittene)",
    group: "card",
    baseUrl: "",
    keyUrl: "",
    keyHint: "API-Key",
    models: [],
    lines: [
      "Jeder Dienst mit OpenAI-kompatibler Schnittstelle, der Anfragen aus dem Browser erlaubt (z.B. Together, Fireworks, DeepInfra, Novita, Nebius, SiliconFlow, Moonshot).",
      "Das Modell muss Bilder und Werkzeuge (Function Calling) können.",
    ],
  },
};

export const isCompat = (provider) => Object.hasOwn(COMPAT_PROVIDERS, provider);

/** Settings of one service: { key, model, url } with the service's defaults. */
export function compatSettings(settings, provider) {
  const p = COMPAT_PROVIDERS[provider];
  const own = settings.compat?.[provider] || {};
  return {
    key: own.key || "",
    model: own.model || p.models[0]?.id || "",
    baseUrl: (provider === "custom" ? own.url || "" : p.baseUrl).replace(/\/+$/, ""),
  };
}

/**
 * Only the fields every service understands go back in assistant turns (plus the service's own, `keep`):
 * some reject what another service or model added (reasoning, refusal, annotations …).
 */
export function cleanMessages(messages, keep = []) {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    const out = { role: "assistant", content: typeof m.content === "string" ? m.content : m.content ?? "" };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
    for (const k of keep) if (m[k] != null) out[k] = m[k];
    return out;
  });
}

/**
 * At most `max` pictures per request: the photo (the first picture) and the newest others stay, the rest
 * become a short note.
 */
export function limitImages(messages, max) {
  const where = [];
  messages.forEach((m, i) => {
    if (Array.isArray(m.content)) m.content.forEach((p, j) => { if (p.type === "image_url") where.push([i, j]); });
  });
  if (where.length <= max) return messages;
  const keep = new Set([where[0], ...where.slice(where.length - (max - 1))].map(([i, j]) => `${i}/${j}`));
  return messages.map((m, i) => (Array.isArray(m.content)
    ? {
      ...m,
      content: m.content.map((p, j) => (p.type === "image_url" && !keep.has(`${i}/${j}`)
        ? { type: "text", text: `[Bild weggelassen – dieser Anbieter nimmt höchstens ${max} Bilder pro Anfrage; bei Bedarf erneut zoomen.]` }
        : p)),
    }
    : m));
}

export class CompatHttpError extends Error {
  constructor(status, message, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const errorText = (data) => {
  const e = data?.error ?? data?.detail ?? data?.message;
  if (typeof e === "string") return e;
  return e?.message || (Array.isArray(e) ? e.map((x) => x.msg || x.message).join("; ") : "") || "";
};

/**
 * A chat function for the OpenAI-style agent: → { message, finish_reason, usage }. callSignal (from the
 * agent's watchdog) also ends a request that hangs.
 */
export function compatChat({ baseUrl, key, fetchImpl = globalThis.fetch.bind(globalThis), signal, maxImages = 0, keep = [] }) {
  return async (messages, { model, tools }, callSignal = null) => {
    let body = cleanMessages(messages, keep);
    if (maxImages) body = limitImages(body, maxImages);
    const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: body, tools, tool_choice: "auto" }),
      signal: callSignal ?? signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      const wait = Number(resp.headers?.get?.("retry-after"));
      throw new CompatHttpError(resp.ok ? 500 : resp.status, errorText(data) || `HTTP ${resp.status}`, Number.isFinite(wait) && wait > 0 ? wait * 1000 : 0);
    }
    const choice = data.choices?.[0];
    if (!choice) throw new CompatHttpError(502, "leere Antwort");
    return { message: choice.message, finish_reason: choice.finish_reason, usage: data.usage };
  };
}

/** The service's errors as clear German messages (the agent's error type; retryable ones are retried). */
export function describeCompatError(provider, model = "") {
  const p = COMPAT_PROVIDERS[provider] || { name: provider };
  return (err) => {
    if (err instanceof PuterError) return err;
    if (!(err instanceof CompatHttpError)) {
      return new PuterError(`Keine Verbindung zu ${p.name} (Internetverbindung prüfen).`, { code: "BUSY", retryable: true });
    }
    const { status, message } = err;
    const text = message.toLowerCase();
    if (status === 401 || status === 403) {
      return new PuterError(`Der ${p.name}-Key wird nicht angenommen (${message.slice(0, 120)}). Unter ⚙ prüfen oder neu erstellen.`, { code: "AUTH" });
    }
    if (status === 402 || /insufficient|balance|credit|quota exceeded|billing|payment|out of (funds|points)/.test(text)) {
      const more = p.paypal ? " (auch mit PayPal)" : "";
      return new PuterError(`Das Guthaben bei ${p.name} ist aufgebraucht – dort aufladen${more} oder unter ⚙ einen kostenlosen Anbieter wählen.`, { code: "ALLOWANCE" });
    }
    if (status === 404 || (/model/.test(text) && /not.?found|does not exist|unknown|invalid model|not available/.test(text))) {
      return new PuterError(`Das Modell „${model}“ gibt es bei ${p.name} nicht (mehr). Unter ⚙ „Modelle laden“ tippen und ein anderes wählen.`, { code: "MODEL" });
    }
    if (status === 400 && /image|vision|multimodal/.test(text)) {
      return new PuterError(`„${model}“ kann bei ${p.name} keine Bilder verarbeiten. Unter ⚙ ein Modell mit Bildverständnis wählen.`, { code: "NO_VISION" });
    }
    if (status === 429) {
      return new PuterError(`${p.name}: kurz zu viele Anfragen.`, { code: "BUSY", retryable: true, retryAfterMs: err.retryAfterMs || 20000, maxRetries: 4 });
    }
    if (status >= 500) return new PuterError(`${p.name} ist gerade ausgelastet (HTTP ${status}).`, { code: "BUSY", retryable: true });
    return new PuterError(`Fehler bei ${p.name}: ${message.slice(0, 300)}`);
  };
}

/** The service's model list (GET /models); ids, the presets first. */
export async function listCompatModels(provider, { baseUrl, key }, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const resp = await fetchImpl(`${baseUrl}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(errorText(data) || `HTTP ${resp.status}`);
  const presets = (COMPAT_PROVIDERS[provider]?.models || []).map((m) => m.id);
  const ids = (Array.isArray(data) ? data : data.data || data.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
  const vision = (m) => {
    const mods = m.architecture?.input_modalities || m.input_modalities || m.capabilities?.vision;
    return mods === true || (Array.isArray(mods) && mods.includes("image"));
  };
  const seeing = new Set((Array.isArray(data) ? data : data.data || []).filter((m) => typeof m === "object" && vision(m)).map((m) => m.id));
  const rest = ids.filter((id) => !presets.includes(id)).sort((a, b) => Number(seeing.has(b)) - Number(seeing.has(a)) || a.localeCompare(b));
  return [...presets.filter((id) => ids.includes(id)), ...rest].map((id) => ({ id, vision: seeing.has(id) || presets.includes(id) }));
}

// OpenRouter: many AI models behind one account; several good ones with image understanding and
// tool use are free (50 requests per day). Sign-in works from the browser (OAuth with PKCE): the user
// logs in at OpenRouter and Ortfinder receives a key for that user – nothing to copy by hand.

import { PuterError } from "./puter-agent.js";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "google/gemma-4-31b-it:free";
const VERIFIER_KEY = "ortfinder.openrouter.verifier";

/** Free models that understand images and can call tools (read live from OpenRouter's model list). */
export async function listFreeVisionModels(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const resp = await fetchImpl(`${OPENROUTER_API}/models`);
  if (!resp.ok) throw new Error(`OpenRouter antwortete mit HTTP ${resp.status}.`);
  const { data = [] } = await resp.json();
  return data
    .filter((m) => {
      const free = m.id.endsWith(":free") || (m.pricing?.prompt === "0" && m.pricing?.completion === "0");
      // "stealth" models come from undisclosed providers; the router may pick models without images.
      return free && m.architecture?.input_modalities?.includes("image") && m.supported_parameters?.includes("tools") &&
        m.id !== "openrouter/free" && !m.id.startsWith("stealth/");
    })
    .map((m) => ({ id: m.id, name: m.name || m.id, context: m.context_length || 0 }))
    .sort((a, b) => (a.id === OPENROUTER_DEFAULT_MODEL ? -1 : b.id === OPENROUTER_DEFAULT_MODEL ? 1 : a.name.localeCompare(b.name)));
}

export class OpenRouterHttpError extends Error {
  constructor(status, message, metadata = null) {
    super(message);
    this.status = status;
    this.metadata = metadata;
  }
}

/** A chat function in the shape the OpenAI-style agent expects: → { message, finish_reason, usage }. */
export function openRouterChat({ key, fetchImpl = globalThis.fetch.bind(globalThis), signal } = {}) {
  return async (messages, { model, tools }) => {
    const resp = await fetchImpl(`${OPENROUTER_API}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-Title": "Ortfinder" },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
      signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      throw new OpenRouterHttpError(data.error?.code || resp.status, data.error?.message || `HTTP ${resp.status}`, data.error?.metadata);
    }
    const choice = data.choices?.[0];
    if (choice?.error) throw new OpenRouterHttpError(choice.error.code || 502, choice.error.message || "Fehler beim Modellanbieter");
    return { message: choice?.message, finish_reason: choice?.finish_reason, usage: data.usage };
  };
}

/** OpenRouter's errors as clear German messages (same error type as the agent's other services). */
export function describeOpenRouterError(err) {
  if (err instanceof PuterError) return err;
  if (!(err instanceof OpenRouterHttpError)) {
    return new PuterError("Keine Verbindung zu OpenRouter (Internetverbindung prüfen).", { code: "BUSY", retryable: true });
  }
  const { status, message } = err;
  const raw = `${message} ${JSON.stringify(err.metadata || {})}`;
  if (status === 401) return new PuterError("Die OpenRouter-Anmeldung ist ungültig oder abgelaufen. Unter ⚙ neu anmelden.", { code: "AUTH" });
  if (status === 429 && /per-day|per day|daily/i.test(raw)) {
    return new PuterError(
      "Das Tageslimit der kostenlosen OpenRouter-Modelle ist erreicht (50 Anfragen pro Tag). Es gilt wieder ab morgen – " +
        "oder unter ⚙ einen anderen Anbieter wählen.",
      { code: "ALLOWANCE" },
    );
  }
  if (status === 429) return new PuterError("OpenRouter: kurz zu viele Anfragen (kostenlos max. 20 pro Minute).", { code: "BUSY", retryable: true });
  if (status === 402) return new PuterError("Für dieses Modell braucht OpenRouter Guthaben. Unter ⚙ ein kostenloses Modell (Endung „:free“) wählen.", { code: "ALLOWANCE" });
  if (status === 404 && /data policy|privacy|training/i.test(raw)) {
    return new PuterError(
      "OpenRouter lässt die kostenlosen Modelle mit deinen Datenschutz-Einstellungen nicht zu. Unter openrouter.ai/settings/privacy " +
        "die kostenlosen Modelle erlauben (deren Anbieter dürfen Eingaben ggf. speichern) – oder einen anderen Anbieter wählen.",
      { code: "POLICY" },
    );
  }
  if (status === 404 || /no endpoints|not a valid model|tool use|image input/i.test(raw)) {
    return new PuterError(`Dieses Modell ist gerade nicht verfügbar oder kann keine Bilder/Werkzeuge (${message.slice(0, 160)}). Unter ⚙ ein anderes wählen.`, { code: "MODEL" });
  }
  if (status === 403) return new PuterError(`OpenRouter hat die Anfrage abgelehnt: ${message.slice(0, 200)}`, { code: "DENIED" });
  if (status >= 500 || status === 408) return new PuterError(`Der Modellanbieter ist gerade ausgelastet (${message.slice(0, 120)}).`, { code: "BUSY", retryable: true });
  return new PuterError(`Fehler bei OpenRouter: ${message.slice(0, 300)}`);
}

// ---------- sign-in (OAuth with PKCE) ----------

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Start the sign-in: remember a secret for this browser and send the user to OpenRouter. */
export async function openRouterSignInUrl(callbackUrl, storage = globalThis.localStorage) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  storage.setItem(VERIFIER_KEY, verifier);
  const challenge = await pkceChallenge(verifier);
  return `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=${challenge}&code_challenge_method=S256`;
}

/** Back from OpenRouter with ?code=…: exchange it for the user's key. */
export async function finishOpenRouterSignIn(code, { fetchImpl = globalThis.fetch.bind(globalThis), storage = globalThis.localStorage } = {}) {
  const verifier = storage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("Die Anmeldung wurde in einem anderen Browser begonnen. Bitte erneut anmelden.");
  const resp = await fetchImpl(`${OPENROUTER_API}/auth/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.key) throw new Error(`OpenRouter-Anmeldung fehlgeschlagen: ${data.error?.message || `HTTP ${resp.status}`}`);
  storage.removeItem(VERIFIER_KEY);
  return data.key;
}

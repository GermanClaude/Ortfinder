// Ortfinder web app: runs entirely in the browser (GitHub Pages friendly).

import { GeminiAgent, MODELS, assembleResult } from "./agent.js";
import { CLAUDE_DEFAULT_MODEL, CLAUDE_KEY_PATTERN, CLAUDE_MODELS, ClaudeAgent, loadSdk as loadClaudeSdk } from "./claude-agent.js";
import { OSMClient, haversineKm, viewCone } from "./geo.js";
import { decodeImage, detailTiles, overview, rulerOverview, zoomCrop } from "./imaging.js";
import { TILES_MARK } from "./compact.js";
import { drapedTerrain, topViewImage } from "./groundview.js";
import { DEVICES, GUIDES, detectDevice, guideNodes } from "./guides.js";
import { loadTileImage, renderMapView } from "./mapview.js";
import { extractMetadata, hintsForModel, horizontalFov, typicalPhoneFov } from "./metadata.js";
import { OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL, OLLAMA_SUGGESTIONS, OllamaAgent, listOllamaModels, normalizeOllamaUrl } from "./ollama-agent.js";
import {
  OPENROUTER_DEFAULT_MODEL, describeOpenRouterError, fallbackModels, finishOpenRouterSignIn, listFreeVisionModels, openRouterChat, openRouterSignInUrl,
} from "./openrouter.js";
import { PUTER_MODELS, PuterAgent, describePuterError, loadPuter } from "./puter-agent.js";
import { COMPAT_PROVIDERS, compatChat, compatSettings, describeCompatError, isCompat, listCompatModels } from "./providers.js";
import { solveCameraWithTerrain } from "./resection.js";
import { clearRun, loadRun, saveRun, waitWhileHidden } from "./resume.js";
import { renderViewImage, visibleAreaFor } from "./scene3d.js";
import { peakLabel, photoSkyline, skylineImage, skylineMatch } from "./skyline.js";
import { Terrain } from "./terrain.js";
import qrcode from "../vendor/qrcode.mjs";
import { ToolExecutor } from "./tools.js";
import { contactSheet, languages, photosNearby, reverseImageSearch, visionSummary, wikiSearch } from "./websearch.js";
import {
  SCREENSHOT_PROMPT, askAI, feedbackRecord, feedbackStats, lessonPrompt, lessonsBlock, loadFeedback, loadLessons, mergeLessons, parseLessons,
  parseLocation, parseScreenshotAnswer, saveFeedback, saveLessons, shareIssueUrl,
} from "./feedback.js";

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const PRECISION = {
  exakt: "Exakter Standort", strasse: "Straßengenau", stadtteil: "Stadtteil", stadt: "Stadt",
  region: "Region", land: "Land", kontinent: "Kontinent", unbekannt: "Unbekannt",
};
// New AI Studio keys ("auth keys", since May 2026) start with "AQ.", older standard keys with "AIza".
const KEY_PATTERN = /^(AQ\.[0-9A-Za-z_.-]{20,}|AIza[0-9A-Za-z_-]{35})$/;
const STORAGE_KEY = "ortfinder.settings.v1";

const state = {
  controller: null, map: null, layer: null, hypoLayer: null, imageSource: null, startedAt: 0, timer: null, zoomCount: 0, replayT: null, run: null,
  aspect: 4 / 3, bases: null, coneLayer: null, resultToken: 0, running: false, wakeLock: null, skyline: null, truth: null,
};
const osm = new OSMClient();
const terrain = new Terrain();
const BASE_TITLE = document.title;

// ---------- while Ortfinder is off screen ----------

/** Keep the screen on during an analysis, so the phone doesn't lock (which would pause the page). */
async function keepAwake(on) {
  if (!on) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    lock?.release?.().catch(() => {});
    return;
  }
  if (state.wakeLock || !navigator.wakeLock || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener?.("release", () => { state.wakeLock = null; });
  } catch {
    state.wakeLock = null; // e.g. battery saver
  }
}

function setTitle(prefix = "") {
  document.title = prefix ? `${prefix} ${BASE_TITLE}` : BASE_TITLE;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.running) keepAwake(true); // the browser releases the wake lock whenever the page is hidden
  else setTitle();
});

async function registerWorker() {
  try {
    return (await navigator.serviceWorker?.register("sw.js")) ?? null;
  } catch {
    return null;
  }
}

async function enableNotifications() {
  $("#notify").hidden = true;
  let permission = "denied";
  try {
    permission = await Notification.requestPermission();
    if (permission === "granted") await registerWorker(); // Android shows notifications only via a service worker
  } catch {
    // not supported
  }
  log("status", permission === "granted"
    ? "Du bekommst eine Benachrichtigung, sobald das Ergebnis da ist."
    : "Benachrichtigungen sind in diesem Browser nicht erlaubt.");
}

/** Tell the user when a run ends while Ortfinder is in the background. */
async function announceEnd(ok, body) {
  if (document.visibilityState === "visible") {
    setTitle();
    return;
  }
  setTitle(ok ? "✔" : "⚠");
  navigator.vibrate?.(ok ? [120, 80, 120] : 300);
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = (await navigator.serviceWorker?.getRegistration()) ?? (await registerWorker());
    if (reg?.showNotification) await reg.showNotification("Ortfinder", { body, tag: "ortfinder-result" });
    else new Notification("Ortfinder", { body, tag: "ortfinder-result" });
  } catch {
    // notifications unavailable
  }
}

// One analysis at a time across tabs: a tab holds this lock while it analyses, so a second tab
// doesn't resume the same interrupted run.
const LOCK = "ortfinder-analysis";

function holdLock(onLost) {
  if (!navigator.locks) return () => {};
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  navigator.locks.request(LOCK, { steal: true }, () => held).catch(onLost); // rejects when another tab takes over
  return release;
}

async function lockedElsewhere() {
  try {
    const { held = [] } = await navigator.locks.query();
    return held.some((l) => l.name === LOCK);
  } catch {
    return false;
  }
}

/** Continue an analysis the browser interrupted (page discarded or reloaded while off screen). */
async function resumeInterrupted() {
  const rec = await loadRun();
  if (!rec?.file || (await lockedElsewhere())) return;
  analyze(rec.file, rec);
}

// ---------- settings (kept in this browser only) ----------

function storageGet() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function storageSet(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // private mode or blocked storage: settings just won't persist
  }
}

const settings = {
  // "puter": free, no key (user signs in at Puter) · "gemini": own Gemini API key ·
  // "ollama": open model on the user's own PC (unlimited; phones reach it through a tunnel) ·
  // "openrouter": free models, sign-in by tap · "claude": own Anthropic API key (paid per use)
  provider: "puter",
  puterModel: PUTER_MODELS[0].id,
  ollamaUrl: OLLAMA_DEFAULT_URL,
  ollamaModel: OLLAMA_DEFAULT_MODEL,
  ollamaCtx: 32768,
  tunnelUrl: "",
  openrouterKey: "",
  openrouterModel: OPENROUTER_DEFAULT_MODEL,
  claudeKey: "",
  claudeModel: CLAUDE_DEFAULT_MODEL,
  compat: {}, // more services with an OpenAI-style API (providers.js): { [id]: { key, model, url } }
  visionKey: "",
  learn: true,
  apiKey: "",
  model: MODELS[0].id,
  thinking: "medium",
  webSearch: true,
  maxSteps: 10,
  remember: true,
  ...storageGet(),
};
// 8 was the stored default before the fine-location step existed, which needs about two more rounds.
if (settings.maxSteps === 8) settings.maxSteps = 10;
// The first OpenRouter default (Gemma 4 31B, free) is almost always overloaded; it stays a fallback.
if (settings.openrouterModel === "google/gemma-4-31b-it:free") settings.openrouterModel = OPENROUTER_DEFAULT_MODEL;

function fillSettingsForm() {
  for (const [id, p] of Object.entries(COMPAT_PROVIDERS)) {
    if ($(`#provider option[value="${id}"]`)) continue;
    const group = $(`#provider optgroup[data-group="${p.group}"]`);
    group.append(el("option", { value: id }, p.label));
  }
  // The custom service goes last.
  const custom = $('#provider option[value="custom"]');
  custom?.parentElement.append(custom);
  $("#provider").value = settings.provider;
  state.formProvider = settings.provider;
  const puterSelect = $("#puter-model");
  puterSelect.replaceChildren(...PUTER_MODELS.map((m) => el("option", { value: m.id }, m.label)));
  if (!PUTER_MODELS.some((m) => m.id === settings.puterModel)) puterSelect.append(el("option", { value: settings.puterModel }, settings.puterModel));
  puterSelect.value = settings.puterModel;
  applyProvider(settings.provider);
  const select = $("#model");
  select.replaceChildren(...MODELS.map((m) => el("option", { value: m.id }, m.label)));
  if (!MODELS.some((m) => m.id === settings.model)) select.append(el("option", { value: settings.model }, settings.model));
  select.value = settings.model;
  $("#api-key").value = settings.apiKey;
  $("#thinking").value = settings.thinking;
  $("#web-search").checked = settings.webSearch;
  $("#max-steps").value = settings.maxSteps;
  $("#remember-key").checked = settings.remember;
  $("#ollama-url").value = settings.ollamaUrl;
  fillOllamaModels([{ name: settings.ollamaModel, usable: true }]);
  $("#ollama-ctx").value = String(settings.ollamaCtx);
  $("#tunnel-url").value = settings.tunnelUrl;
  renderPhoneQr();
  fillOpenRouterModels([{ id: settings.openrouterModel, name: settings.openrouterModel }]);
  $("#or-key").value = settings.openrouterKey;
  showOpenRouterStatus();
  const claudeSelect = $("#claude-model");
  claudeSelect.replaceChildren(...CLAUDE_MODELS.map((m) => el("option", { value: m.id }, m.label)));
  if (!CLAUDE_MODELS.some((m) => m.id === settings.claudeModel)) claudeSelect.append(el("option", { value: settings.claudeModel }, settings.claudeModel));
  claudeSelect.value = settings.claudeModel;
  $("#claude-key").value = settings.claudeKey;
  $("#vision-key").value = settings.visionKey;
  $("#learn").checked = settings.learn !== false;
  renderLessonList();
  checkKeyFormat();
  checkClaudeKey();
  fillCompatForm(settings.provider);
}

// ---------- more services with an OpenAI-style API (providers.js) ----------

/** The key, model and address typed for a service, kept while switching between services in the form. */
function stashCompatForm(provider) {
  if (!isCompat(provider)) return;
  const own = $("#compat-model-own").value.trim();
  settings.compat = { ...settings.compat, [provider]: {
    key: $("#compat-key").value.trim(), model: own || $("#compat-model").value, url: $("#compat-url").value.trim(),
  } };
}

function fillCompatModels(provider, models, chosen) {
  const select = $("#compat-model");
  const list = models.length ? models : COMPAT_PROVIDERS[provider].models;
  const options = list.map((m) => el("option", { value: m.id }, m.label || (m.vision ? `${m.id} (Bilder)` : m.id)));
  if (chosen && !list.some((m) => m.id === chosen)) options.unshift(el("option", { value: chosen }, chosen));
  select.replaceChildren(...options);
  if (chosen) select.value = chosen;
}

function fillCompatForm(provider) {
  if (!isCompat(provider)) return;
  const p = COMPAT_PROVIDERS[provider];
  const c = compatSettings(settings, provider);
  $("#compat-info").replaceChildren(...p.lines.map((line) => el("li", {}, line)));
  const steps = p.keyUrl
    ? [
      el("li", {}, "Konto anlegen und einen API-Key erstellen: ", el("a", { href: p.keyUrl, target: "_blank", rel: "noopener" }, new URL(p.keyUrl).host), "."),
      el("li", {}, "Den Key unten einfügen, ein Modell wählen und speichern."),
      el("li", {}, "Der Key bleibt in deinem Browser und geht nur direkt an ", p.name, "."),
    ]
    : [el("li", {}, "Adresse der Schnittstelle, Key und ein Modell mit Bild- und Werkzeug-Unterstützung eintragen."), el("li", {}, "Der Key bleibt in deinem Browser.")];
  $("#compat-steps").replaceChildren(...steps);
  $("#compat-url").value = settings.compat?.[provider]?.url || "";
  $("#compat-key").value = c.key;
  $("#compat-key").placeholder = p.keyHint;
  const preset = p.models.some((m) => m.id === c.model);
  fillCompatModels(provider, [], c.model);
  $("#compat-model-own").value = preset || !c.model ? "" : c.model;
  $("#compat-status").textContent = c.key ? "✔ Key eingetragen." : "Noch kein Key eingetragen.";
}

async function loadCompatModels() {
  const provider = $("#provider").value;
  if (!isCompat(provider)) return;
  stashCompatForm(provider);
  const c = compatSettings(settings, provider);
  const status = $("#compat-status");
  if (!c.baseUrl) {
    status.textContent = "Erst die Adresse der Schnittstelle eintragen.";
    return;
  }
  status.textContent = "Modelle werden geladen …";
  try {
    const models = await listCompatModels(provider, c);
    fillCompatModels(provider, models, c.model);
    status.textContent = `${models.length} Modelle gefunden. Nötig ist eines mit Bildverständnis und Werkzeugen (Function Calling).`;
  } catch (err) {
    status.textContent = `Modelle konnten nicht geladen werden: ${err.message}${c.key ? "" : " (Key eintragen?)"}`;
  }
}

function checkClaudeKey() {
  const key = $("#claude-key").value.trim();
  const hint = $("#claude-key-hint");
  if (key && !CLAUDE_KEY_PATTERN.test(key)) {
    hint.className = "small warn";
    hint.textContent = "Das sieht nicht wie ein Claude-API-Key aus (beginnt mit „sk-ant-“). Du kannst es trotzdem versuchen.";
  } else {
    hint.className = "small muted";
    hint.replaceChildren(
      key ? "✔ Key eingetragen. " : "Noch kein Key. ",
      "Erstellen unter ",
      el("a", { href: "https://platform.claude.com/settings/keys", target: "_blank", rel: "noopener" }, "platform.claude.com → API Keys"),
      " (Anleitung unten). Der Key bleibt in deinem Browser und geht nur direkt an Anthropic.",
    );
  }
}

function checkKeyFormat() {
  const key = $("#api-key").value.trim();
  const hint = $("#key-hint");
  if (key && !KEY_PATTERN.test(key)) {
    hint.className = "small warn";
    hint.textContent = /^\d+$/.test(key)
      ? "Das ist eine Zahl – vermutlich eine Google-Cloud-Projektnummer, kein API-Key. Ein Gemini-Key beginnt mit „AQ.“ (oder bei älteren Keys „AIza“), siehe aistudio.google.com/apikey."
      : "Das sieht nicht wie ein Gemini-API-Key aus (beginnt normalerweise mit „AQ.“ oder „AIza“). Du kannst es trotzdem versuchen.";
  } else {
    hint.className = "small muted";
    hint.replaceChildren(
      "Kostenlos erstellen unter ",
      el("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener" }, "aistudio.google.com/apikey"),
      ". Der Key bleibt in deinem Browser und wird nur direkt an Google gesendet.",
    );
  }
}

/** What is written to storage: API keys only when the visitor wants them remembered. */
const storedSettings = () => ({
  ...settings, apiKey: settings.remember ? settings.apiKey : "", claudeKey: settings.remember ? settings.claudeKey : "",
  visionKey: settings.remember ? settings.visionKey : "",
  compat: settings.remember ? settings.compat : Object.fromEntries(Object.entries(settings.compat || {}).map(([id, c]) => [id, { ...c, key: "" }])),
});

function persist() {
  storageSet(storedSettings());
  updateStatusChip();
}

function saveKey() {
  settings.apiKey = $("#api-key").value.trim();
  persist();
  showKeyBar(!settings.apiKey);
}

/** Show the settings and hints that belong to the chosen provider. */
function applyProvider(provider) {
  $("#settings").dataset.provider = provider;
  $("#settings").dataset.kind = isCompat(provider) ? "compat" : "";
  $("#puter-note").hidden = provider !== "puter";
  const orNote = $("#openrouter-note");
  orNote.hidden = provider !== "openrouter";
  orNote.textContent = settings.openrouterKey
    ? `Kostenlos über OpenRouter (${settings.openrouterModel}, bis zu 50 Anfragen am Tag).`
    : "Kostenlos über OpenRouter: Beim ersten Foto meldest du dich einmalig an (Google, GitHub oder E-Mail, ohne Kreditkarte).";
  const note = $("#ollama-note");
  note.hidden = provider !== "ollama";
  note.textContent = `Die KI läuft auf deinem PC (${settings.ollamaModel} über ${settings.ollamaUrl}) – unbegrenzt und kostenlos. ` +
    "Der PC muss eingeschaltet sein und das Ortfinder-Startskript laufen.";
  const claudeNote = $("#claude-note");
  claudeNote.hidden = provider !== "claude";
  claudeNote.textContent = settings.claudeKey
    ? `Claude (${settings.claudeModel}) mit deinem eigenen API-Key – Anthropic rechnet jede Analyse über dein Guthaben ab.`
    : "Für Claude fehlt noch dein API-Key: unter ⚙ eintragen (die Anleitung dort zeigt Schritt für Schritt, wie du ihn bekommst).";
  showKeyBar(provider === "gemini" && !settings.apiKey);
  renderGuide(provider);
}

// ---------- step-by-step guides ----------

function renderGuide(provider = $("#provider").value) {
  const guide = GUIDES[provider];
  const box = $("#guide");
  if (!guide) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  state.guideDevice ??= detectDevice();
  const device = state.guideDevice;
  $("#guide-title").textContent = `📖 Anleitung Schritt für Schritt: ${guide.title}`;
  $("#guide-tabs").replaceChildren(...DEVICES.map((d) => el("button", {
    type: "button", role: "tab", class: d.id === device ? "tab active" : "tab", "aria-selected": String(d.id === device),
    onclick: () => {
      state.guideDevice = d.id;
      renderGuide(provider);
    },
  }, d.label)));
  $("#guide-body").replaceChildren(...guideNodes(provider, device));
  $("#guide-link").href = `anleitung.html#${provider}/${device}`;
}

// ---------- OpenRouter ----------

function fillOpenRouterModels(models) {
  const select = $("#or-model");
  const ids = models.map((m) => m.id);
  const options = models.map((m) => el("option", { value: m.id }, m.name));
  if (!ids.includes(settings.openrouterModel)) options.unshift(el("option", { value: settings.openrouterModel }, settings.openrouterModel));
  select.replaceChildren(...options);
  select.value = settings.openrouterModel;
}

async function loadOpenRouterModels() {
  try {
    const models = await listFreeVisionModels();
    if (models.length) {
      state.orModelIds = models.map((m) => m.id);
      fillOpenRouterModels(models);
    }
  } catch {
    // keep the saved choice; the list is only a convenience
  }
  return state.orModelIds || null;
}

function showOpenRouterStatus(message = "", kind = "") {
  const status = $("#or-status");
  const signedIn = Boolean(settings.openrouterKey);
  status.className = `small ${kind === "bad" ? "status-bad" : signedIn ? "status-ok" : "muted"}`;
  status.textContent = message || (signedIn ? "✔ Bei OpenRouter angemeldet." : "Noch nicht angemeldet.");
  $("#or-signin").textContent = signedIn ? "Neu anmelden" : "Bei OpenRouter anmelden (kostenlos)";
}

/** Send the user to OpenRouter; they come back with ?code=… (see finishSignInFromUrl). */
async function startOpenRouterSignIn() {
  // Keep a model chosen in the (unsaved) settings form across the trip to OpenRouter.
  if ($("#or-model").value) settings.openrouterModel = $("#or-model").value;
  persist();
  try {
    location.href = await openRouterSignInUrl(location.origin + location.pathname);
  } catch (err) {
    showOpenRouterStatus(`Anmeldung nicht möglich: ${err.message}`, "bad");
  }
}

/** Back from OpenRouter: exchange the code for this user's key and switch to OpenRouter. */
async function finishSignInFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return;
  history.replaceState(null, "", location.pathname + location.hash);
  try {
    settings.openrouterKey = await finishOpenRouterSignIn(code);
    settings.provider = "openrouter";
    persist();
    fillSettingsForm();
    showOpenRouterStatus("✔ Bei OpenRouter angemeldet – kostenlos, bis zu 50 Anfragen am Tag.", "ok");
  } catch (err) {
    showSettings(true);
    showOpenRouterStatus(err.message, "bad");
  }
}

/**
 * Before an analysis without OpenRouter key: save the photo (like an interrupted run), then sign in.
 * After returning, the saved run starts automatically (resumeInterrupted).
 */
async function ensureOpenRouterKey(emit, signal, record) {
  if (settings.openrouterKey) return;
  emit("status", { message: "Einmalige kostenlose Anmeldung bei OpenRouter nötig – danach geht die Analyse automatisch weiter." });
  const box = $("#result");
  await new Promise((resolve, reject) => {
    const button = el("button", { type: "button", class: "primary", id: "or-signin-run" }, "Bei OpenRouter anmelden (kostenlos)");
    button.addEventListener("click", async () => {
      button.disabled = true;
      await saveRun(record());
      startOpenRouterSignIn();
    });
    signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Abgebrochen", "AbortError")), { once: true });
    box.replaceChildren(el("div", { class: "signin-box" },
      el("p", {}, el("strong", {}, "Ein Schritt noch: "),
        "Melde dich einmalig kostenlos bei OpenRouter an (Google, GitHub oder E-Mail, ohne Kreditkarte). Danach kommst du hierher zurück, und die Analyse startet von selbst."),
      button));
    button.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// ---------- own PC (Ollama) ----------

function fillOllamaModels(models) {
  const select = $("#ollama-model");
  const usable = models.filter((m) => m.usable);
  const names = usable.map((m) => m.name);
  const options = usable.map((m) => el("option", { value: m.name }, `${m.name}${m.params ? ` (${m.params}` : ""}${m.sizeGb ? `, ${m.sizeGb} GB)` : m.params ? ")" : ""}`));
  // Keep the saved choice selectable even before the PC was asked which models it has.
  if (!names.includes(settings.ollamaModel)) options.unshift(el("option", { value: settings.ollamaModel }, settings.ollamaModel));
  select.replaceChildren(...options);
  select.value = names.includes(settings.ollamaModel) || !names.length ? settings.ollamaModel : names[0];
}

function ollamaStatus(text, kind = "") {
  const status = $("#ollama-status");
  status.className = `small ${kind === "ok" ? "status-ok" : kind === "bad" ? "status-bad" : "muted"}`;
  status.textContent = text;
}

/** Ask the PC which models it has and whether Ortfinder may use them. */
async function checkOllama() {
  const url = normalizeOllamaUrl($("#ollama-url").value);
  $("#ollama-url").value = url;
  ollamaStatus(`Verbinde mit ${url} …`);
  try {
    const models = await listOllamaModels(url);
    const usable = models.filter((m) => m.usable);
    fillOllamaModels(models);
    if (usable.length) {
      ollamaStatus(`✔ Verbunden. ${usable.length} passende(s) Modell(e) gefunden.`, "ok");
    } else {
      ollamaStatus(
        `Verbunden, aber kein Modell mit Bild- und Werkzeug-Unterstützung installiert${models.length ? ` (vorhanden: ${models.map((m) => m.name).join(", ")})` : ""}. ` +
        `Am PC ausführen: ollama pull ${OLLAMA_DEFAULT_MODEL}`, "bad");
    }
    return usable.length > 0;
  } catch (err) {
    ollamaStatus(err.message, "bad");
    $("#ollama-help").open = true;
    return false;
  }
}

function phoneLink(tunnel = settings.tunnelUrl, model = settings.ollamaModel) {
  return `${location.origin}${location.pathname}#ki=${encodeURIComponent(tunnel)}&modell=${encodeURIComponent(model)}`;
}

/** QR code that opens Ortfinder on the phone, already connected to this PC through the tunnel. */
function renderPhoneQr() {
  const box = $("#phone-qr");
  const tunnel = $("#tunnel-url").value.trim();
  if (!/^https:\/\/[^/\s]+/i.test(tunnel)) {
    box.hidden = true;
    return;
  }
  const link = phoneLink(normalizeOllamaUrl(tunnel), $("#ollama-model").value || settings.ollamaModel);
  const qr = qrcode(0, "M");
  qr.addData(link);
  qr.make();
  box.replaceChildren(
    el("strong", { class: "small" }, "Mit der Handy-Kamera scannen:"),
    el("img", { src: qr.createDataURL(6, 2), alt: "QR-Code für das Handy" }),
    el("a", { href: link, target: "_blank", rel: "noopener" }, link),
  );
  box.hidden = false;
}

/**
 * Links from the start script or the QR code carry the connection: #ki=<address>&modell=<model>
 * (&handy=<tunnel> when the PC opens it, to show the QR code right away).
 */
function applyLinkSettings() {
  const params = new URLSearchParams(location.hash.slice(1));
  const ki = params.get("ki");
  if (!ki) return;
  settings.provider = "ollama";
  settings.ollamaUrl = normalizeOllamaUrl(ki);
  if (params.get("modell")) settings.ollamaModel = params.get("modell");
  if (params.get("handy")) settings.tunnelUrl = normalizeOllamaUrl(params.get("handy"));
  storageSet(storedSettings());
  history.replaceState(null, "", location.pathname + location.search);
  state.openPhoneQr = Boolean(params.get("handy"));
}

function saveSettings() {
  settings.provider = $("#provider").value;
  settings.puterModel = $("#puter-model").value;
  settings.ollamaUrl = normalizeOllamaUrl($("#ollama-url").value);
  settings.ollamaModel = $("#ollama-model").value || settings.ollamaModel;
  settings.ollamaCtx = Number($("#ollama-ctx").value) || 32768;
  settings.tunnelUrl = $("#tunnel-url").value.trim() ? normalizeOllamaUrl($("#tunnel-url").value) : "";
  settings.openrouterModel = $("#or-model").value || settings.openrouterModel;
  settings.openrouterKey = $("#or-key").value.trim();
  settings.claudeModel = $("#claude-model").value || settings.claudeModel;
  settings.claudeKey = $("#claude-key").value.trim();
  stashCompatForm(settings.provider);
  settings.visionKey = $("#vision-key").value.trim();
  settings.learn = $("#learn").checked;
  settings.model = $("#model").value;
  settings.thinking = $("#thinking").value;
  settings.webSearch = $("#web-search").checked;
  settings.maxSteps = Math.max(3, Math.min(60, parseInt($("#max-steps").value, 10) || 10));
  settings.remember = $("#remember-key").checked;
  persist();
  applyProvider(settings.provider);
  showSettings(false);
}

function showSettings(open) {
  $("#settings").hidden = !open;
  $("#settings-toggle").setAttribute("aria-expanded", String(open));
}

function showKeyBar(open, attention = false) {
  const bar = $("#key-bar");
  bar.hidden = !open;
  if (open && attention) {
    bar.classList.remove("attention");
    void bar.offsetWidth; // restart the animation
    bar.classList.add("attention");
    $("#api-key").focus();
  }
}

function updateStatusChip() {
  const chip = $("#settings-toggle");
  if (settings.provider === "puter") {
    chip.textContent = `⚙ ${settings.puterModel} · kostenlos über Puter`;
    chip.className = "chip ok";
  } else if (settings.provider === "openrouter") {
    chip.textContent = `⚙ ${settings.openrouterModel.replace(/^[^/]+\//, "")} · kostenlos über OpenRouter`;
    chip.className = settings.openrouterKey ? "chip ok" : "chip";
  } else if (settings.provider === "ollama") {
    chip.textContent = `⚙ ${settings.ollamaModel} · auf deinem PC, unbegrenzt`;
    chip.className = "chip ok";
  } else if (settings.provider === "claude") {
    chip.textContent = settings.claudeKey ? `⚙ ${settings.claudeModel} · eigener Claude-Key` : "⚙ Claude: API-Key fehlt";
    chip.className = settings.claudeKey ? "chip ok" : "chip";
  } else if (isCompat(settings.provider)) {
    const c = compatSettings(settings, settings.provider);
    const name = COMPAT_PROVIDERS[settings.provider].name;
    chip.textContent = c.key ? `⚙ ${c.model} · ${name}` : `⚙ ${name}: API-Key fehlt`;
    chip.className = c.key ? "chip ok" : "chip";
  } else if (settings.apiKey) {
    chip.textContent = `⚙ ${settings.model} · ${settings.webSearch ? "mit Google-Suche" : "ohne Websuche"}`;
    chip.className = "chip ok";
  } else {
    chip.textContent = "⚙ Einstellungen";
    chip.className = "chip";
  }
}

function setupSettings() {
  fillSettingsForm();
  updateStatusChip();
  $("#provider").addEventListener("change", () => {
    stashCompatForm(state.formProvider);
    state.formProvider = $("#provider").value;
    fillCompatForm($("#provider").value);
    applyProvider($("#provider").value);
    if ($("#provider").value === "ollama") checkOllama();
    if ($("#provider").value === "openrouter") loadOpenRouterModels();
  });
  $("#compat-load").addEventListener("click", loadCompatModels);
  $("#compat-key-visibility").addEventListener("click", () => {
    const input = $("#compat-key");
    input.type = input.type === "password" ? "text" : "password";
    $("#compat-key-visibility").textContent = input.type === "password" ? "Zeigen" : "Verbergen";
  });
  $("#or-signin").addEventListener("click", startOpenRouterSignIn);
  $("#or-signout").addEventListener("click", () => {
    settings.openrouterKey = "";
    $("#or-key").value = "";
    persist();
    showOpenRouterStatus();
  });
  if (settings.provider === "openrouter") loadOpenRouterModels();
  $("#ollama-check").addEventListener("click", checkOllama);
  $("#claude-key").addEventListener("input", checkClaudeKey);
  $("#claude-key-visibility").addEventListener("click", () => {
    const input = $("#claude-key");
    input.type = input.type === "password" ? "text" : "password";
    $("#claude-key-visibility").textContent = input.type === "password" ? "Zeigen" : "Verbergen";
  });
  $("#tunnel-url").addEventListener("input", renderPhoneQr);
  $("#ollama-model").addEventListener("change", renderPhoneQr);
  if (state.openPhoneQr) {
    // Opened by the start script on the PC: show the QR code for the phone right away.
    showSettings(true);
    $("#phone-help").open = true;
    $("#phone-help").scrollIntoView({ block: "center" });
    checkOllama();
  }
  $("#settings-toggle").addEventListener("click", () => showSettings($("#settings").hidden));
  $("#save-settings").addEventListener("click", saveSettings);
  $("#save-key").addEventListener("click", saveKey);
  $("#change-key").addEventListener("click", () => showKeyBar(true, true));
  $("#api-key").addEventListener("input", checkKeyFormat);
  $("#api-key").addEventListener("keydown", (e) => e.key === "Enter" && saveKey());
  $("#key-visibility").addEventListener("click", () => {
    const input = $("#api-key");
    input.type = input.type === "password" ? "text" : "password";
    $("#key-visibility").textContent = input.type === "password" ? "Zeigen" : "Verbergen";
  });
}

// ---------- upload ----------

function setupDropzone() {
  const drop = $("#drop");
  const input = $("#file");
  drop.addEventListener("click", () => input.click());
  $("#demo").addEventListener("click", (e) => {
    e.stopPropagation();
    runDemo();
  });
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => {
    if (input.files[0]) analyze(input.files[0]);
    input.value = "";
  });
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  drop.addEventListener("drop", (e) => {
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    if (file) analyze(file);
  });
  document.addEventListener("paste", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) analyze(item.getAsFile());
  });
  $("#cancel").addEventListener("click", () => state.controller?.abort());
  $("#notify").addEventListener("click", enableNotifications);
}

// ---------- pipeline ----------

function initMap() {
  if (state.map || typeof L === "undefined") return;
  state.map = L.map("map", { worldCopyJump: true }).setView([30, 10], 2);
  const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);
  const aerial = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Luftbild: Esri, Maxar, Earthstar Geographics",
  });
  L.control.layers({ Karte: street, Luftbild: aerial }, null, { position: "topright" }).addTo(state.map);
  state.bases = { street, aerial };
  state.layer = L.featureGroup().addTo(state.map);
  state.hypoLayer = L.featureGroup().addTo(state.map);
}

function setupImageSearch() {
  for (const site of Object.keys(LENS_SITES)) $(`#lens-${site}`)?.addEventListener("click", () => searchImageOn(site));
}

function resetWorkspace() {
  state.controller?.abort();
  if (state.running) {
    // A new analysis (or the example) replaces the running one: it must not be resumed later.
    state.running = false;
    keepAwake(false);
    clearRun();
  }
  clearInterval(state.timer);
  state.zoomCount = 0;
  state.replayT = null;
  state.run = null;
  state.truth = null;
  $("#demo-banner").hidden = true;
  showSettings(false);
  $("#workspace").hidden = false;
  $("#drop").classList.add("compact");
  $("#photo").removeAttribute("src");
  $("#overlay").replaceChildren();
  $("#zooms").replaceChildren(el("p", { class: "muted small" }, "Noch keine Ausschnitte."));
  $("#zoom-count").textContent = "";
  $("#log").replaceChildren();
  $("#progress").textContent = "";
  $("#osm-link").hidden = true;
  $("#result").replaceChildren(pendingBox());
  $("#clues-card").hidden = true;
  $("#clue-gallery").replaceChildren();
  state.imageSource = null;
  state.resultToken += 1;
  state.coneLayer = null;
  state.topLayer = null;
  state.skyline = null;
  state.viewer?.dispose();
  state.viewer = null;
  initMap();
  state.layer?.clearLayers();
  state.hypoLayer?.clearLayers();
  setBaseLayer("street");
  if (state.map) {
    state.map.setView([25, 10], 2); // every analysis starts on the world map and zooms in from there
    setTimeout(() => state.map.invalidateSize(), 50);
  }
}

function pendingBox() {
  return el("div", { class: "pending-wrap" },
    el("div", { class: "pending" }, el("span", { class: "spinner" }), " Analyse läuft …"),
    el("p", { class: "small muted" },
      "Du kannst zwischendurch die App oder den Tab wechseln: Ortfinder speichert nach jeder Runde und macht " +
      "dort weiter, sobald die Seite wieder offen ist – auch wenn der Browser sie neu geladen hat."));
}

function buildIntro(image, metadata, { userHints = "", lens = null, lessons = "" } = {}) {
  const hints = hintsForModel(metadata);
  const parts = [
    `Bestimme, wo dieses Foto aufgenommen wurde. Originalauflösung: ${image.width}×${image.height} Pixel (zoom_image arbeitet auf dem Original).`,
    "Bild 1: das Foto mit gelbem Lineal im Rand (0–1 bezieht sich auf das Foto selbst; für zoom_image und solve_camera).",
    hints.length
      ? "Metadaten aus der Datei (GPS-Daten, falls vorhanden, werden dir absichtlich nicht gezeigt):\n- " + hints.join("\n- ")
      : "Die Datei enthält keine verwertbaren Metadaten – nur der Bildinhalt zählt.",
  ];
  if (!metadata.focal_35mm) {
    const fov = typicalPhoneFov(image.width, image.height);
    parts.push(`Bildwinkel unbekannt. Falls Handyfoto (Hauptkamera): bei diesem Seitenverhältnis typisch ≈ ${fov}° horizontal – ` +
      "als Startwert für fov_deg; solve_camera bestimmt ihn genau.");
  }
  if (lens) parts.push(`Rückwärts-Bildersuche im Web (Google Cloud Vision, wie Google Lens – Hinweise, keine Beweise):\n${visionSummary(lens)}`);
  if (userHints) parts.push(`Zusatzinfo des Nutzers (ernst nehmen, aber selbst prüfen):\n${userHints}`);
  if (lessons) parts.push(lessons);
  return parts.join("\n\n");
}

const PROVIDER_MODEL = { puter: "puterModel", ollama: "ollamaModel", openrouter: "openrouterModel", claude: "claudeModel", gemini: "model" };
const PROVIDER_SUFFIX = { puter: " (Puter)", ollama: " (eigener PC)", openrouter: " (OpenRouter)", claude: "", gemini: "" };
const modelName = (cfg) => (isCompat(cfg.provider) ? cfg.compatModel : cfg[PROVIDER_MODEL[cfg.provider] || "model"]);
const modelLabel = (cfg) => `${modelName(cfg)}${isCompat(cfg.provider) ? ` (${COMPAT_PROVIDERS[cfg.provider].name})` : PROVIDER_SUFFIX[cfg.provider] ?? ""}`;

/** Settings a run depends on; saved with it, so a resumed run continues with the same AI. */
const runConfig = () => ({
  provider: settings.provider, puterModel: settings.puterModel, model: settings.model, thinking: settings.thinking,
  webSearch: settings.webSearch, maxSteps: settings.maxSteps, useAI: $("#use-ai").checked,
  ollamaUrl: settings.ollamaUrl, ollamaModel: settings.ollamaModel, ollamaCtx: settings.ollamaCtx, openrouterModel: settings.openrouterModel,
  claudeModel: settings.claudeModel, hints: ($("#hints")?.value || "").trim().slice(0, 600),
  ...(isCompat(settings.provider) ? (({ model, baseUrl }) => ({ compatModel: model, compatUrl: baseUrl }))(compatSettings(settings, settings.provider)) : {}),
});

// Plain JSON copy: what AI services return may carry helper functions that IndexedDB cannot store.
const plain = (value) => JSON.parse(JSON.stringify(value));

function createAgent(cfg, common) {
  if (isCompat(cfg.provider)) {
    // Same OpenAI-style loop as Puter; the key is read now (it is not saved with the run).
    const p = COMPAT_PROVIDERS[cfg.provider];
    const { key } = compatSettings(settings, cfg.provider);
    return new PuterAgent({
      model: cfg.compatModel,
      chat: compatChat({ baseUrl: cfg.compatUrl, key, signal: common.signal, maxImages: p.maxImages || 0, keep: p.keep || [] }),
      streaming: true, describeError: describeCompatError(cfg.provider, cfg.compatModel), ...common,
    });
  }
  switch (cfg.provider) {
    case "puter":
      // When the chosen model is busy or stuck, the next ones continue (and it gets another chance later).
      return new PuterAgent({ model: cfg.puterModel, fallbackModels: PUTER_MODELS.map((m) => m.id).filter((id) => id !== cfg.puterModel).slice(0, 2), ...common });
    case "openrouter": {
      // Same OpenAI-style loop as Puter.
      const announced = new Set([cfg.openrouterModel]);
      const onModel = (used) => {
        if (announced.has(used)) return;
        announced.add(used);
        common.emit("status", { message: `${cfg.openrouterModel} ist gerade überlastet – OpenRouter hat auf ${used} ausgewichen.` });
      };
      return new PuterAgent({
        model: cfg.openrouterModel,
        chat: openRouterChat({ key: settings.openrouterKey, signal: common.signal, fallbacks: common.fallbacks, onModel }),
        // OpenRouter itself switches for overloaded models; a request that hangs switches here.
        fallbackModels: (common.fallbacks || []).slice(0, 2), describeError: describeOpenRouterError, ...common,
      });
    }
    case "ollama":
      return new OllamaAgent({ baseUrl: cfg.ollamaUrl, model: cfg.ollamaModel, numCtx: cfg.ollamaCtx, ...common });
    case "claude":
      return new ClaudeAgent({ apiKey: settings.claudeKey, model: cfg.claudeModel || CLAUDE_DEFAULT_MODEL, ...common });
    default: {
      // Google counts free requests per model and day: when one model is used up, the next one continues.
      const [model, ...fallbackModels] = geminiModels(cfg.model);
      return new GeminiAgent({
        apiKey: settings.apiKey, model, fallbackModels, onModelExhausted: markGeminiExhausted,
        thinkingLevel: cfg.thinking, webSearch: cfg.webSearch, ...common,
      });
    }
  }
}

// ---------- Gemini free tier: one daily quota per model ----------

const FREE_GEMINI = ["gemini-3.8-flash", "gemini-3.7-flash"];
const EXHAUSTED_KEY = "ortfinder.gemini.exhausted.v1";
/** Google resets the free quotas at midnight Pacific time (9:00 in Germany). */
const quotaDay = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);

function exhaustedToday() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXHAUSTED_KEY) || "{}");
    return saved.day === quotaDay() ? saved.models || [] : [];
  } catch {
    return [];
  }
}

function markGeminiExhausted(model) {
  try {
    localStorage.setItem(EXHAUSTED_KEY, JSON.stringify({ day: quotaDay(), models: [...new Set([...exhaustedToday(), model])] }));
  } catch {
    // no storage: the next analysis finds out again after one request
  }
}

/** The chosen model first, then the other free models; those used up today are skipped (unless all are). */
function geminiModels(chosen) {
  if (!FREE_GEMINI.includes(chosen)) return [chosen];
  const used = exhaustedToday();
  const order = [chosen, ...FREE_GEMINI.filter((m) => m !== chosen)];
  const left = order.filter((m) => !used.includes(m));
  return left.length ? left : [chosen];
}

/**
 * The photo with its ruler (always sent) and, for large photos, the detail tiles (first request only, see
 * compact.js) – one picture fewer per request than the former separate grid image.
 */
function firstImages(bitmap) {
  const tiles = detailTiles(bitmap);
  return [
    { type: "image", mime_type: "image/jpeg", data: rulerOverview(bitmap).data, resolution: "high" },
    ...(tiles.length ? [{ type: "text", text: TILES_MARK }] : []),
    ...tiles.flatMap((t) => [
      { type: "text", text: `Detail-Kachel ${t.name} (x ${t.box[0].toFixed(2)}–${t.box[2].toFixed(2)}, y ${t.box[1].toFixed(2)}–${t.box[3].toFixed(2)}):` },
      { type: "image", mime_type: "image/jpeg", data: t.data, resolution: "high" },
    ]),
  ];
}

/**
 * Analyse a photo. `resumed` is the saved state of an interrupted run (see resume.js): log, zooms and
 * map are restored from its events, and the AI continues after the last completed round.
 */
async function analyze(file, resumed = null) {
  if (!file) return;
  resetWorkspace();
  const controller = new AbortController();
  state.controller = controller;
  state.running = true;
  state.startedAt = resumed?.startedAt ?? Date.now();
  state.timer = setInterval(() => { $("#elapsed").textContent = `${Math.round((Date.now() - state.startedAt) / 1000)} s`; }, 1000);
  $("#cancel").hidden = false;
  $("#notify").hidden = !("Notification" in window) || Notification.permission !== "default";
  keepAwake(true);
  let ownsSavedRun = true;
  const releaseLock = holdLock(() => { ownsSavedRun = false; });
  const cfg = resumed?.config ?? runConfig();
  // Every event of a run is kept, so a run can be inspected, replayed (see runDemo) or resumed.
  const run = { started: new Date(state.startedAt).toISOString(), model: modelLabel(cfg), events: [] };
  state.run = run;
  window.ortfinderLastRun = run;
  const emit = (type, data) => {
    if (state.controller !== controller) return;
    run.events.push({ t: Math.round((Date.now() - state.startedAt) / 100) / 10, type, data });
    handle(type, data);
  };
  if (resumed) {
    for (const ev of resumed.events || []) {
      run.events.push(ev);
      state.replayT = ev.t;
      handle(ev.type, ev.data);
    }
    state.replayT = null;
    const round = resumed.agentState?.step ?? 0;
    emit("status", { message: round ? `Unterbrochene Analyse wird nach Runde ${round} fortgesetzt …` : "Unterbrochene Analyse wird neu gestartet …" });
  }

  try {
    let metadata;
    let exifLocation = null;
    if (resumed) {
      ({ metadata, exifLocation = null } = resumed);
    } else {
      emit("status", { message: "Lese Metadaten (EXIF) …" });
      metadata = await extractMetadata(await file.arrayBuffer());
      emit("metadata", metadata);
      if (metadata.gps) {
        exifLocation = { lat: metadata.gps.lat, lon: metadata.gps.lon };
        try {
          exifLocation.address = (await osm.reverse(exifLocation.lat, exifLocation.lon)).name;
        } catch (err) {
          exifLocation.address_error = err.message;
        }
        emit("exif_location", exifLocation);
      }
    }

    const bitmap = await decodeImage(file);
    state.imageSource = bitmap;
    state.lastFile = file;
    state.photoPng = photoPng(bitmap).then((blob) => {
      state.photoFile = blob ? new File([blob], "ortfinder-foto.png", { type: "image/png" }) : null;
      return blob;
    });
    state.aspect = bitmap.width / bitmap.height;
    const ov = overview(bitmap);
    $("#photo").src = ov.dataUrl;
    metadata.width ??= bitmap.width;
    metadata.height ??= bitmap.height;

    let analysis = null;
    let usage = null;
    const puter = cfg.provider === "puter";
    const ollama = cfg.provider === "ollama";
    if (cfg.useAI && cfg.provider === "gemini" && !settings.apiKey) {
      emit("warning", { message: "Für die KI-Bildanalyse mit Gemini fehlt noch der API-Key (Feld oben). Ohne Key wurden nur die GPS-/EXIF-Daten ausgewertet. Tipp: Unter ⚙ „Puter“ wählen – kostenlos und ohne Key." });
      showKeyBar(true, true);
    } else if (cfg.useAI && isCompat(cfg.provider) && (!compatSettings(settings, cfg.provider).key || !cfg.compatUrl)) {
      const name = COMPAT_PROVIDERS[cfg.provider].name;
      emit("warning", { message: `Für ${name} fehlt noch der API-Key${cfg.compatUrl ? "" : " oder die Adresse"}. Unter ⚙ eintragen – dort steht, wo du ihn bekommst. Ohne Key wurden nur die GPS-/EXIF-Daten ausgewertet.` });
      showSettings(true);
      $("#compat-key").focus();
    } else if (cfg.useAI && cfg.provider === "claude" && !settings.claudeKey) {
      emit("warning", { message: "Für Claude fehlt noch dein API-Key. Unter ⚙ eintragen – die Anleitung dort zeigt, wie du ihn bekommst. Ohne Key wurden nur die GPS-/EXIF-Daten ausgewertet." });
      showSettings(true);
      $("#claude-key").focus();
    } else if (cfg.useAI) {
      const openrouter = cfg.provider === "openrouter";
      const where = puter ? " über Puter" : ollama ? ` auf deinem PC (${cfg.ollamaUrl})` : openrouter ? " über OpenRouter" : cfg.provider === "claude" ? " (Anthropic)"
        : isCompat(cfg.provider) ? ` über ${COMPAT_PROVIDERS[cfg.provider].name}` : "";
      if (!resumed) emit("status", { message: `Bild geladen (${bitmap.width}×${bitmap.height}). Starte KI-Analyse mit ${modelName(cfg)}${where} …` });
      if (puter) await ensurePuterSignedIn(emit, controller.signal);
      let fallbacks = [];
      if (openrouter) {
        // Fallback models must exist right now, so ask OpenRouter which free ones it offers.
        fallbacks = fallbackModels(cfg.openrouterModel, state.orModelIds || (await loadOpenRouterModels()));
        await ensureOpenRouterKey(emit, controller.signal, () => ({
          version: 1, startedAt: state.startedAt, file, config: cfg, metadata: plain(metadata), exifLocation, aspect: state.aspect,
          agentState: null, counts: {}, events: plain(run.events),
        }));
      }
      const executor = new ToolExecutor({
        zoom: async (box, enhance) => zoomCrop(bitmap, box, enhance),
        mapView: (opts) => renderMapView(opts),
        renderView: (opts) => renderViewImage({ ...opts, osm, terrain, aspect: bitmap.width / bitmap.height, drapeTerrain: drapedTerrain }),
        topView: (opts) => topViewImage({ ...opts, bitmap, terrain }),
        solveCamera: (opts) => solveCameraWithTerrain({ ...opts, terrain, width: bitmap.width, height: bitmap.height }),
        skylineMatch: (opts) => runSkyline(bitmap, opts, { crop: true }),
        web: webTools,
        osm, emit,
      });
      executor.restoreCounts(resumed?.counts);
      // Saved after every round, so the analysis survives the browser pausing or reloading the page.
      const base = { version: 1, startedAt: state.startedAt, file, config: cfg, metadata: plain(metadata), exifLocation, aspect: state.aspect };
      const checkpoint = async (agentState) => {
        if (state.controller !== controller || !ownsSavedRun) return;
        await saveRun({ ...base, agentState: agentState && plain(agentState), counts: executor.counts, events: plain(run.events) });
      };
      if (!resumed?.agentState) await checkpoint(null);
      const common = { maxSteps: cfg.maxSteps, emit, signal: controller.signal, checkpoint, whenActive: () => waitWhileHidden() };
      // With the user's own Cloud Vision key: a reverse image search (like Google Lens) before the first round.
      let lens = null;
      if (settings.visionKey && !resumed?.agentState) {
        emit("status", { message: "Rückwärts-Bildersuche im Web (Google Cloud Vision) …" });
        try {
          lens = await reverseImageSearch(fetch, settings.visionKey, overview(bitmap, 1600).data);
          emit("lens", lens);
        } catch (err) {
          emit("warning", { message: `Bildersuche nicht möglich: ${err.message} Die Analyse läuft ohne sie weiter.` });
        }
      }
      const agent = createAgent(cfg, { ...common, fallbacks });
      ({ analysis, usage } = await agent.run({
        intro: buildIntro(bitmap, metadata, { userHints: cfg.hints || "", lens, lessons: currentLessons() }),
        images: resumed?.agentState ? [] : firstImages(bitmap),
        executor,
        resume: resumed?.agentState ?? null,
      }));
    }

    // The focal length in the file fixes the field of view exactly (unless the photo was cropped).
    const exifFov = horizontalFov(metadata.focal_35mm, bitmap.width, bitmap.height);
    if (exifFov) metadata.fov_deg = exifFov;
    if (exifFov && analysis?.view) analysis.view = { ...analysis.view, fov_deg: exifFov, fov_source: "exif" };
    const result = assembleResult({
      metadata, exifLocation, analysis, usage, model: modelLabel(cfg),
      seconds: Math.round((Date.now() - state.startedAt) / 100) / 10,
    });
    result.aspect = state.aspect;
    emit("result", result);
    if (state.controller === controller) announceEnd(true, `Ergebnis: ${analysis?.camera?.name || exifLocation?.address || "fertig"}`);
  } catch (err) {
    if (err.name === "AbortError") emit("error", { message: "Analyse abgebrochen." });
    else emit("error", { message: err.message || String(err) });
    if (state.controller === controller && err.name !== "AbortError") announceEnd(false, `Analyse fehlgeschlagen: ${err.message || err}`);
  } finally {
    releaseLock();
    if (state.controller === controller) {
      state.running = false;
      clearInterval(state.timer);
      $("#cancel").hidden = true;
      $("#notify").hidden = true;
      $("#progress").textContent = "";
      keepAwake(false);
      if (ownsSavedRun) clearRun();
    }
  }
}

// ---------- Puter sign-in ----------

const puterSignedIn = async (p) => Promise.resolve().then(() => p.auth.isSignedIn()).catch(() => false);

/**
 * Puter signs users in through a popup. Browsers only allow popups right after a click, so the
 * analysis pauses on a button instead of opening the popup from inside the async pipeline.
 */
async function ensurePuterSignedIn(emit, signal) {
  const p = await loadPuter();
  if (await puterSignedIn(p)) return;
  emit("status", { message: "Einmalige kostenlose Anmeldung bei Puter nötig – bitte auf „Bei Puter anmelden“ klicken." });
  const box = $("#result");
  await new Promise((resolve, reject) => {
    const button = el("button", { type: "button", class: "primary", id: "puter-signin" }, "Bei Puter anmelden (kostenlos)");
    const hint = el("p", { class: "small muted" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      hint.textContent = "Anmeldefenster ist offen …";
      try {
        await p.auth.signIn();
        resolve();
      } catch (err) {
        button.disabled = false;
        hint.textContent = describePuterError(err).message;
      }
    });
    signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Abgebrochen", "AbortError")), { once: true });
    box.replaceChildren(el("div", { class: "signin-box" },
      el("p", {}, el("strong", {}, "Ein Schritt noch: "), "Für die KI-Analyse meldest du dich einmalig kostenlos bei Puter an – mit Google, Microsoft, Apple oder E-Mail. Danach geht es automatisch weiter."),
      button, hint));
    button.scrollIntoView({ behavior: "smooth", block: "center" });
    button.focus({ preventScroll: true });
  });
  box.replaceChildren(pendingBox());
  emit("status", { message: "Bei Puter angemeldet." });
}

// ---------- recorded example (works without an API key) ----------

async function runDemo() {
  resetWorkspace();
  const controller = new AbortController();
  state.controller = controller;
  let demo;
  try {
    const resp = await fetch("demo/beispiel.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    demo = await resp.json();
  } catch (err) {
    fail(`Das Beispiel konnte nicht geladen werden (${err.message}).`);
    return;
  }
  const banner = $("#demo-banner");
  banner.hidden = false;
  banner.replaceChildren(
    el("strong", {}, "Aufgezeichnete Beispiel-Analyse: "),
    `So arbeitet Ortfinder – echter Lauf mit ${demo.model} vom ${demo.date}, im Zeitraffer abgespielt. `,
    "Foto: ", demo.credit.url ? el("a", { href: demo.credit.url, target: "_blank", rel: "noopener" }, demo.credit.text) : demo.credit.text, ". ",
    "Lade jetzt dein eigenes Foto hoch.",
  );
  const photo = $("#photo");
  photo.src = `demo/${demo.image}`;
  photo.decode().then(() => {
    if (state.controller !== controller) return;
    state.imageSource = photo;
    state.aspect = photo.naturalWidth / photo.naturalHeight;
  }).catch(() => {});
  state.startedAt = Date.now();
  // Replay in about 20 seconds, keeping the order and the original timestamps in the log.
  const total = demo.events.at(-1)?.t || 1;
  const scale = Math.min(1, 20 / total);
  for (const ev of demo.events) {
    const wait = state.startedAt + ev.t * scale * 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (state.controller !== controller || controller.signal.aborted) return;
    state.replayT = ev.t;
    handle(ev.type, ev.type === "result" ? { ...ev.data, truth: demo.truth } : ev.data);
  }
  state.replayT = null;
}

// ---------- rendering ----------

const ICONS = {
  status: "•", warning: "⚠", error: "✖", step: "▸", thinking: "💭", note: "📝", zoom: "🔍", mapview: "🛰", render: "🧊", viewshed: "👁",
  topview: "🗺", solve: "📐", skyline: "⛰", photos: "🖼", lens: "🔎",
  tool_call: "🗺", tool_result: "↳", web_search: "🌐", web_results: "↳", metadata: "🏷", exif_location: "📍", result: "✔", hypothesis: "📌",
};

function log(type, text) {
  const t = `${(state.replayT ?? (Date.now() - state.startedAt) / 1000).toFixed(1)}s`;
  const list = $("#log");
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
  list.append(el("li", { class: type }, el("span", { class: "t" }, t), el("span", {}, ICONS[type] || "•"), el("span", { class: "body" }, text)));
  if (stick) list.scrollTop = list.scrollHeight;
}

function fail(message) {
  log("error", message);
  $("#result").replaceChildren(el("p", { class: "error" }, message));
}

function handle(type, data) {
  switch (type) {
    case "status":
    case "warning":
      log(type, data.message);
      break;
    case "step":
      $("#progress").textContent = `Runde ${data.step} / ${data.max_steps}`;
      if (state.running) setTitle(`(${data.step}/${data.max_steps})`); // progress visible in the tab bar
      log("step", `Runde ${data.step}`);
      break;
    case "metadata":
      log("metadata", describeMetadata(data));
      break;
    case "exif_location":
      log("exif_location", `GPS-Koordinaten in den Metadaten: ${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}${data.address ? `\n${data.address}` : ""}`);
      addExifMarker(data);
      break;
    case "thinking":
    case "note":
      log(type, data.text);
      break;
    case "zoom":
      addZoom(data);
      log("zoom", `Zoom #${data.index}: ${data.purpose || "Detail"}`);
      break;
    case "mapview":
      addSnapshot(data, data.layer === "karte" ? "🗺 Karte" : "🛰 Luftbild");
      log("mapview", `${data.layer === "karte" ? "Kartenausschnitt" : "Luftbild"} bei ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)} (Zoom ${data.zoom})${data.purpose ? `: ${data.purpose}` : ""}`);
      break;
    case "render":
      addSnapshot(data, "🧊 3D-Nachbau");
      log("render", `3D-Nachbau bei ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}, Blick ${Math.round(data.bearing_deg)}° (${compass(data.bearing_deg)})${data.purpose ? `: ${data.purpose}` : ""}`);
      break;
    case "topview":
      addSnapshot(data, "🗺 Draufsicht");
      log("topview", `Draufsicht: Foto auf das Gelände geklappt, Blick ${Math.round(data.bearing_deg)}° (${compass(data.bearing_deg)}), ` +
        `mit dem Luftbild verglichen${data.purpose ? `: ${data.purpose}` : ""}`);
      break;
    case "photos":
      if (data.thumbnail) addSnapshot(data, "🖼 Fotos anderer");
      log("photos", `${data.count} Fotos anderer im Umkreis von ${data.radius_m} m zum Vergleich geholt${data.purpose ? `: ${data.purpose}` : ""}`);
      break;
    case "lens":
      log("lens", `Bildersuche im Web: ${[
        data.landmarks.length ? `Wahrzeichen ${data.landmarks.map((l) => l.name).join(", ")}` : "",
        data.labels.length ? `Vermutung „${data.labels.join(", ")}“` : "",
        data.pages.length ? `${data.pages.length} Seiten mit demselben Bild` : "",
      ].filter(Boolean).join(" · ") || "keine Treffer"}`);
      for (const l of data.landmarks) {
        if (l.lat != null && state.hypoLayer) {
          L.circleMarker([l.lat, l.lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#e8590c", fillOpacity: 1 })
            .bindTooltip(`🔎 Bildersuche: ${escapeHtml(l.name)}`).addTo(state.hypoLayer);
        }
      }
      break;
    case "skyline":
      addSnapshot(data, "⛰ Bergkamm");
      log("skyline", `Bergkamm-Abgleich: Blick ${fmt1(data.bearing_deg)}° (${compass(data.bearing_deg)}), Bildwinkel ${fmt1(data.fov_deg)}°, ` +
        `Zuordnung ${Math.round(data.confidence * 100)} % sicher${data.peaks.length ? ` – erkannt: ${data.peaks.join(", ")}` : ""}`);
      break;
    case "solve":
      log("solve", `Rückwärtsschnitt aus ${data.points} Punkten: Blick ${data.bearing_deg}° (${compass(data.bearing_deg)}), Bildwinkel ${data.fov_deg}°, ` +
        `mittlere Abweichung ${String(data.rms_pct).replace(".", ",")} % der Bildbreite`);
      if (state.hypoLayer) {
        L.circleMarker([data.lat, data.lon], { radius: 5, color: "#fff", weight: 2, fillColor: "#0b6bcb", fillOpacity: 1 })
          .bindTooltip(`📐 Standpunkt laut Rückwärtsschnitt (${data.points} Punkte)`).addTo(state.hypoLayer);
      }
      break;
    case "tool_call":
      if (!QUIET_TOOLS.has(data.tool)) log("tool_call", `${toolLabel(data.tool)}: ${toolInput(data)}`);
      break;
    case "tool_result":
      if (!QUIET_TOOLS.has(data.tool) || data.is_error) log(data.is_error ? "warning" : "tool_result", data.preview);
      break;
    case "hypothesis":
      drawHypothesis(data);
      log("hypothesis", `Zwischenstand: ${data.label} (±${formatKm(data.radius_km)})`);
      break;
    case "web_search":
      log("web_search", `Google-Suche: ${data.query}`);
      break;
    case "web_results":
      log("web_results", data.error || `${data.count} Suchergebnis(se) erhalten`);
      break;
    case "result":
      renderResult(data);
      log("result", `Fertig nach ${data.seconds} s`);
      break;
    case "error":
      fail(data.message);
      break;
  }
}

// Tools whose effect is shown elsewhere (zoom gallery, map) instead of as log lines.
const QUIET_TOOLS = new Set(["zoom_image", "mark_hypothesis", "map_view", "render_view", "top_view", "solve_camera", "skyline_match", "photos_nearby"]);

function toolLabel(name) {
  return {
    geocode: "Ortssuche", reverse_geocode: "Adresse zu Koordinaten", overpass_query: "OSM-Abfrage", sun_position: "Sonnenstand",
    bearing_distance: "Richtung/Entfernung", destination_point: "Punkt berechnen",
    nearby_features: "Umgebung prüfen", street_geometry: "Straßenverlauf", wiki_search: "Wikipedia-Suche",
  }[name] || name;
}

function toolInput({ tool, input }) {
  if (tool === "geocode") return `„${input.query}“${input.country_codes ? ` (${input.country_codes})` : ""}`;
  if (tool === "reverse_geocode") return `${input.lat}, ${input.lon}`;
  if (tool === "overpass_query") return `${input.purpose || ""}\n${input.query}`;
  if (tool === "sun_position") return `${input.lat}, ${input.lon} @ ${input.datetime_utc}`;
  if (tool === "nearby_features") return `${input.lat}, ${input.lon} (±${input.radius_m ?? 150} m)`;
  if (tool === "street_geometry") return `„${input.name}“ bei ${input.lat}, ${input.lon}`;
  if (tool === "wiki_search") return `„${input.query}“${input.languages ? ` (${input.languages})` : ""}`;
  return JSON.stringify(input);
}

function describeMetadata(m) {
  if (!m.has_exif) return "Keine EXIF-Metadaten (z.B. durch Messenger oder Screenshot entfernt).";
  const parts = [];
  const cam = [m.camera_make, m.camera_model].filter(Boolean).join(" ");
  if (cam) parts.push(cam);
  if (m.taken_at) parts.push(`aufgenommen ${m.taken_at}${m.utc_offset ? ` (${m.utc_offset})` : ""}`);
  parts.push(m.gps ? "GPS vorhanden" : "kein GPS");
  return "EXIF: " + parts.join(" · ");
}

function addBox(box, cls, label) {
  const [x0, y0, x1, y1] = box;
  const node = el("div", {
    class: `box ${cls}`,
    style: `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%`,
  }, label ? el("span", { class: "tag" }, label) : null);
  $("#overlay").append(node);
  return node;
}

function addZoom(z) {
  state.zoomCount += 1;
  if (state.zoomCount === 1) $("#zooms").replaceChildren();
  $("#zoom-count").textContent = `(${state.zoomCount})`;
  addBox(z.box, "zoom", null);
  $("#zooms").append(el("figure", {}, el("img", { src: z.thumbnail, alt: z.purpose || "Ausschnitt", title: z.purpose }), el("figcaption", {}, z.purpose)));
}

/** Aerial view or 3D reconstruction the AI compared with the photo: shown next to the zooms, marked on the map. */
function addSnapshot(v, kind) {
  state.zoomCount += 1;
  if (state.zoomCount === 1) $("#zooms").replaceChildren();
  $("#zoom-count").textContent = `(${state.zoomCount})`;
  $("#zooms").append(el("figure", { class: v.bearing_deg != null ? "mapview render" : "mapview" },
    el("img", { src: v.thumbnail, alt: `${kind}: ${v.purpose || ""}`, title: v.purpose }),
    el("figcaption", {}, `${kind}${v.purpose ? `: ${v.purpose}` : ""}`)));
  if (state.hypoLayer) {
    L.circleMarker([v.lat, v.lon], { radius: 4, color: "#7a4cc2", weight: 1, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip(`${kind} geprüft`).addTo(state.hypoLayer);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setOsmLink(lat, lon) {
  const a = $("#osm-link");
  a.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
  a.hidden = false;
}

const COMPASS = ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

const pin = (symbol, cls, title) => L.divIcon({ className: `pin ${cls}`, html: `<span title="${escapeHtml(title)}">${symbol}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] });

function addExifMarker(loc) {
  if (!state.layer) return;
  L.marker([loc.lat, loc.lon], { icon: pin("📷", "pin-exif", "GPS aus Metadaten"), zIndexOffset: 900 })
    .bindPopup(`<b>Standpunkt laut GPS (Metadaten)</b><br>${escapeHtml(loc.address || "")}`)
    .addTo(state.layer);
  state.map.flyTo([loc.lat, loc.lon], 16, { duration: 1.5 });
  setOsmLink(loc.lat, loc.lon);
}

function formatKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
}

/** Interim estimate while the AI is still searching: dashed area, faded pins, map follows. */
function drawHypothesis(h) {
  if (!state.hypoLayer) return;
  state.hypoLayer.clearLayers();
  const area = L.circle([h.camera.lat, h.camera.lon], { radius: h.radius_km * 1000, color: "#7a4cc2", weight: 2, dashArray: "6 6", fillOpacity: 0.06 }).addTo(state.hypoLayer);
  L.marker([h.camera.lat, h.camera.lon], { icon: pin("📷", "pin-hypo", "Zwischenstand") }).bindTooltip(h.label, { direction: "top", offset: [0, -14] }).addTo(state.hypoLayer);
  if (h.subject) {
    L.marker([h.subject.lat, h.subject.lon], { icon: pin("🎯", "pin-hypo", "Motiv (Zwischenstand)") }).addTo(state.hypoLayer);
    L.polyline([[h.camera.lat, h.camera.lon], [h.subject.lat, h.subject.lon]], { color: "#7a4cc2", weight: 2, dashArray: "4 6" }).addTo(state.hypoLayer);
  }
  state.map.flyToBounds(area.getBounds().pad(0.3), { duration: 1.4, maxZoom: 17 });
}

/** Final answer: standpoint, motif, view cone, uncertainty area and alternatives. */
function drawResultMap(a) {
  state.hypoLayer.clearLayers();
  const cam = a.camera;
  const focus = L.featureGroup().addTo(state.layer);
  for (const c of a.candidates.slice().reverse()) {
    L.circle([c.lat, c.lon], { radius: c.radius_km * 1000, color: "#8a94a3", weight: 1, fillOpacity: 0.04 }).addTo(state.layer);
    L.circleMarker([c.lat, c.lon], { radius: 5, color: "#fff", weight: 2, fillColor: "#8a94a3", fillOpacity: 1 })
      .bindPopup(`<b>Alternative:</b> ${escapeHtml(c.name)}<br>${Math.round(c.confidence * 100)} %`).addTo(state.layer);
  }
  // Uncertainty of the standpoint only; what the camera sees is drawn exactly (see showVisibleArea).
  L.circle([cam.lat, cam.lon], { radius: Math.max(cam.radius_km, 0.005) * 1000, color: "#0b6bcb", weight: 1.5, dashArray: "4 4", fillOpacity: 0.06 })
    .bindTooltip(`Unsicherheit des Standpunkts ±${formatKm(cam.radius_km)}`).addTo(focus);
  if (a.view) {
    // Provisional wedge until the exact visible area is computed.
    const coneKm = Math.min(Math.max(a.view.distance_m / 1000, 0.05), 50);
    state.coneLayer = L.polygon(viewCone(cam.lat, cam.lon, a.view.bearing_deg, a.view.fov_deg, coneKm), { color: "#e8590c", weight: 1, dashArray: "3 5", fillColor: "#ff922b", fillOpacity: 0.12 })
      .bindTooltip(`Sichtfeld (vorläufig): ${Math.round(a.view.bearing_deg)}° (${compass(a.view.bearing_deg)}), ${a.view.fov_deg}°`).addTo(focus);
  }
  if (a.subject) {
    if (a.subject.radius_km > 0.02) L.circle([a.subject.lat, a.subject.lon], { radius: a.subject.radius_km * 1000, color: "#e8590c", weight: 1, fillOpacity: 0.08 }).addTo(focus);
    L.polyline([[cam.lat, cam.lon], [a.subject.lat, a.subject.lon]], { color: "#e8590c", weight: 2 }).addTo(focus);
    L.marker([a.subject.lat, a.subject.lon], { icon: pin("🎯", "pin-subject", "Motiv"), zIndexOffset: 800 })
      .bindPopup(`<b>Motiv:</b> ${escapeHtml(a.subject.name)}`).addTo(focus);
  }
  L.marker([cam.lat, cam.lon], { icon: pin("📷", "pin-camera", "Standpunkt"), zIndexOffset: 1000 })
    .bindPopup(`<b>Standpunkt:</b> ${escapeHtml(cam.name)}<br>${Math.round(cam.confidence * 100)} % · ±${formatKm(cam.radius_km)}`).addTo(focus);
  // Fly in from wherever the map is (world view or last interim estimate).
  state.map.flyToBounds(focus.getBounds().pad(0.35), { duration: 2.2, maxZoom: 18 });
}

function setBaseLayer(name) {
  if (!state.map || !state.bases) return;
  const [on, off] = name === "aerial" ? [state.bases.aerial, state.bases.street] : [state.bases.street, state.bases.aerial];
  if (state.map.hasLayer(off)) state.map.removeLayer(off);
  if (!state.map.hasLayer(on)) on.addTo(state.map);
}

/** The best-known camera: EXIF GPS/compass/focal length where present, else the AI's estimate. */
function bestView(r) {
  const a = r.analysis;
  const m = r.metadata || {};
  const cam = r.exif_location || a?.camera;
  const bearing = m.direction_deg ?? a?.view?.bearing_deg;
  if (!cam || bearing == null) return null;
  return {
    lat: cam.lat,
    lon: cam.lon,
    bearingDeg: bearing,
    fovDeg: m.fov_deg ?? a?.view?.fov_deg ?? 65,
    pitchDeg: a?.view?.pitch_deg ?? 0,
    rollDeg: a?.view?.roll_deg ?? 0,
    eyeHeight: a?.view?.eye_height_m ?? 1.6,
    distanceM: a?.view?.distance_m ?? 300,
    aspect: r.aspect || state.aspect || 4 / 3,
    sources: {
      position: r.exif_location ? "GPS (EXIF)" : "Bildanalyse",
      bearing: m.direction_deg != null ? "Kompass (EXIF)" : "Bildanalyse",
      fov: m.fov_deg != null ? "Brennweite (EXIF)" : "Schätzung",
    },
  };
}

/** Internet lookups for the AI (keyless): photos of others near a point, Wikipedia. */
const webTools = {
  photosNearby: async (lat, lon, radiusM) => {
    const res = await photosNearby(fetch, lat, lon, radiusM);
    if (res.items.length) res.sheet = await contactSheet(res.items, loadTileImage);
    return res;
  },
  wikiSearch: (query, langs) => wikiSearch(fetch, query, languages(langs)),
};

/** The photo as PNG (≤1600 px) for pasting into Google Lens & Co.; prepared right after loading. */
function photoPng(bitmap, maxSide = 1600) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bitmap.width * scale);
  c.height = Math.round(bitmap.height * scale);
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), "image/png"));
}

const LENS_SITES = {
  google: { name: "Google Lens", url: "https://lens.google.com/" },
  bing: { name: "Bing", url: "https://www.bing.com/visualsearch" },
  yandex: { name: "Yandex", url: "https://yandex.com/images/" },
};

/**
 * Reverse image search by hand (Google Lens has no free interface for websites): on phones the share
 * sheet (choose Google Lens / the Google app), elsewhere the photo goes to the clipboard and the site opens.
 */
function searchImageOn(site) {
  const hint = $("#lens-hint");
  const target = LENS_SITES[site];
  if (!state.photoPng) {
    hint.textContent = "Erst ein Foto laden.";
    return;
  }
  const after = " Was du findest (Ort, Name, Seite), oben unter „Zusatzinfo für die KI“ eintragen und neu analysieren.";
  const blobPromise = state.photoPng;
  if (matchMedia("(pointer: coarse)").matches && state.photoFile && navigator.canShare?.({ files: [state.photoFile] })) {
    navigator.share({ files: [state.photoFile], title: "Foto" }).catch(() => {});
    hint.textContent = `Im Teilen-Menü „Google Lens“ (bzw. die Google-App) wählen.${after}`;
    return;
  }
  // The clipboard write starts inside the click, so the browser allows it; the promise fills it.
  let copied = true;
  try {
    navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]).catch(() => { copied = false; });
  } catch {
    copied = false;
  }
  window.open(target.url, "_blank", "noopener");
  hint.textContent = copied
    ? `Foto ist in der Zwischenablage – bei ${target.name} Strg+V (Mac: ⌘V) drücken.${after}`
    : `Bei ${target.name} das Foto hochladen (Kamera-Symbol).${after}`;
}

/**
 * Mountain-skyline match in the browser (see skyline.js). The latest match is kept for the result view.
 * Returns { match, image } – image cropped to the skyline band for the AI, or the whole photo.
 */
async function runSkyline(bitmap, opts, { crop = false } = {}) {
  const match = await skylineMatch({
    ...opts, bitmap, terrain, osm,
    onStatus: (text) => { if (state.running) $("#progress").textContent = text; },
  });
  if (!match.ok) return { match, image: null };
  state.skyline = { match, bitmap };
  return { match, image: skylineImage(bitmap, match, { crop, maxWidth: crop ? 1200 : 1000 }) };
}

const fmt1 = (v) => (Math.round(v * 10) / 10).toString().replace(".", ",");

/** Result view: the photo labelled like PeakFinder, the peaks as a table and as lines on the map. */
function showSkyline(slot, match, bitmap) {
  const img = skylineImage(bitmap, match, { maxWidth: 1000 });
  const p = match.pose;
  const sd = match.sd || {};
  const pm = (k) => (sd[k] != null ? ` ±${fmt1(sd[k])}` : "");
  const named = match.peaks.filter((q) => q.name);
  const rows = [...named, ...match.peaks.filter((q) => !q.name)].slice(0, 30).sort((a, b) => a.x - b.x);
  const peakGroup = L.featureGroup();
  const cam = [match.camera.lat, match.camera.lon];
  for (const q of named) {
    L.polyline([cam, [q.lat, q.lon]], { color: "#7a4cc2", weight: 1, opacity: 0.7, dashArray: "4 4", interactive: false }).addTo(peakGroup);
    L.circleMarker([q.lat, q.lon], { radius: 4, color: "#fff", weight: 1, fillColor: "#7a4cc2", fillOpacity: 1 })
      .bindTooltip(`⛰ ${peakLabel(q)} · ${Math.round(q.bearing_deg)}°`).addTo(peakGroup);
  }
  const onMap = el("input", { type: "checkbox" });
  onMap.addEventListener("change", () => {
    if (onMap.checked) {
      state.layer.addLayer(peakGroup);
      state.map.flyToBounds(peakGroup.getBounds().extend(cam).pad(0.1), { duration: 1 });
    } else {
      state.layer.removeLayer(peakGroup);
    }
  });
  const conf = Math.round(match.confidence * 100);
  slot.replaceChildren(
    el("p", { class: "label" }, "⛰ Gipfel & Bergkamm"),
    el("a", { href: img.dataUrl, target: "_blank", rel: "noopener" }, el("img", { src: img.dataUrl, alt: "Foto mit beschrifteten Gipfeln und Geländehorizont", class: "topview-img" })),
    el("p", { class: "small" },
      `Blick ${fmt1(p.bearing)}°${pm("bearing")} · Neigung ${fmt1(p.pitch)}°${pm("pitch")} · Schieflage ${fmt1(p.roll)}°${pm("roll")} · ` +
      `Bildwinkel ${fmt1(p.fov)}°${pm("fov")} · ${Math.round(match.fit.inlier_share * 100)} % der Himmelslinie auf dem Geländehorizont · ` +
      `Zuordnung der Berge: ${conf} % sicher.`),
    rows.length ? el("table", { class: "peaks" },
      el("thead", {}, el("tr", {}, el("th", {}, "Gipfel"), el("th", {}, "Höhe"), el("th", {}, "Entfernung"), el("th", {}, "Richtung"))),
      el("tbody", {}, rows.map((q) => el("tr", { class: q.on_skyline ? "on-skyline" : "" },
        el("td", {}, q.name || "Gipfel ohne Namen"),
        el("td", {}, `${q.ele_m.toLocaleString("de-DE")} m${q.ele_from_dem ? " *" : ""}`),
        el("td", {}, `${(q.distance_m / 1000).toFixed(1).replace(".", ",")} km`),
        el("td", {}, `${Math.round(q.bearing_deg)}° ${compass(q.bearing_deg)}`))))) : el("p", { class: "small muted" }, "Keine Gipfel im Bild gefunden."),
    named.length ? el("label", { class: "check small" }, onMap, " Linien zu den Gipfeln auf der Karte") : null,
    el("p", { class: "small muted" },
      "Rot = Horizont aus dem Geländemodell vom Standpunkt aus (mit Erdkrümmung), weiß = weitere Kämme davor. Liegt Rot auf der " +
      `Himmelslinie des Fotos, stimmen Blickrichtung und Standpunktgebiet. Gipfelnamen: ${match.peakSource || "–"}; * = Höhe aus dem ` +
      "Geländemodell. Das freie Geländemodell weicht an steilen Graten teils 20–100 m ab – nahe Kämme passen deshalb nicht immer pixelgenau."),
  );
}

/** Offer the peak labels for any result with a view: runs the match on demand (it loads terrain far out). */
function skylineButton(slot, v) {
  if (!state.imageSource || !v) {
    slot.remove();
    return;
  }
  let sky;
  try {
    sky = photoSkyline(state.imageSource);
  } catch {
    slot.remove();
    return;
  }
  if (sky.count < 0.3 * sky.width) {
    slot.remove(); // hardly any sky/land line in the photo
    return;
  }
  const token = state.resultToken;
  const button = el("button", { type: "button", class: "ghost small-btn" }, "⛰ Gipfel beschriften (Bergkamm-Abgleich)");
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Bergkamm wird abgeglichen … (lädt Gelände bis 200 km)";
    try {
      const { match } = await runSkyline(state.imageSource, {
        lat: v.lat, lon: v.lon, eyeHeight: v.eyeHeight, bearingDeg: v.bearingDeg, bearingRange: 20,
        fovDeg: v.fovDeg, fixFov: v.sources.fov === "Brennweite (EXIF)",
      });
      if (token !== state.resultToken) return;
      if (!match.ok) slot.replaceChildren(el("p", { class: "small muted" }, `⛰ ${match.note}`));
      else showSkyline(slot, match, state.imageSource);
    } catch (err) {
      button.textContent = `Bergkamm-Abgleich nicht möglich (${err.message})`;
    }
  });
  slot.replaceChildren(button);
}

/**
 * Exact visible area on the map (buildings and terrain block the view, the picture frame bounds it)
 * and a 3D reconstruction from the final standpoint to lay over the photo.
 */
async function refineView(r) {
  const v = bestView(r);
  if (!v || !state.layer) return;
  const token = state.resultToken;
  const current = () => token === state.resultToken;
  const maxDistM = Math.min(Math.max(v.distanceM * 2.5, 250), 40000);
  log("viewshed", "Berechne den exakten Sichtbereich aus 3D-Gebäuden und Geländemodell …");
  try {
    const area = await visibleAreaFor({ osm, terrain, ...v, maxDistM });
    if (!current()) return;
    showVisibleArea(area, v);
    const s = area.stats;
    log("viewshed", `Sichtbereich berechnet: ${s.rays} Sichtstrahlen, ${s.buildings} Gebäude${s.terrain ? ", Geländemodell" : ""}` +
      `${area.sceneMissing ? " (Gebäudedaten nicht erreichbar)" : ""} – sichtbar ab ${s.nearest_m ?? "?"} m bis ${formatKm(s.farthest_m / 1000)}.`);
  } catch (err) {
    if (current()) log("warning", `Sichtbereich konnte nicht berechnet werden (${err.message}) – gezeigt wird das vorläufige Sichtfeld.`);
  }
  const slot = $("#compare-slot");
  if (!slot) return;
  try {
    const render = await renderViewImage({ osm, terrain, ...v, width: 900 });
    if (!current()) return;
    showComparison(slot, render, v);
  } catch (err) {
    if (current()) slot.replaceChildren(el("p", { class: "small muted" }, `3D-Nachbau nicht möglich (${err.message}).`));
  }
  // The photo folded down onto the terrain, next to the aerial image and on the map.
  const topSlot = $("#topview-slot");
  if (!topSlot) return;
  if (!state.imageSource) {
    topSlot.remove(); // no photo pixels (e.g. a replay whose picture is not decoded)
    return;
  }
  try {
    const tv = await topViewImage({
      bitmap: state.imageSource, terrain, ...v,
      minDistM: Math.max(8, v.eyeHeight * 2.5), maxDistM: Math.min(Math.max(v.distanceM * 2.5, 300), 3000),
    });
    if (!current()) return;
    showTopView(topSlot, tv, v);
  } catch (err) {
    if (current()) topSlot.replaceChildren(el("p", { class: "small muted" }, `Draufsicht nicht möglich (${err.message}).`));
  }
}

/**
 * The photo as a 3D model (model3d.js, three.js loaded on demand): terrain and buildings with the photo
 * projected on from the camera, aerial image elsewhere; views as the photo, oblique, from above, and the
 * flight from side view to top view.
 */
function modelSlot(slot, v) {
  if (!state.imageSource || !v) {
    slot.remove();
    return;
  }
  const token = state.resultToken;
  const open = el("button", { type: "button", class: "ghost small-btn" }, "🧊 Foto als 3D-Modell ansehen (Seitenansicht → Draufsicht)");
  open.addEventListener("click", async () => {
    open.disabled = true;
    const status = el("p", { class: "small muted" }, "3D-Modell wird gebaut …");
    slot.replaceChildren(el("p", { class: "label" }, "🧊 Foto als 3D-Modell"), status);
    try {
      const { buildPhotoModel, openModelViewer } = await import("./model3d.js");
      const model = await buildPhotoModel({
        bitmap: state.imageSource, terrain, osm, onStatus: (t) => { status.textContent = t; },
        pose: { lat: v.lat, lon: v.lon, bearingDeg: v.bearingDeg, fovDeg: v.fovDeg, pitchDeg: v.pitchDeg, rollDeg: v.rollDeg, eyeHeight: v.eyeHeight },
      });
      if (token !== state.resultToken) return;
      const box = el("div", { class: "model3d" });
      slot.append(box);
      const viewer = await openModelViewer(box, model);
      state.viewer?.dispose();
      state.viewer = viewer;
      const button = (label, fn) => {
        const b = el("button", { type: "button", class: "ghost small-btn" }, label);
        b.addEventListener("click", fn);
        return b;
      };
      const opacity = el("input", { type: "range", min: "0", max: "100", value: "100", "aria-label": "Foto-Überzug" });
      opacity.addEventListener("input", () => { viewer.photoOpacity = opacity.value / 100; });
      const houses = el("input", { type: "checkbox", checked: true });
      houses.addEventListener("change", () => { viewer.buildings = houses.checked; });
      const aerial = el("input", { type: "checkbox", checked: true });
      aerial.addEventListener("change", () => { viewer.aerial = aerial.checked; });
      const s = viewer.stats;
      status.textContent = `Gelände bis ${formatKm(s.radius_m / 1000)} rund um den Standpunkt, ${s.buildings} Gebäude aus OSM, Luftbild von Esri. ` +
        "Ziehen = drehen, zwei Finger/Mausrad = zoomen, Rechtsklick/zwei Finger ziehen = verschieben.";
      slot.append(
        el("div", { class: "compare-slider wrap" },
          button("▶ Seitenansicht → Draufsicht", () => viewer.fly("photo", "top")),
          button("📷 Wie das Foto", () => viewer.show("photo")),
          button("↗ Schräg", () => viewer.show("oblique")),
          button("⬇ Draufsicht", () => viewer.show("top"))),
        el("div", { class: "compare-slider wrap" },
          el("span", { class: "small" }, "Luftbild"), opacity, el("span", { class: "small" }, "Foto"),
          el("label", { class: "check small" }, houses, " Gebäude"),
          el("label", { class: "check small" }, aerial, " Luftbild")),
        el("p", { class: "small muted" },
          "Das Foto ist vom Standpunkt aus auf Gelände und Gebäude projiziert – überall, wo die Kamera hinsah; der Rest zeigt das Luftbild. " +
          "Von oben ist das die Draufsicht. Liegen Wege, Felder und Dächer des Fotos auf denen des Luftbilds (Regler hin und her schieben), " +
          "stimmen Standpunkt und Blick; rutschen sie weg, ist die Pose daneben. Gebäude sind einfache Klötze, das Gelände ein Modell – " +
          "Hauswände und Bäume werden deshalb verzerrt dargestellt."),
      );
      viewer.fly("photo", "top");
    } catch (err) {
      if (token === state.resultToken) slot.replaceChildren(el("p", { class: "small muted" }, `3D-Modell nicht möglich (${err.message}).`));
    }
  });
  slot.replaceChildren(open);
}

/** The skyline section: the AI's latest mountain match, or a button to run one for this result. */
function refineSkyline(r) {
  const mslot = $("#model-slot");
  if (mslot) modelSlot(mslot, bestView(r));
  const slot = $("#skyline-slot");
  if (!slot) return;
  if (state.skyline?.match?.ok) showSkyline(slot, state.skyline.match, state.skyline.bitmap);
  else skylineButton(slot, bestView(r));
}

/** Photo laid flat onto the map (Leaflet image overlay) plus the side-by-side comparison with the aerial image. */
function showTopView(slot, tv, v) {
  if (tv.empty) {
    slot.replaceChildren(el("p", { class: "small muted" }, `🗺 Draufsicht: ${tv.note}`));
    return;
  }
  const b = tv.overlay.bounds;
  if (state.topLayer) state.layer.removeLayer(state.topLayer);
  state.topLayer = L.imageOverlay(tv.overlay.url, [[b.south, b.west], [b.north, b.east]], { opacity: 0.75, interactive: false }).addTo(state.layer);
  setBaseLayer("aerial");
  const show = el("input", { type: "checkbox", checked: true, id: "topview-toggle" });
  const opacity = el("input", { type: "range", min: "0", max: "100", value: "75", "aria-label": "Deckkraft der Draufsicht" });
  // Through the group: a layer removed only from the map would stay in the group and never come back.
  show.addEventListener("change", () => (show.checked ? state.layer.addLayer(state.topLayer) : state.layer.removeLayer(state.topLayer)));
  opacity.addEventListener("input", () => state.topLayer.setOpacity(opacity.value / 100));
  const s = tv.stats;
  slot.replaceChildren(
    el("p", { class: "label" }, "🗺 Foto als Draufsicht ↔ Luftbild"),
    el("a", { href: tv.dataUrl, target: "_blank", rel: "noopener" }, el("img", { src: tv.dataUrl, alt: "Foto als Draufsicht neben dem Luftbild", class: "topview-img" })),
    el("div", { class: "compare-slider" },
      el("label", { class: "check small" }, show, " auf der Karte"),
      el("span", { class: "small" }, "Deckkraft"), opacity),
    el("p", { class: "small muted" },
      `Jeder Bildpunkt als Sichtstrahl auf das Gelände projiziert (Blick ${Math.round(v.bearingDeg)}°, Neigung ${v.pitchDeg}°, Bildwinkel ${Math.round(v.fovDeg)}°, ` +
      `Kamerahöhe ${v.eyeHeight} m über dem Geländemodell): Boden von ${s.nearest_m} bis ${s.farthest_m} m, Raster ${s.grid_m} m. Liegen Wege, Feldgrenzen und Gebäudefüße ` +
      "auf denen im Luftbild, stimmt die Kamerapose. Dächer, Bäume und Masten erscheinen nach hinten verlängert, weil sie über dem Boden liegen."),
  );
}

function showVisibleArea(area, v) {
  if (!area.polygons.length) return;
  state.coneLayer?.remove();
  const group = L.featureGroup().addTo(state.layer);
  const tip = `Sichtbereich: was die Kamera sieht (Blick ${Math.round(v.bearingDeg)}° ${compass(v.bearingDeg)}, Bildwinkel ${Math.round(v.fovDeg)}°) – verdeckt durch Gebäude und Gelände ausgespart`;
  for (const poly of area.polygons) {
    L.polygon(poly, { color: "#e8590c", weight: 1, fillColor: "#ff922b", fillOpacity: 0.38 }).bindTooltip(tip).addTo(group);
  }
  for (const line of area.facades) {
    L.polyline(line, { color: "#c92a2a", weight: 4, opacity: 0.9 }).bindTooltip("Sichtbare Fassade").addTo(group);
  }
  // Precise results are best judged on the aerial image.
  if (area.stats.farthest_m < 3000) setBaseLayer("aerial");
  const bounds = group.getBounds().extend([v.lat, v.lon]);
  state.map.flyToBounds(bounds.pad(0.25), { duration: 1.2, maxZoom: 19 });
}

function showComparison(slot, render, v) {
  const photo = $("#photo").src;
  const overlay = el("img", { src: render.dataUrl, alt: "3D-Nachbau", class: "compare-render", style: "opacity:0.5" });
  const slider = el("input", { type: "range", min: "0", max: "100", value: "50", "aria-label": "Überblendung Foto / 3D-Nachbau" });
  slider.addEventListener("input", () => { overlay.style.opacity = String(slider.value / 100); });
  const s = render.stats;
  // The same view with the aerial image laid over the terrain (Google-Earth-like), rendered on demand.
  const drapeButton = el("button", { type: "button", class: "ghost small-btn" }, "🛰 Luftbild-3D");
  drapeButton.addEventListener("click", async () => {
    drapeButton.disabled = true;
    drapeButton.textContent = "Luftbild wird über das Gelände gelegt …";
    try {
      const draped = await renderViewImage({ osm, terrain, ...v, width: 900, texture: "satellit", drapeTerrain: drapedTerrain });
      overlay.src = draped.dataUrl;
      drapeButton.textContent = draped.stats.texture === "satellit" ? "🛰 Luftbild-3D aktiv" : "Luftbild nicht verfügbar";
    } catch (err) {
      drapeButton.textContent = `Luftbild-3D nicht möglich (${err.message})`;
    }
  });
  slot.replaceChildren(
    el("p", { class: "label" }, "🧊 Foto ↔ 3D-Nachbau vom Standpunkt"),
    el("div", { class: "compare", style: `aspect-ratio:${render.width}/${render.height}` }, el("img", { src: photo, alt: "Foto" }), overlay),
    el("div", { class: "compare-slider" }, el("span", { class: "small" }, "Foto"), slider, el("span", { class: "small" }, "3D"), drapeButton),
    el("p", { class: "small muted" },
      `Nachbau aus ${s.buildings} OSM-Gebäuden${s.terrain ? " und dem Geländemodell" : ""}. Standpunkt: ${v.sources.position}, ` +
      `Blickrichtung: ${v.sources.bearing}, Bildwinkel ${Math.round(v.fovDeg)}°: ${v.sources.fov}. ` +
      "Decken sich Gebäudekanten, Straßenflucht und Horizont, stimmt der Standpunkt auf wenige Meter."),
  );
}

function clueCrop(source, box) {
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  const padX = Math.max((box[2] - box[0]) * 0.2, 0.015);
  const padY = Math.max((box[3] - box[1]) * 0.2, 0.015);
  const x0 = Math.max(0, box[0] - padX) * w;
  const y0 = Math.max(0, box[1] - padY) * h;
  const sw = Math.max(8, (Math.min(1, box[2] + padX) * w) - x0);
  const sh = Math.max(8, (Math.min(1, box[3] + padY) * h) - y0);
  const scale = 360 / Math.max(sw, sh);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, x0, y0, sw, sh, 0, 0, c.width, c.height);
  // Mark the clue itself inside the (slightly larger) crop.
  ctx.strokeStyle = "#ff4d6d";
  ctx.lineWidth = 3;
  ctx.strokeRect((box[0] * w - x0) * scale, (box[1] * h - y0) * scale, (box[2] - box[0]) * w * scale, (box[3] - box[1]) * h * scale);
  return c.toDataURL("image/jpeg", 0.85);
}

const CATEGORY_LABELS = {
  text: "Text", sprache: "Sprache", verkehrszeichen: "Verkehrszeichen", schild: "Schild", strasse: "Straße", kennzeichen: "Kennzeichen",
  fahrzeug: "Fahrzeug", architektur: "Architektur", infrastruktur: "Infrastruktur", menschen: "Menschen", gegenstand: "Gegenstand",
  marke: "Marke/Logo", vegetation: "Pflanzen", tiere: "Tiere", landschaft: "Landschaft", klima: "Klima", sonne: "Sonne/Schatten",
  innenraum: "Innenraum", wahrzeichen: "Wahrzeichen", kultur: "Kultur", symbol: "Symbol", sonstiges: "Sonstiges",
};

/** One card per clue: crop from the photo, category, what it shows and what it implies. */
function renderClueGallery(clues) {
  const gallery = $("#clue-gallery");
  const overlay = $("#overlay");
  gallery.replaceChildren();
  if (!clues.length) return;
  $("#clues-card").hidden = false;
  $("#clue-count").textContent = `${clues.length} Hinweise`;
  clues.forEach((c, i) => {
    const node = c.box.length === 4 ? addBox(c.box, `clue ${c.strength}`, String(i + 1)) : null;
    let img = null;
    if (node && state.imageSource) {
      try {
        img = el("img", { src: clueCrop(state.imageSource, c.box), alt: c.description });
      } catch {
        img = null;
      }
    }
    gallery.append(el("article", {
      class: `clue-card ${c.strength}`,
      onmouseenter: () => { if (node) { overlay.classList.add("focus"); node.classList.add("active"); } },
      onmouseleave: () => { if (node) { overlay.classList.remove("focus"); node.classList.remove("active"); } },
    },
      img || el("div", { class: "clue-noimg" }, CATEGORY_LABELS[c.category] || c.category),
      el("div", { class: "clue-body" },
        el("div", { class: "cat" }, el("span", { class: `strength ${c.strength}` }), `${node ? `#${i + 1} · ` : ""}${CATEGORY_LABELS[c.category] || c.category} · ${c.strength}`),
        el("div", { class: "clue-desc" }, c.description),
        el("div", { class: "small muted" }, `→ ${c.implication}`))));
  });
}

// ---------- feedback and learning ----------

/** Lessons shared with everyone (docs/lessons.json, curated with new versions). */
async function loadSharedLessons() {
  try {
    const resp = await fetch("lessons.json", { cache: "no-cache" });
    state.sharedLessons = resp.ok ? ((await resp.json()).lessons || []).filter((t) => typeof t === "string").slice(0, 5) : [];
  } catch {
    state.sharedLessons = [];
  }
}

/** The lessons that go along with the next analysis (none when learning is switched off). */
function currentLessons() {
  if (settings.learn === false) return "";
  return lessonsBlock(loadLessons(localStorage), state.sharedLessons || []);
}

/** Settings: the lessons Ortfinder remembers, each deletable, plus what the feedback so far says. */
function renderLessonList() {
  const box = $("#lesson-list");
  if (!box) return;
  const lessons = loadLessons(localStorage);
  const stats = feedbackStats(loadFeedback(localStorage));
  const clear = el("button", { type: "button", class: "ghost small-btn" }, "Alle eigenen Lehren löschen");
  clear.addEventListener("click", () => {
    saveLessons(localStorage, []);
    renderLessonList();
  });
  box.replaceChildren(
    el("p", { class: "small muted" }, stats.count
      ? `Bisher ${stats.count} Rückmeldung(en): ${stats.within} im angegebenen Radius${stats.median_km != null ? `, mittlere Abweichung ${formatKm(stats.median_km)}` : ""}.`
      : "Noch keine Rückmeldungen auf diesem Gerät."),
    lessons.length
      ? el("ul", { class: "lessons" }, lessons.map((l, i) => {
        const del = el("button", { type: "button", class: "ghost small-btn", title: "Diese Lehre löschen" }, "✕");
        del.addEventListener("click", () => {
          saveLessons(localStorage, lessons.filter((_, j) => j !== i));
          renderLessonList();
        });
        return el("li", {}, el("span", {}, l.text), " ", el("span", { class: "muted" }, `(${l.date})`), " ", del);
      }))
      : el("p", { class: "small muted" }, "Noch keine eigenen Lehren."),
    (state.sharedLessons || []).length
      ? el("details", {}, el("summary", { class: "small" }, `Gemeinsame Lehren aller Nutzer (${state.sharedLessons.length})`),
        el("ul", { class: "lessons small" }, state.sharedLessons.map((t) => el("li", {}, t))))
      : null,
    lessons.length ? clear : null,
  );
}

/** The AI settings for a single question (reading a screenshot, writing lessons). */
function askConfig() {
  return {
    provider: settings.provider, apiKey: settings.apiKey, model: geminiModels(settings.model)[0], claudeKey: settings.claudeKey,
    claudeModel: settings.claudeModel, puterModel: settings.puterModel, openrouterKey: settings.openrouterKey,
    openrouterModel: settings.openrouterModel, ollamaUrl: settings.ollamaUrl, ollamaModel: settings.ollamaModel,
    ...(isCompat(settings.provider) ? (({ key, model, baseUrl }) => ({ compatKey: key, compatModel: model, compatUrl: baseUrl }))(compatSettings(settings, settings.provider)) : {}),
  };
}

const ask = (question) => askAI(askConfig(), { ...question, loadClaude: loadClaudeSdk });

/**
 * "Where was it really?" – mark it on the map, paste coordinates or a maps link, or let the AI read a
 * screenshot of the photo's details. Then the error is measured and, if wanted, the AI writes general
 * lessons that go along with later analyses.
 */
function feedbackSection(r) {
  const a = r.analysis;
  const box = el("details", { class: "feedback", id: "feedback" });
  const status = el("p", { class: "small", role: "status" });
  const where = el("input", { type: "text", placeholder: "Koordinaten, Karten-Link oder Adresse", "aria-label": "Tatsächlicher Aufnahmeort" });
  const comment = el("textarea", { rows: "2", maxlength: "1000", placeholder: "Was sollte Ortfinder besser machen? (optional)", "aria-label": "Verbesserungsvorschlag" });
  const learn = el("input", { type: "checkbox", checked: settings.learn !== false });
  const shareExact = el("input", { type: "checkbox" });
  const result = el("div", {});
  let truth = r.exif_location ? { lat: r.exif_location.lat, lon: r.exif_location.lon, name: r.exif_location.address || "GPS aus den Metadaten" } : null;
  let marker = null;
  let line = null;
  const setTruth = (t, why) => {
    truth = t;
    state.truth = t;
    status.textContent = `Tatsächlicher Ort: ${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}${t.name ? ` (${t.name})` : ""}${why ? ` – ${why}` : ""}. ` +
      `Abweichung der Analyse: ${formatKm(haversineKm(a.camera.lat, a.camera.lon, t.lat, t.lon))}.`;
    if (!state.layer) return;
    marker?.remove();
    line?.remove();
    marker = L.marker([t.lat, t.lon], { icon: pin("✔", "pin-truth", "Tatsächlicher Ort"), draggable: true, zIndexOffset: 1200 }).addTo(state.layer);
    marker.on("dragend", () => {
      const p = marker.getLatLng();
      setTruth({ lat: p.lat, lon: p.lng, name: "" }, "auf der Karte verschoben");
    });
    line = L.polyline([[a.camera.lat, a.camera.lon], [t.lat, t.lon]], { color: "#12805c", weight: 2, dashArray: "6 6" })
      .bindTooltip(`Abweichung ${formatKm(haversineKm(a.camera.lat, a.camera.lon, t.lat, t.lon))}`).addTo(state.layer);
  };
  if (truth) setTimeout(() => setTruth(truth, "aus den GPS-Metadaten"), 0);

  const markBtn = el("button", { type: "button", class: "ghost small-btn" }, "📍 Auf der Karte markieren");
  markBtn.addEventListener("click", () => {
    if (!state.map) return;
    status.textContent = "Jetzt auf der Karte auf den Aufnahmeort tippen (Luftbild hilft beim Finden) …";
    const mapEl = $("#map");
    mapEl.classList.add("picking");
    mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
    state.map.once("click", (e) => {
      mapEl.classList.remove("picking");
      setTruth({ lat: e.latlng.lat, lon: e.latlng.lng, name: "" }, "auf der Karte markiert (verschiebbar)");
    });
  });
  const useBtn = el("button", { type: "button", class: "ghost small-btn" }, "Übernehmen");
  useBtn.addEventListener("click", async () => {
    const parsed = parseLocation(where.value);
    if (!parsed) {
      status.textContent = "Nicht erkannt – z.B. „46.4012, 9.1045“, einen Google-Maps-Link oder eine Adresse eingeben.";
      return;
    }
    if (parsed.query) {
      status.textContent = "Adresse wird gesucht …";
      try {
        const [hit] = await osm.geocode(parsed.query, "", 1);
        if (!hit) throw new Error("nichts gefunden");
        setTruth({ lat: hit.lat, lon: hit.lon, name: hit.name }, "aus der Adresse");
      } catch (err) {
        status.textContent = `Adresse nicht gefunden (${err.message}). Lieber auf der Karte markieren.`;
      }
      return;
    }
    setTruth({ ...parsed, name: "" }, "eingegeben");
  });
  const shot = el("input", { type: "file", accept: "image/*", hidden: true });
  const shotBtn = el("button", { type: "button", class: "ghost small-btn" }, "🖼 Screenshot der Foto-Details");
  shotBtn.addEventListener("click", () => shot.click());
  shot.addEventListener("change", async () => {
    const file = shot.files?.[0];
    if (!file) return;
    status.textContent = "Die KI liest den Ort aus dem Screenshot …";
    try {
      const img = overview(await decodeImage(file), 1400);
      const found = parseScreenshotAnswer(await ask({ text: SCREENSHOT_PROMPT, image: img.data }));
      if (!found) throw new Error("kein Ort erkennbar");
      if (found.query) {
        const [hit] = await osm.geocode(found.query, "", 1);
        if (!hit) throw new Error(`„${found.query}“ nicht gefunden`);
        setTruth({ lat: hit.lat, lon: hit.lon, name: found.query }, "aus dem Screenshot gelesen");
      } else {
        setTruth({ lat: found.lat, lon: found.lon, name: found.address }, "aus dem Screenshot gelesen");
      }
    } catch (err) {
      status.textContent = `Screenshot nicht auswertbar (${err.message}). Lieber auf der Karte markieren oder die Adresse eintippen.`;
    }
  });

  const save = el("button", { type: "button", class: "primary small-btn" }, "Rückmeldung speichern");
  save.addEventListener("click", async () => {
    if (!truth && !comment.value.trim()) {
      status.textContent = "Erst den tatsächlichen Ort angeben oder etwas ins Textfeld schreiben.";
      return;
    }
    save.disabled = true;
    const record = truth ? feedbackRecord({ analysis: a, truth, comment: comment.value.trim() }) : { date: new Date().toISOString(), comment: comment.value.trim(), error_km: null };
    saveFeedback(localStorage, [...loadFeedback(localStorage), record]);
    let lessons = [];
    const parts = [el("p", { class: "small" }, truth
      ? `Gespeichert: Die Analyse lag ${formatKm(record.error_km)} daneben (${record.within_radius ? "innerhalb" : "außerhalb"} des angegebenen Radius von ${formatKm(record.radius_km)}).`
      : "Gespeichert.")];
    if (learn.checked && truth) {
      result.replaceChildren(el("p", { class: "small muted" }, "Die KI überlegt, was sie daraus für künftige Fotos lernt …"));
      try {
        const answer = await ask({
          text: lessonPrompt({ analysis: a, truth, truthName: truth.name, errorKm: record.error_km, comment: comment.value.trim() }),
          image: state.imageSource ? overview(state.imageSource, 768).data : null,
        });
        lessons = parseLessons(answer);
        saveLessons(localStorage, mergeLessons(loadLessons(localStorage), lessons, { errorKm: record.error_km }));
        parts.push(lessons.length
          ? el("div", {}, el("p", { class: "small" }, "Gelernt – geht ab jetzt bei jeder Analyse auf diesem Gerät mit (unter ⚙ ansehen oder löschen):"),
            el("ul", { class: "lessons small" }, lessons.map((t) => el("li", {}, t))))
          : el("p", { class: "small muted" }, "Die KI hat keine neue allgemeine Lehre gefunden."));
      } catch (err) {
        parts.push(el("p", { class: "small warn" }, `Lehren konnten nicht erstellt werden (${err.message}). Die Rückmeldung ist trotzdem gespeichert.`));
      }
    } else if (comment.value.trim() && learn.checked) {
      // Without a place the comment itself is the lesson (the person's own words).
      const own = parseLessons(`- ${comment.value.trim()}`);
      if (own.length) saveLessons(localStorage, mergeLessons(loadLessons(localStorage), own, { own: true }));
      if (own.length) parts.push(el("p", { class: "small" }, "Dein Hinweis geht ab jetzt bei jeder Analyse auf diesem Gerät mit."));
    }
    const share = el("a", { class: "small", target: "_blank", rel: "noopener" }, "🌍 Mit allen teilen (GitHub, vor dem Absenden prüfbar)");
    const updateShare = () => {
      share.href = shareIssueUrl({ record, lessons, comment: comment.value.trim(), truth: shareExact.checked ? truth : null });
    };
    updateShare();
    shareExact.addEventListener("change", updateShare);
    parts.push(el("p", { class: "small" }, share, " · ", el("label", { class: "check small" }, shareExact, " genauen Ort mitschicken")));
    result.replaceChildren(...parts);
    renderLessonList();
    save.disabled = false;
  });

  box.append(
    el("summary", {}, "✏️ Stimmt das? Richtigen Ort angeben & Ortfinder verbessern"),
    el("p", { class: "small muted" }, "Freiwillig. Weißt du, wo das Foto entstand (z.B. aus den Details in deiner Galerie)? Dann gib es hier an: " +
      "Ortfinder misst die Abweichung, und die KI leitet daraus allgemeine Lehren für künftige Analysen ab."),
    el("div", { class: "row wrap" }, markBtn, shotBtn, shot),
    el("div", { class: "row" }, where, useBtn),
    status,
    comment,
    el("label", { class: "check small" }, learn, " Daraus lernen (Lehren gehen bei künftigen Analysen auf diesem Gerät mit)"),
    el("div", { class: "row end" }, save),
    result,
  );
  return box;
}

/** Check the spot yourself: Google Street View looking the same way, Google Maps, and a new run with extra info. */
function externalLinks(cam, view) {
  const heading = view ? `&heading=${Math.round(view.bearing_deg)}` : "";
  const rerun = el("button", { type: "button", class: "ghost small-btn" }, "↻ Mit Zusatzinfo neu analysieren");
  rerun.addEventListener("click", () => {
    const box = $("#hints-box");
    if (box) box.open = true;
    if (!$("#hints").value.trim()) {
      $("#hints").focus();
      $("#hints").placeholder = "Erst hier eintragen, was du weißt oder gefunden hast – dann nochmal klicken.";
      return;
    }
    if (state.lastFile) analyze(state.lastFile);
  });
  return el("p", { class: "links small" },
    el("a", { href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${cam.lat},${cam.lon}${heading}`, target: "_blank", rel: "noopener" }, "🚶 Street View hier"),
    " · ",
    el("a", { href: `https://www.google.com/maps/search/?api=1&query=${cam.lat},${cam.lon}`, target: "_blank", rel: "noopener" }, "Google Maps"),
    " · ", rerun);
}

/** The whole run in the format of demo/beispiel.json; a true location given in the feedback goes along. */
function recordingJson() {
  const run = state.run;
  const t = state.truth;
  return JSON.stringify({
    model: run.model,
    date: new Date(run.started).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }),
    image: "beispiel.jpg",
    credit: { text: "eigenes Foto" },
    ...(t ? { truth: { lat: t.lat, lon: t.lon, label: t.name || "angegebener Aufnahmeort" } } : {}),
    events: run.events,
  });
}

function downloadRecording() {
  const url = URL.createObjectURL(new Blob([recordingJson()], { type: "application/json" }));
  const a = el("a", { href: url, download: "beispiel.json" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Save the run as a file (e.g. to publish it as the example, with the photo as demo/beispiel.jpg), or send
 * it through the phone's share menu straight to another app. Browsers only share certain file types, not
 * JSON – so it goes as a text file with the same content.
 */
function recordingButtons() {
  const save = el("button", { type: "button", class: "ghost small-btn" }, "💾 Aufzeichnung speichern (z.B. als Beispiel)");
  save.addEventListener("click", () => state.run && downloadRecording());
  const textFile = () => new File([recordingJson()], "ortfinder-aufzeichnung.txt", { type: "text/plain" });
  let canShare = false;
  try {
    canShare = Boolean(navigator.share && navigator.canShare?.({ files: [new File(["{}"], "test.txt", { type: "text/plain" })] }));
  } catch {
    // no file sharing in this browser
  }
  if (!canShare) return el("p", { class: "small" }, save);
  const share = el("button", { type: "button", class: "ghost small-btn" }, "📤 Aufzeichnung teilen");
  const status = el("span", { class: "small muted", role: "status" });
  share.addEventListener("click", async () => {
    if (!state.run) return;
    const file = textFile();
    try {
      await navigator.share({ files: [file], title: "Ortfinder-Aufzeichnung" });
      status.textContent = " Geteilt.";
    } catch (err) {
      if (err?.name === "AbortError") return; // closed the share menu
      status.textContent = " Teilen ging nicht – die Datei wird stattdessen gespeichert.";
      downloadRecording();
    }
  });
  return el("p", { class: "small" }, share, " ", save, status);
}

function renderResult(r) {
  const box = $("#result");
  box.replaceChildren();
  const a = r.analysis;
  const exif = r.exif_location;

  if (exif) {
    box.append(
      el("div", { class: "badges" }, el("span", { class: "badge exif" }, "GPS aus Metadaten – exakt")),
      el("p", { class: "label" }, "📷 Standpunkt laut GPS"),
      el("p", { class: "answer" }, exif.address || "GPS-Position gefunden"),
      el("p", { class: "coords" }, `${exif.lat.toFixed(6)}, ${exif.lon.toFixed(6)}`),
    );
    if (a && r.exif_vs_analysis_km != null) {
      box.append(el("p", { class: "small" }, `Blindtest: Die reine Bildanalyse (ohne GPS) lag ${formatKm(r.exif_vs_analysis_km)} daneben.`));
    }
  }
  if (!a) {
    if (!exif) box.append(el("p", {}, "Keine GPS-Daten in der Datei, und die KI-Bildanalyse lief nicht (siehe Protokoll)."));
    if (bestView(r)) {
      box.append(
        el("div", { id: "compare-slot" }, el("p", { class: "small muted" }, "3D-Nachbau wird berechnet …")),
        el("div", { id: "topview-slot" }, el("p", { class: "small muted" }, "Draufsicht wird berechnet …")),
        el("div", { id: "model-slot" }),
        el("div", { id: "skyline-slot" }),
      );
      refineView(r);
      refineSkyline(r);
    }
    return;
  }

  const cam = a.camera;
  const where = [a.city, a.region, a.country].filter(Boolean).join(", ");
  box.append(...[
    exif ? el("h3", {}, "Ergebnis der Bildanalyse") : null,
    el("div", { class: "badges" },
      el("span", { class: "badge" }, PRECISION[a.precision] || a.precision),
      el("span", { class: "badge" }, `±${formatKm(cam.radius_km)}`)),
    where ? el("p", { class: "muted" }, where) : null,
    el("p", { class: "label" }, "📷 Standpunkt (von hier wurde fotografiert)"),
    el("p", { class: "answer" }, cam.name),
    el("p", { class: "coords" }, `${cam.lat.toFixed(6)}, ${cam.lon.toFixed(6)}`),
    externalLinks(cam, a.view),
    el("div", { class: "small muted" }, `Konfidenz ${Math.round(cam.confidence * 100)} %`),
    el("div", { class: "meter" }, el("div", { style: `width:${cam.confidence * 100}%` })),
    a.subject ? el("p", { class: "label" }, "🎯 Motiv (das ist zu sehen)") : null,
    a.subject ? el("p", { class: "answer small-answer" }, a.subject.name) : null,
    a.subject ? el("p", { class: "coords" }, `${a.subject.lat.toFixed(6)}, ${a.subject.lon.toFixed(6)}`) : null,
    a.view ? el("p", { class: "view" }, `🧭 Blick nach ${compass(a.view.bearing_deg)} (${Math.round(a.view.bearing_deg)}°) · ca. ${formatKm(a.view.distance_m / 1000)} bis zum Motiv · ` +
      `Bildwinkel ${a.view.fov_source === "exif" ? `${a.view.fov_deg}° (aus der Brennweite)` : `~${Math.round(a.view.fov_deg)}°`}` +
      `${a.view.eye_height_m > 3 ? ` · Kamerahöhe ~${Math.round(a.view.eye_height_m)} m` : ""}`) : null,
    el("p", { class: "summary" }, a.summary),
    bestView(r) ? el("div", { id: "compare-slot" }, el("p", { class: "small muted" }, "3D-Nachbau wird berechnet …")) : null,
    bestView(r) ? el("div", { id: "topview-slot" }, el("p", { class: "small muted" }, "Draufsicht wird berechnet …")) : null,
    bestView(r) ? el("div", { id: "model-slot" }) : null,
    bestView(r) || state.skyline?.match?.ok ? el("div", { id: "skyline-slot" }) : null,
  ].filter(Boolean));

  if (r.truth) {
    const km = haversineKm(r.truth.lat, r.truth.lon, cam.lat, cam.lon);
    box.append(el("p", { class: "truth" }, `Tatsächlicher Aufnahmeort: ${r.truth.label} – die Analyse lag ${formatKm(km)} daneben.`));
  }
  if (a.candidates.length) {
    box.append(el("details", {}, el("summary", {}, `Alternativen (${a.candidates.length})`),
      el("ul", { class: "list" }, a.candidates.map((c) =>
        el("li", {}, el("strong", {}, c.name), ` – ${Math.round(c.confidence * 100)} %`, el("div", { class: "small muted" }, c.rationale || ""))))));
  }
  if (a.text_found.length) {
    box.append(el("details", {}, el("summary", {}, `Gelesener Text (${a.text_found.length})`),
      el("ul", { class: "list" }, a.text_found.map((t) => el("li", {}, t)))));
  }
  if (a.verification) {
    box.append(el("details", {}, el("summary", {}, "Überprüfung"), el("p", { class: "small" }, a.verification)));
  }
  box.append(feedbackSection(r));
  if (r.usage) {
    const u = r.usage;
    box.append(el("p", { class: "small muted" },
      `${r.model} · ${u.requests} Anfragen · ${u.input_tokens.toLocaleString("de-DE")} Input- / ${(u.output_tokens + u.thought_tokens).toLocaleString("de-DE")} Output-Tokens · ${r.seconds} s`));
  }
  if (state.run && state.replayT == null) box.append(recordingButtons());

  renderClueGallery(a.clues);

  if (state.layer) {
    if (r.truth) {
      L.circleMarker([r.truth.lat, r.truth.lon], { radius: 8, color: "#fff", weight: 2, fillColor: "#12805c", fillOpacity: 1 })
        .bindPopup(`<b>Tatsächlicher Ort</b><br>${escapeHtml(r.truth.label)}`)
        .addTo(state.layer);
    }
    drawResultMap(a);
    if (!exif) setOsmLink(cam.lat, cam.lon);
    refineView(r);
    refineSkyline(r);
  }
}

// The example button only appears when a recorded run is published in docs/demo/.
async function detectDemo() {
  try {
    const resp = await fetch("demo/beispiel.json", { method: "HEAD" });
    $("#demo").hidden = !resp.ok;
  } catch {
    $("#demo").hidden = true;
  }
}

applyLinkSettings();
loadSharedLessons().then(renderLessonList);
setupSettings();
setupDropzone();
setupImageSearch();
detectDemo();
// Back from the OpenRouter sign-in first, so an analysis waiting for it can continue right away.
finishSignInFromUrl().then(resumeInterrupted);
// Load Puter.js in the background, so the sign-in button can open its popup straight from the click.
if (settings.provider === "puter") (globalThis.requestIdleCallback ?? setTimeout)(() => loadPuter().catch(() => {}));

// Ortfinder web app: runs entirely in the browser (GitHub Pages friendly).

import { GeminiAgent, MODELS, assembleResult } from "./agent.js";
import { OSMClient, haversineKm, viewCone } from "./geo.js";
import { decodeImage, detailTiles, gridImage, overview, zoomCrop } from "./imaging.js";
import { extractMetadata, hintsForModel } from "./metadata.js";
import { PUTER_MODELS, PuterAgent, describePuterError, loadPuter } from "./puter-agent.js";
import { ToolExecutor } from "./tools.js";

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

const state = { controller: null, map: null, layer: null, hypoLayer: null, imageSource: null, startedAt: 0, timer: null, zoomCount: 0, replayT: null, run: null };
const osm = new OSMClient();

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
  provider: "puter", // "puter": free, no key (user signs in at Puter) · "gemini": own Gemini API key
  puterModel: PUTER_MODELS[0].id,
  apiKey: "",
  model: MODELS[0].id,
  thinking: "medium",
  webSearch: true,
  maxSteps: 8,
  remember: true,
  ...storageGet(),
};

function fillSettingsForm() {
  $("#provider").value = settings.provider;
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
  checkKeyFormat();
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

function persist() {
  storageSet({ ...settings, apiKey: settings.remember ? settings.apiKey : "" });
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
  $("#puter-note").hidden = provider !== "puter";
  showKeyBar(provider === "gemini" && !settings.apiKey);
}

function saveSettings() {
  settings.provider = $("#provider").value;
  settings.puterModel = $("#puter-model").value;
  settings.model = $("#model").value;
  settings.thinking = $("#thinking").value;
  settings.webSearch = $("#web-search").checked;
  settings.maxSteps = Math.max(3, Math.min(60, parseInt($("#max-steps").value, 10) || 8));
  settings.remember = $("#remember-key").checked;
  persist();
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
  $("#provider").addEventListener("change", () => applyProvider($("#provider").value));
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
}

// ---------- pipeline ----------

function initMap() {
  if (state.map || typeof L === "undefined") return;
  state.map = L.map("map", { worldCopyJump: true }).setView([30, 10], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);
  state.layer = L.featureGroup().addTo(state.map);
  state.hypoLayer = L.featureGroup().addTo(state.map);
}

function resetWorkspace() {
  state.controller?.abort();
  clearInterval(state.timer);
  state.zoomCount = 0;
  state.replayT = null;
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
  $("#result").replaceChildren(el("div", { class: "pending" }, el("span", { class: "spinner" }), " Analyse läuft …"));
  $("#clues-card").hidden = true;
  $("#clue-gallery").replaceChildren();
  state.imageSource = null;
  initMap();
  state.layer?.clearLayers();
  state.hypoLayer?.clearLayers();
  if (state.map) {
    state.map.setView([25, 10], 2); // every analysis starts on the world map and zooms in from there
    setTimeout(() => state.map.invalidateSize(), 50);
  }
}

function buildIntro(image, metadata) {
  const hints = hintsForModel(metadata);
  const parts = [
    `Bestimme, wo dieses Foto aufgenommen wurde. Originalauflösung: ${image.width}×${image.height} Pixel (zoom_image arbeitet auf dem Original).`,
    "Bild 1: das Foto. Bild 2: dasselbe Foto mit Koordinatenraster (0.0–1.0) zum Zielen für zoom_image.",
    hints.length
      ? "Metadaten aus der Datei (GPS-Daten, falls vorhanden, werden dir absichtlich nicht gezeigt):\n- " + hints.join("\n- ")
      : "Die Datei enthält keine verwertbaren Metadaten – nur der Bildinhalt zählt.",
  ];
  return parts.join("\n\n");
}

async function analyze(file) {
  if (!file) return;
  resetWorkspace();
  const controller = new AbortController();
  state.controller = controller;
  state.startedAt = Date.now();
  state.timer = setInterval(() => { $("#elapsed").textContent = `${Math.round((Date.now() - state.startedAt) / 1000)} s`; }, 1000);
  $("#cancel").hidden = false;
  // Every event of a run is kept, so a run can be inspected or replayed (see runDemo).
  const run = { started: new Date().toISOString(), model: settings.model, events: [] };
  state.run = run;
  window.ortfinderLastRun = run;
  const emit = (type, data) => {
    if (state.controller !== controller) return;
    run.events.push({ t: Math.round((Date.now() - state.startedAt) / 100) / 10, type, data });
    handle(type, data);
  };

  try {
    emit("status", { message: "Lese Metadaten (EXIF) …" });
    const buffer = await file.arrayBuffer();
    const metadata = await extractMetadata(buffer);
    emit("metadata", metadata);

    let exifLocation = null;
    if (metadata.gps) {
      exifLocation = { lat: metadata.gps.lat, lon: metadata.gps.lon };
      try {
        exifLocation.address = (await osm.reverse(exifLocation.lat, exifLocation.lon)).name;
      } catch (err) {
        exifLocation.address_error = err.message;
      }
      emit("exif_location", exifLocation);
    }

    const bitmap = await decodeImage(file);
    state.imageSource = bitmap;
    const ov = overview(bitmap);
    $("#photo").src = ov.dataUrl;
    metadata.width ??= bitmap.width;
    metadata.height ??= bitmap.height;

    let analysis = null;
    let usage = null;
    const useAI = $("#use-ai").checked;
    const puter = settings.provider === "puter";
    if (useAI && !puter && !settings.apiKey) {
      emit("warning", { message: "Für die KI-Bildanalyse mit Gemini fehlt noch der API-Key (Feld oben). Ohne Key wurden nur die GPS-/EXIF-Daten ausgewertet. Tipp: Unter ⚙ „Puter“ wählen – kostenlos und ohne Key." });
      showKeyBar(true, true);
    } else if (useAI) {
      const modelName = puter ? settings.puterModel : settings.model;
      emit("status", { message: `Bild geladen (${bitmap.width}×${bitmap.height}). Starte KI-Analyse mit ${modelName}${puter ? " über Puter" : ""} …` });
      if (puter) await ensurePuterSignedIn(emit, controller.signal);
      const grid = gridImage(bitmap);
      const agent = puter
        ? new PuterAgent({ model: settings.puterModel, maxSteps: settings.maxSteps, emit, signal: controller.signal })
        : new GeminiAgent({
          apiKey: settings.apiKey, model: settings.model, thinkingLevel: settings.thinking,
          webSearch: settings.webSearch, maxSteps: settings.maxSteps, emit, signal: controller.signal,
        });
      const executor = new ToolExecutor({ zoom: async (box, enhance) => zoomCrop(bitmap, box, enhance), osm, emit });
      ({ analysis, usage } = await agent.run({
        intro: buildIntro(bitmap, metadata),
        images: [
          { type: "image", mime_type: "image/jpeg", data: ov.data, resolution: "high" },
          { type: "image", mime_type: "image/jpeg", data: grid.data, resolution: "medium" },
          ...detailTiles(bitmap).flatMap((t) => [
            { type: "text", text: `Detail-Kachel ${t.name} (x ${t.box[0].toFixed(2)}–${t.box[2].toFixed(2)}, y ${t.box[1].toFixed(2)}–${t.box[3].toFixed(2)}):` },
            { type: "image", mime_type: "image/jpeg", data: t.data, resolution: "high" },
          ]),
        ],
        executor,
      }));
    }

    const result = assembleResult({
      metadata, exifLocation, analysis, usage, model: settings.provider === "puter" ? `${settings.puterModel} (Puter)` : settings.model,
      seconds: Math.round((Date.now() - state.startedAt) / 100) / 10,
    });
    emit("result", result);
  } catch (err) {
    if (err.name === "AbortError") emit("error", { message: "Analyse abgebrochen." });
    else emit("error", { message: err.message || String(err) });
  } finally {
    if (state.controller === controller) {
      clearInterval(state.timer);
      $("#cancel").hidden = true;
      $("#progress").textContent = "";
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
  box.replaceChildren(el("div", { class: "pending" }, el("span", { class: "spinner" }), " Analyse läuft …"));
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
    "Foto: ", el("a", { href: demo.credit.url, target: "_blank", rel: "noopener" }, demo.credit.text), ". ",
    settings.apiKey ? "Lade jetzt dein eigenes Foto hoch." : "Für eigene Fotos oben den Gemini-API-Key eintragen.",
  );
  const photo = $("#photo");
  photo.src = `demo/${demo.image}`;
  photo.decode().then(() => { if (state.controller === controller) state.imageSource = photo; }).catch(() => {});
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
  status: "•", warning: "⚠", error: "✖", step: "▸", thinking: "💭", note: "📝", zoom: "🔍",
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
const QUIET_TOOLS = new Set(["zoom_image", "mark_hypothesis"]);

function toolLabel(name) {
  return {
    geocode: "Ortssuche", reverse_geocode: "Adresse zu Koordinaten", overpass_query: "OSM-Abfrage", sun_position: "Sonnenstand",
    bearing_distance: "Richtung/Entfernung", destination_point: "Punkt berechnen",
  }[name] || name;
}

function toolInput({ tool, input }) {
  if (tool === "geocode") return `„${input.query}“${input.country_codes ? ` (${input.country_codes})` : ""}`;
  if (tool === "reverse_geocode") return `${input.lat}, ${input.lon}`;
  if (tool === "overpass_query") return `${input.purpose || ""}\n${input.query}`;
  if (tool === "sun_position") return `${input.lat}, ${input.lon} @ ${input.datetime_utc}`;
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
  state.map.flyToBounds(area.getBounds().pad(0.3), { duration: 1.4, maxZoom: 15 });
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
  L.circle([cam.lat, cam.lon], { radius: Math.max(cam.radius_km, 0.02) * 1000, color: "#0b6bcb", weight: 1.5, fillOpacity: 0.12 })
    .bindTooltip(`Aufnahme-Areal ±${formatKm(cam.radius_km)}`).addTo(focus);
  if (a.view) {
    const coneKm = Math.min(Math.max(a.view.distance_m / 1000, 0.05), 50);
    L.polygon(viewCone(cam.lat, cam.lon, a.view.bearing_deg, a.view.fov_deg, coneKm), { color: "#e8590c", weight: 1, fillColor: "#ff922b", fillOpacity: 0.25 })
      .bindTooltip(`Sichtfeld: ${Math.round(a.view.bearing_deg)}° (${compass(a.view.bearing_deg)}), ~${a.view.fov_deg}°`).addTo(focus);
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
  state.map.flyToBounds(focus.getBounds().pad(0.35), { duration: 2.2, maxZoom: 17 });
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
    el("div", { class: "small muted" }, `Konfidenz ${Math.round(cam.confidence * 100)} %`),
    el("div", { class: "meter" }, el("div", { style: `width:${cam.confidence * 100}%` })),
    a.subject ? el("p", { class: "label" }, "🎯 Motiv (das ist zu sehen)") : null,
    a.subject ? el("p", { class: "answer small-answer" }, a.subject.name) : null,
    a.subject ? el("p", { class: "coords" }, `${a.subject.lat.toFixed(6)}, ${a.subject.lon.toFixed(6)}`) : null,
    a.view ? el("p", { class: "view" }, `🧭 Blick nach ${compass(a.view.bearing_deg)} (${Math.round(a.view.bearing_deg)}°) · ca. ${formatKm(a.view.distance_m / 1000)} bis zum Motiv · Bildwinkel ~${a.view.fov_deg}°`) : null,
    el("p", { class: "summary" }, a.summary),
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
  if (r.usage) {
    const u = r.usage;
    box.append(el("p", { class: "small muted" },
      `${r.model} · ${u.requests} Anfragen · ${u.input_tokens.toLocaleString("de-DE")} Input- / ${(u.output_tokens + u.thought_tokens).toLocaleString("de-DE")} Output-Tokens · ${r.seconds} s`));
  }

  renderClueGallery(a.clues);

  if (state.layer) {
    if (r.truth) {
      L.circleMarker([r.truth.lat, r.truth.lon], { radius: 8, color: "#fff", weight: 2, fillColor: "#12805c", fillOpacity: 1 })
        .bindPopup(`<b>Tatsächlicher Ort</b><br>${escapeHtml(r.truth.label)}`)
        .addTo(state.layer);
    }
    drawResultMap(a);
    if (!exif) setOsmLink(cam.lat, cam.lon);
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

setupSettings();
setupDropzone();
detectDemo();
// Load Puter.js in the background, so the sign-in button can open its popup straight from the click.
if (settings.provider === "puter") (globalThis.requestIdleCallback ?? setTimeout)(() => loadPuter().catch(() => {}));

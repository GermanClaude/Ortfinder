// Ortfinder web app: runs entirely in the browser (GitHub Pages friendly).

import { GeminiAgent, MODELS, assembleResult } from "./agent.js";
import { OSMClient } from "./geo.js";
import { decodeImage, gridImage, overview, zoomCrop } from "./imaging.js";
import { extractMetadata, hintsForModel } from "./metadata.js";
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

const state = { controller: null, map: null, layer: null, startedAt: 0, timer: null, zoomCount: 0, running: false };
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
  apiKey: "",
  model: MODELS[0].id,
  thinking: "high",
  webSearch: true,
  maxSteps: 12,
  remember: true,
  ...storageGet(),
};

function fillSettingsForm() {
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

function saveSettings() {
  settings.apiKey = $("#api-key").value.trim();
  settings.model = $("#model").value;
  settings.thinking = $("#thinking").value;
  settings.webSearch = $("#web-search").checked;
  settings.maxSteps = Math.max(3, Math.min(60, parseInt($("#max-steps").value, 10) || 12));
  settings.remember = $("#remember-key").checked;
  storageSet({ ...settings, apiKey: settings.remember ? settings.apiKey : "" });
  updateStatusChip();
  showSettings(false);
}

function showSettings(open) {
  $("#settings").hidden = !open;
  $("#settings-toggle").setAttribute("aria-expanded", String(open));
}

function updateStatusChip() {
  const chip = $("#settings-toggle");
  const model = MODELS.find((m) => m.id === settings.model);
  if (settings.apiKey) {
    chip.textContent = `⚙ ${model ? model.id : settings.model} · ${settings.webSearch ? "mit Google-Suche" : "ohne Websuche"}`;
    chip.className = "chip ok";
  } else {
    chip.textContent = "⚙ Gemini-API-Key eintragen";
    chip.className = "chip warn";
  }
}

function setupSettings() {
  fillSettingsForm();
  updateStatusChip();
  if (!settings.apiKey) showSettings(true);
  $("#settings-toggle").addEventListener("click", () => showSettings($("#settings").hidden));
  $("#save-settings").addEventListener("click", saveSettings);
  $("#api-key").addEventListener("input", checkKeyFormat);
  $("#api-key").addEventListener("keydown", (e) => e.key === "Enter" && saveSettings());
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
}

function resetWorkspace() {
  state.controller?.abort();
  clearInterval(state.timer);
  state.zoomCount = 0;
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
  initMap();
  state.layer?.clearLayers();
  if (state.map) setTimeout(() => state.map.invalidateSize(), 50);
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
  const emit = (type, data) => {
    if (state.controller === controller) handle(type, data);
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
    const ov = overview(bitmap);
    $("#photo").src = ov.dataUrl;
    metadata.width ??= bitmap.width;
    metadata.height ??= bitmap.height;

    let analysis = null;
    let usage = null;
    const useAI = $("#use-ai").checked;
    if (useAI && !settings.apiKey) {
      emit("warning", { message: "Kein Gemini-API-Key eingetragen – es werden nur die Metadaten ausgewertet (⚙ oben rechts)." });
    } else if (useAI) {
      emit("status", { message: `Bild geladen (${bitmap.width}×${bitmap.height}). Starte KI-Analyse mit ${settings.model} …` });
      const grid = gridImage(bitmap);
      const agent = new GeminiAgent({
        apiKey: settings.apiKey, model: settings.model, thinkingLevel: settings.thinking,
        webSearch: settings.webSearch, maxSteps: settings.maxSteps, emit, signal: controller.signal,
      });
      const executor = new ToolExecutor({ zoom: async (box, enhance) => zoomCrop(bitmap, box, enhance), osm, emit });
      ({ analysis, usage } = await agent.run({
        intro: buildIntro(bitmap, metadata),
        images: [
          { type: "image", mime_type: "image/jpeg", data: ov.data, resolution: "high" },
          { type: "image", mime_type: "image/jpeg", data: grid.data, resolution: "medium" },
        ],
        executor,
      }));
    }

    const result = assembleResult({
      metadata, exifLocation, analysis, usage, model: settings.model,
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

// ---------- rendering ----------

const ICONS = {
  status: "•", warning: "⚠", error: "✖", step: "▸", thinking: "💭", note: "📝", zoom: "🔍",
  tool_call: "🗺", tool_result: "↳", web_search: "🌐", web_results: "↳", metadata: "🏷", exif_location: "📍", result: "✔",
};

function log(type, text) {
  const t = `${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`;
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
      if (data.tool !== "zoom_image") log("tool_call", `${toolLabel(data.tool)}: ${toolInput(data)}`);
      break;
    case "tool_result":
      if (data.tool !== "zoom_image" || data.is_error) log(data.is_error ? "warning" : "tool_result", data.preview);
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

function toolLabel(name) {
  return { geocode: "Ortssuche", reverse_geocode: "Adresse zu Koordinaten", overpass_query: "OSM-Abfrage", sun_position: "Sonnenstand" }[name] || name;
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

function addExifMarker(loc) {
  if (!state.layer) return;
  L.circleMarker([loc.lat, loc.lon], { radius: 9, color: "#fff", weight: 2, fillColor: "#12805c", fillOpacity: 1 })
    .bindPopup(`<b>GPS aus Metadaten</b><br>${escapeHtml(loc.address || "")}`)
    .addTo(state.layer);
  state.map.setView([loc.lat, loc.lon], 15);
  setOsmLink(loc.lat, loc.lon);
}

function formatKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
}

function drawLocation(loc, primary) {
  const color = primary ? "#0b6bcb" : "#8a94a3";
  if (loc.radius_km > 0.02) {
    L.circle([loc.lat, loc.lon], { radius: loc.radius_km * 1000, color, weight: 1, fillOpacity: primary ? 0.12 : 0.05 }).addTo(state.layer);
  }
  L.circleMarker([loc.lat, loc.lon], { radius: primary ? 9 : 6, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
    .bindPopup(`<b>${escapeHtml(loc.name)}</b><br>${Math.round(loc.confidence * 100)} % · ±${formatKm(loc.radius_km)}`)
    .addTo(state.layer);
}

function renderResult(r) {
  const box = $("#result");
  box.replaceChildren();
  const a = r.analysis;
  const exif = r.exif_location;

  if (exif) {
    box.append(
      el("div", { class: "badges" }, el("span", { class: "badge exif" }, "GPS aus Metadaten – exakt")),
      el("p", { class: "answer" }, exif.address || "GPS-Position gefunden"),
      el("p", { class: "coords" }, `${exif.lat.toFixed(6)}, ${exif.lon.toFixed(6)}`),
    );
    if (a && r.exif_vs_analysis_km != null) {
      box.append(el("p", { class: "small" }, `Blindtest: Die reine Bildanalyse (ohne GPS) lag ${formatKm(r.exif_vs_analysis_km)} daneben.`));
    }
  }
  if (!a) {
    if (!exif) box.append(el("p", {}, "Keine GPS-Daten in der Datei. Für die Bildanalyse wird ein Gemini-API-Key benötigt (⚙ oben rechts)."));
    return;
  }

  const best = a.best_guess;
  const where = [a.city, a.region, a.country].filter(Boolean).join(", ");
  box.append(...[
    exif ? el("h3", {}, "Ergebnis der Bildanalyse") : null,
    el("div", { class: "badges" },
      el("span", { class: "badge" }, PRECISION[a.precision] || a.precision),
      el("span", { class: "badge" }, `±${formatKm(best.radius_km)}`)),
    el("p", { class: "answer" }, best.name),
    where && where !== best.name ? el("p", { class: "muted" }, where) : null,
    el("p", { class: "coords" }, `${best.lat.toFixed(6)}, ${best.lon.toFixed(6)}`),
    el("div", { class: "small muted" }, `Konfidenz ${Math.round(best.confidence * 100)} %`),
    el("div", { class: "meter" }, el("div", { style: `width:${best.confidence * 100}%` })),
    el("p", { class: "summary" }, a.summary),
  ].filter(Boolean));

  if (a.candidates.length) {
    box.append(el("details", {}, el("summary", {}, `Alternativen (${a.candidates.length})`),
      el("ul", { class: "list" }, a.candidates.map((c) =>
        el("li", {}, el("strong", {}, c.name), ` – ${Math.round(c.confidence * 100)} %`, el("div", { class: "small muted" }, c.rationale || ""))))));
  }
  if (a.clues.length) {
    const overlay = $("#overlay");
    box.append(el("details", { open: true }, el("summary", {}, `Hinweise im Bild (${a.clues.length})`),
      el("ul", { class: "list" }, a.clues.map((c, i) => {
        const node = c.box.length === 4 ? addBox(c.box, `clue ${c.strength}`, String(i + 1)) : null;
        return el("li", {
          class: "clue-item",
          onmouseenter: () => { if (node) { overlay.classList.add("focus"); node.classList.add("active"); } },
          onmouseleave: () => { if (node) { overlay.classList.remove("focus"); node.classList.remove("active"); } },
        },
          el("div", { class: "cat" }, el("span", { class: `strength ${c.strength}` }), `${node ? `#${i + 1} · ` : ""}${c.category} · ${c.strength}`),
          el("div", {}, c.description),
          el("div", { class: "small muted" }, `→ ${c.implication}`));
      }))));
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

  if (state.layer) {
    a.candidates.slice().reverse().forEach((c) => drawLocation(c, false));
    drawLocation(best, true);
    if (!exif) setOsmLink(best.lat, best.lon);
    const bounds = state.layer.getBounds();
    if (bounds.isValid()) state.map.fitBounds(bounds.pad(0.2), { maxZoom: 16 });
  }
}

setupSettings();
setupDropzone();

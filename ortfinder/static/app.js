"use strict";

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
  exakt: "Exakter Standort",
  strasse: "Straßengenau",
  stadtteil: "Stadtteil",
  stadt: "Stadt",
  region: "Region",
  land: "Land",
  kontinent: "Kontinent",
  unbekannt: "Unbekannt",
};

const state = { source: null, map: null, layer: null, startedAt: 0, timer: null, zoomCount: 0 };

// ---------- setup ----------

async function loadStatus() {
  const chip = $("#status-chip");
  try {
    const res = await fetch("/api/status");
    const s = await res.json();
    if (s.api_key) {
      chip.textContent = `${s.model} · Aufwand ${s.effort}${s.web_search ? " · Websuche" : ""}`;
      chip.className = "chip ok";
    } else {
      chip.textContent = "Kein API-Key – nur Metadaten";
      chip.className = "chip warn";
    }
  } catch {
    chip.textContent = "Server nicht erreichbar";
    chip.className = "chip warn";
  }
}

function initMap() {
  if (state.map || typeof L === "undefined") return;
  state.map = L.map("map", { worldCopyJump: true }).setView([30, 10], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);
  state.layer = L.featureGroup().addTo(state.map);
}

function setupDropzone() {
  const drop = $("#drop");
  const input = $("#file");
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => input.files[0] && start(input.files[0]));
  for (const ev of ["dragenter", "dragover"]) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const ev of ["dragleave", "drop"]) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  }
  drop.addEventListener("drop", (e) => {
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    if (file) start(file);
  });
  document.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) start(item.getAsFile());
  });
}

// ---------- job lifecycle ----------

function resetWorkspace() {
  if (state.source) state.source.close();
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
  if (state.layer) state.layer.clearLayers();
  if (state.map) setTimeout(() => state.map.invalidateSize(), 50);
}

async function start(file) {
  resetWorkspace();
  const form = new FormData();
  form.append("file", file, file.name || "bild.png");
  form.append("use_ai", $("#use-ai").checked ? "true" : "false");
  log("status", "Lade Bild hoch …");
  let res;
  try {
    res = await fetch("/api/locate", { method: "POST", body: form });
  } catch {
    return fail("Server nicht erreichbar.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return fail(body.detail || `Upload fehlgeschlagen (HTTP ${res.status}).`);
  }
  const { job_id } = await res.json();
  state.startedAt = Date.now();
  state.timer = setInterval(() => {
    $("#elapsed").textContent = `${Math.round((Date.now() - state.startedAt) / 1000)} s`;
  }, 1000);
  state.source = new EventSource(`/api/jobs/${job_id}/events`);
  state.source.onmessage = (msg) => handle(JSON.parse(msg.data));
  state.source.onerror = () => {
    state.source.close();
    clearInterval(state.timer);
  };
}

function fail(message) {
  log("error", message);
  $("#result").replaceChildren(el("p", { class: "error" }, message));
  clearInterval(state.timer);
}

// ---------- events ----------

const ICONS = {
  status: "•", warning: "⚠", error: "✖", step: "▸", thinking: "💭", note: "📝", zoom: "🔍",
  tool_call: "🗺", tool_result: "↳", web_search: "🌐", web_results: "↳", metadata: "🏷", exif_location: "📍", result: "✔",
};

function log(type, text, time) {
  const t = time != null ? `${time.toFixed(1)}s` : "";
  const item = el("li", { class: type }, el("span", { class: "t" }, t), el("span", {}, ICONS[type] || "•"), el("span", { class: "body" }, text));
  const list = $("#log");
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
  list.append(item);
  if (stick) list.scrollTop = list.scrollHeight;
}

function handle({ type, data, t }) {
  switch (type) {
    case "image":
      $("#photo").src = data.preview;
      break;
    case "status":
    case "warning":
      log(type, data.message, t);
      break;
    case "step":
      $("#progress").textContent = `Runde ${data.step} / ${data.max_steps}`;
      log("step", `Runde ${data.step}`, t);
      break;
    case "metadata":
      log("metadata", describeMetadata(data), t);
      break;
    case "exif_location":
      log("exif_location", `GPS-Koordinaten in den Metadaten: ${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}${data.address ? `\n${data.address}` : ""}`, t);
      addExifMarker(data);
      break;
    case "thinking":
      log("thinking", data.text.trim(), t);
      break;
    case "note":
      log("note", data.text.trim(), t);
      break;
    case "zoom":
      addZoom(data);
      log("zoom", `Zoom #${data.index}: ${data.purpose || "Detail"}`, t);
      break;
    case "tool_call":
      if (data.tool !== "zoom_image") log("tool_call", `${toolLabel(data.tool)}: ${toolInput(data)}`, t);
      break;
    case "tool_result":
      if (data.tool !== "zoom_image" || data.is_error) log(data.is_error ? "warning" : "tool_result", data.preview, t);
      break;
    case "web_search":
      log("web_search", `${data.fetch ? "Seite abrufen" : "Websuche"}: ${data.query}`, t);
      break;
    case "web_results":
      log("web_results", data.error ? `Fehler: ${data.error}` : data.results.map((r) => `${r.title} – ${r.url}`).join("\n") || "keine Treffer", t);
      break;
    case "result":
      renderResult(data);
      log("result", `Fertig nach ${data.seconds} s`, t);
      break;
    case "error":
      fail(data.message);
      break;
    case "done":
      state.source.close();
      clearInterval(state.timer);
      $("#progress").textContent = "";
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
  if (m.error) return m.error;
  if (!m.has_exif) return `${m.format || "Bild"} ${m.width}×${m.height}, keine EXIF-Metadaten (z.B. durch Messenger/Screenshot entfernt).`;
  const parts = [`${m.format} ${m.width}×${m.height}`];
  const cam = [m.camera_make, m.camera_model].filter(Boolean).join(" ");
  if (cam) parts.push(cam);
  if (m.taken_at) parts.push(`aufgenommen ${m.taken_at}${m.utc_offset ? ` (${m.utc_offset})` : ""}`);
  parts.push(m.gps ? "GPS vorhanden" : "kein GPS");
  return parts.join(" · ");
}

// ---------- image overlay ----------

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

// ---------- map ----------

function addExifMarker(loc) {
  if (!state.layer) return;
  L.circleMarker([loc.lat, loc.lon], { radius: 9, color: "#fff", weight: 2, fillColor: "#12805c", fillOpacity: 1 })
    .bindPopup(`<b>GPS aus Metadaten</b><br>${escapeHtml(loc.address || "")}`)
    .addTo(state.layer);
  state.map.setView([loc.lat, loc.lon], 15);
  setOsmLink(loc.lat, loc.lon);
}

function setOsmLink(lat, lon) {
  const a = $("#osm-link");
  a.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
  a.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

function formatKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
}

// ---------- result ----------

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
    if (!exif) box.append(el("p", {}, "Keine GPS-Daten in der Datei. Für eine Bildanalyse wird ein ANTHROPIC_API_KEY benötigt."));
    return;
  }

  const best = a.best_guess;
  const where = [a.city, a.region, a.country].filter(Boolean).join(", ");
  box.append(...[
    exif ? el("h3", {}, "Ergebnis der Bildanalyse") : null,
    el("div", { class: "badges" },
      el("span", { class: "badge" }, PRECISION[a.precision] || a.precision),
      el("span", { class: "badge" }, `±${formatKm(best.radius_km)}`),
    ),
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
    const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    box.append(el("p", { class: "small muted" }, `${r.model} · ${u.requests} Anfragen · ${input.toLocaleString("de-DE")} Input- / ${u.output_tokens.toLocaleString("de-DE")} Output-Tokens · ${r.seconds} s`));
  }

  if (state.layer) {
    a.candidates.slice().reverse().forEach((c) => drawLocation(c, false));
    drawLocation(best, true);
    if (!exif) setOsmLink(best.lat, best.lon);
    const bounds = state.layer.getBounds();
    if (bounds.isValid()) state.map.fitBounds(bounds.pad(0.2), { maxZoom: 16 });
  }
}

loadStatus();
setupDropzone();

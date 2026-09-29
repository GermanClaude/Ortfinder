// While an analysis runs: what Ortfinder is doing right now and roughly what comes next, from the events of
// the run. "Next" is the AI's own plan when it wrote one (the prompt asks for a line "Nächster Schritt: …" in
// the note of every round), otherwise the step a typical analysis takes at this point (estimate.js).

import { PLAN, planFor } from "./estimate.js";

const NEXT_LINE = /(?:^|\n)[\s>*_#-]*(?:nächster schritt|als nächstes|nächste schritte|next step|next)[*_\s]*:[*_\s]*(.+)/i;

/** The AI's own next step from a note or thought ("Nächster Schritt: …"), or null. */
export function nextFromText(text) {
  const m = NEXT_LINE.exec(String(text || ""));
  if (!m) return null;
  const line = m[1].replace(/\*\*|__|`/g, "").trim();
  return line ? clip(line, 180) : null;
}

/** The heading of a thought summary ("**Reading the sign**\n…"), or null. */
export function thoughtTitle(text) {
  const m = /^\s*\*\*(.{3,90}?)\*\*/.exec(String(text || ""));
  return m ? m[1].trim() : null;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const quoted = (s) => `„${clip(String(s), 60)}“`;

const TOOLS = {
  zoom_image: (i) => `${i.ki_schaerfen && i.sicherheit >= 0.9 ? "zoomt und schärft (KI, mit Prüfung)" : "zoomt"}${i.purpose ? `: ${clip(i.purpose, 70)}` : " auf ein Detail"}`,
  geocode: (i) => `sucht den Ort ${quoted(i.query || "")}`,
  reverse_geocode: () => "schlägt die Adresse zu Koordinaten nach",
  overpass_query: (i) => (i.purpose ? `fragt OpenStreetMap ab: ${clip(i.purpose, 70)}` : "fragt OpenStreetMap ab"),
  nearby_features: () => "prüft Geschäfte und Gebäude in der Nähe",
  street_geometry: (i) => `prüft den Verlauf von ${quoted(i.name || "der Straße")}`,
  wiki_search: (i) => `sucht in Wikipedia nach ${quoted(i.query || "")}`,
  photos_nearby: () => "sucht Fotos anderer in der Nähe",
  map_view: (i) => `lädt ${i.layer === "karte" ? "einen Kartenausschnitt" : "ein Luftbild"}${i.purpose ? `: ${clip(i.purpose, 60)}` : ""}`,
  render_view: () => "baut die Szene in 3D nach und vergleicht sie mit dem Foto",
  top_view: (i) => (Number.isFinite(i.camera_lat) ? "klappt das Foto aufs Gelände und vergleicht es mit dem Luftbild"
    : "legt das Foto als Draufsicht flach (Oberflächen, Meter-Raster)"),
  solve_camera: () => "berechnet den genauen Standpunkt (Rückwärtsschnitt)",
  skyline_match: () => "gleicht den Bergkamm mit dem Gelände ab",
  mark_hypothesis: (i) => (i.label ? `trägt den Zwischenstand ein: ${clip(i.label, 60)}` : "trägt einen Zwischenstand ein"),
  sun_position: () => "berechnet den Sonnenstand",
  bearing_distance: () => "rechnet Richtung und Entfernung",
  destination_point: () => "rechnet einen Punkt aus",
};

/** What a tool call does, in a few words. */
export function toolActivity(tool, input = {}) {
  const f = TOOLS[tool];
  return f ? f(input || {}) : `nutzt ${tool}`;
}

/** The step of a typical analysis in round k (1-based) of a budget of maxSteps rounds. */
export function typicalStep(k, maxSteps) {
  const plan = planFor(Math.max(maxSteps || PLAN.length, k));
  const step = plan[Math.min(k, plan.length) - 1];
  return step.steps.startsWith("Reserve") ? "weitere Prüfungen, dann Ergebnis abgeben" : step.steps;
}

export class LiveStatus {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.round = 0;
    this.maxSteps = 0;
    this.pending = []; // activities of the tools running now
    this.plan = null; // the AI's own next step
    this.planRound = 0;
    this.headline = null; // what the AI is thinking about (thought summary heading)
    this.message = null; // a status message while nothing else runs (reading EXIF, retrying, …)
    this.since = clock();
  }

  /** Feed one event of the run. */
  on(type, data = {}) {
    const before = this.now();
    if (type === "step") {
      this.round = data.step;
      this.maxSteps = data.max_steps || this.maxSteps;
      this.pending = [];
      this.headline = null;
      this.message = null;
    } else if (type === "thinking" || type === "note") {
      const next = nextFromText(data.text);
      if (next) {
        this.plan = next;
        this.planRound = this.round;
      }
      if (type === "thinking") this.headline = thoughtTitle(data.text) || this.headline;
    } else if (type === "tool_call") {
      this.pending.push({ tool: data.tool, text: toolActivity(data.tool, data.input) });
      this.message = null;
    } else if (type === "tool_result") {
      const i = this.pending.findIndex((p) => p.tool === data.tool);
      if (i >= 0) this.pending.splice(i, 1);
    } else if (type === "status" || type === "warning") {
      this.message = clip(String(data.message || ""), 140);
    }
    if (this.now() !== before) this.since = this.clock();
  }

  /** What is happening right now. */
  now() {
    if (this.pending.length) {
      const shown = this.pending.slice(0, 3).map((p) => p.text);
      const more = this.pending.length - shown.length;
      return `Ortfinder ${shown.join(" · ")}${more > 0 ? ` (+${more} weitere)` : ""}`;
    }
    if (this.message) return this.message;
    if (!this.round) return "Ortfinder bereitet die Analyse vor …";
    const round = `Runde ${this.round}${this.maxSteps ? `/${this.maxSteps}` : ""}`;
    return this.headline ? `Die KI denkt nach (${round}): ${this.headline}` : `Die KI denkt nach (${round}) …`;
  }

  /** Roughly what comes next: { text, source: "ki" | "typisch" }. */
  next() {
    if (this.plan && this.round - this.planRound <= 1) return { text: this.plan, source: "ki" };
    if (!this.round) return { text: typicalStep(1, this.maxSteps), source: "typisch" };
    // While tools run, the next round comes next; while the AI thinks, the step of this round.
    const k = this.pending.length ? this.round + 1 : this.round;
    return { text: typicalStep(k, this.maxSteps), source: "typisch" };
  }

  /** Seconds the current activity has been going on. */
  seconds() {
    return Math.max(0, Math.round((this.clock() - this.since) / 1000));
  }
}

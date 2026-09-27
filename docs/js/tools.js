// Tools the geolocation agent can call: declarations for Gemini, input validation and execution.

import { OSMError, sunPosition } from "./geo.js";

export const SUBMIT_TOOL = "submit_result";
export const PRECISION_LEVELS = ["exakt", "strasse", "stadtteil", "stadt", "region", "land", "kontinent", "unbekannt"];
export const CLUE_CATEGORIES = [
  "text", "sprache", "verkehrszeichen", "schild", "strasse", "kennzeichen", "fahrzeug", "architektur",
  "infrastruktur", "menschen", "gegenstand", "marke", "vegetation", "tiere", "landschaft", "klima", "sonne",
  "innenraum", "wahrzeichen", "kultur", "sonstiges",
];
const STRENGTHS = ["stark", "mittel", "schwach"];

const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required });
const LOCATION = {
  name: { type: "string", description: "Ortsbezeichnung, so genau wie begründbar" },
  lat: { type: "number" },
  lon: { type: "number" },
  radius_km: { type: "number", description: "Unsicherheitsradius um den Punkt in km" },
  confidence: { type: "number", description: "Wahrscheinlichkeit 0.0-1.0, dass der Ort im Radius liegt" },
};

export const FUNCTION_TOOLS = [
  {
    type: "function",
    name: "zoom_image",
    description:
      "Schneidet einen Bereich aus dem Originalbild in voller Auflösung aus und vergrößert ihn. Nutze das für jedes " +
      "kleine Detail: Schrift, Verkehrszeichen, Schilder, Kennzeichen, Logos, Hausnummern, Kleidung, Gegenstände, " +
      "entfernte Gebäude oder Berge, Pflanzen, Steckdosen, Blick aus Fenstern. Koordinaten sind Anteile der " +
      "Bildbreite/-höhe (0.0 = links/oben, 1.0 = rechts/unten), siehe Raster-Bild. Mehrere Zooms gleichzeitig sind erwünscht.",
    parameters: obj({
      x_min: { type: "number" },
      y_min: { type: "number" },
      x_max: { type: "number" },
      y_max: { type: "number" },
      enhance: { type: "boolean", description: "Kontrast/Schärfe anheben (hilft bei dunkler oder verwaschener Schrift)" },
      purpose: { type: "string", description: "Was du dort zu erkennen hoffst" },
    }, ["x_min", "y_min", "x_max", "y_max", "purpose"]),
  },
  {
    type: "function",
    name: "geocode",
    description:
      "Sucht Orte, Straßen, Adressen, Geschäfte oder Wahrzeichen in OpenStreetMap (Nominatim) und liefert Koordinaten. " +
      "Beispiele: 'Bäckerei Müller, Bahnhofstraße, Freiburg', 'Hauptstraße 12, 79098 Freiburg', 'Kirche St. Martin Landshut'.",
    parameters: obj({
      query: { type: "string" },
      country_codes: { type: "string", description: "Kommagetrennte ISO-3166-1 alpha-2 Codes zum Eingrenzen, z.B. 'de,at' - oder leer" },
      limit: { type: "integer", description: "1-10" },
    }, ["query"]),
  },
  {
    type: "function",
    name: "reverse_geocode",
    description: "Liefert Adresse/Ortsname zu Koordinaten. Nutze es, um einen Kandidatenpunkt zu prüfen.",
    parameters: obj({
      lat: { type: "number" },
      lon: { type: "number" },
      zoom: { type: "integer", description: "3 (Land) bis 18 (Gebäude)" },
    }, ["lat", "lon"]),
  },
  {
    type: "function",
    name: "overpass_query",
    description:
      "Führt eine Overpass-QL-Abfrage auf OpenStreetMap aus, um Hypothesen zu verifizieren oder Orte mit " +
      "Merkmals-Kombinationen zu finden (z.B. Apotheke mit Namen X in Stadt Y, Bushaltestelle namens Z, Straße X nahe " +
      "Straße Y). Immer mit Gebiets- oder around-Filter und begrenzter Ausgabe, z.B.:\n" +
      '[out:json][timeout:25];area["ISO3166-1"="DE"][admin_level=2]->.a;nwr["shop"="bakery"]["name"~"Müller",i](area.a);out center 30;\n' +
      '[out:json][timeout:25];way["highway"]["name"="Lindenweg"](around:3000,48.13,11.57);out center 20;',
    parameters: obj({ query: { type: "string" }, purpose: { type: "string" } }, ["query"]),
  },
  {
    type: "function",
    name: "sun_position",
    description:
      "Berechnet Sonnenstand (Azimut ab Norden im Uhrzeigersinn, Höhe) für Ort und UTC-Zeit, inkl. Schattenrichtung und " +
      "Schattenlänge pro Meter Objekthöhe. Nützlich, um Schatten im Bild gegen Kandidatenorte zu prüfen.",
    parameters: obj({
      lat: { type: "number" },
      lon: { type: "number" },
      datetime_utc: { type: "string", description: "ISO 8601, z.B. 2024-06-21T14:30:00Z" },
    }),
  },
  {
    type: "function",
    name: SUBMIT_TOOL,
    description: "Gibt das Endergebnis ab. Genau einmal am Ende aufrufen. Alle Texte auf Deutsch.",
    parameters: obj({
      summary: { type: "string", description: "2-5 Sätze: wo, und die entscheidenden Belege" },
      precision: { type: "string", enum: PRECISION_LEVELS },
      country: { type: "string" },
      region: { type: "string" },
      city: { type: "string" },
      best_guess: obj(LOCATION),
      candidates: {
        type: "array",
        description: "Alternative Orte (ohne best_guess), absteigend nach Wahrscheinlichkeit, max. 5",
        items: obj({ ...LOCATION, rationale: { type: "string" } }),
      },
      clues: {
        type: "array",
        description: "Alle verwerteten Hinweise",
        items: obj({
          category: { type: "string", enum: CLUE_CATEGORIES },
          description: { type: "string", description: "Was im Bild zu sehen ist" },
          implication: { type: "string", description: "Was das über den Ort verrät" },
          strength: { type: "string", enum: STRENGTHS },
          box: { type: "array", items: { type: "number" }, description: "[x_min, y_min, x_max, y_max] in 0-1 Bildkoordinaten, oder [] wenn nicht lokalisierbar" },
        }),
      },
      text_found: { type: "array", items: { type: "string" }, description: "Alle im Bild gelesenen Texte" },
      verification: { type: "string", description: "Was mit Karten-/Websuche bestätigt oder widerlegt wurde" },
    }, ["summary", "precision", "country", "region", "city", "best_guess", "candidates", "clues", "text_found", "verification"]),
  },
];

export function buildTools(webSearch) {
  return webSearch ? [...FUNCTION_TOOLS, { type: "google_search" }] : [...FUNCTION_TOOLS];
}

export class ToolInputError extends Error {}

function num(inp, key, lo, hi) {
  const v = inp[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolInputError(`'${key}' muss eine Zahl sein`);
  if ((lo != null && v < lo) || (hi != null && v > hi)) throw new ToolInputError(`'${key}' muss zwischen ${lo} und ${hi} liegen`);
  return v;
}

function str(inp, key, required = true) {
  const v = inp[key] ?? "";
  if (typeof v !== "string") throw new ToolInputError(`'${key}' muss ein Text sein`);
  if (required && !v.trim()) throw new ToolInputError(`'${key}' darf nicht leer sein`);
  return v;
}

const clamp01 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

export function normalizeBox(x0, y0, x1, y1) {
  const xs = [clamp01(x0), clamp01(x1)].sort((a, b) => a - b);
  const ys = [clamp01(y0), clamp01(y1)].sort((a, b) => a - b);
  return [xs[0], ys[0], xs[1], ys[1]];
}

function cleanLocation(loc, field) {
  if (!loc || typeof loc !== "object") throw new ToolInputError(`'${field}' fehlt`);
  const radius = typeof loc.radius_km === "number" && Number.isFinite(loc.radius_km) && loc.radius_km > 0 ? loc.radius_km : 50;
  const cleaned = {
    name: String(loc.name || "").trim() || "Unbenannter Ort",
    lat: num(loc, "lat", -90, 90),
    lon: num(loc, "lon", -180, 180),
    radius_km: Math.round(Math.min(radius, 20000) * 1000) / 1000,
    confidence: Math.round(clamp01(loc.confidence) * 1000) / 1000,
  };
  if ("rationale" in loc) cleaned.rationale = String(loc.rationale || "");
  return cleaned;
}

/** Check and normalize a submit_result payload. Throws ToolInputError with a fixable message. */
export function validateSubmission(inp) {
  if (!inp || typeof inp !== "object") throw new ToolInputError("Eingabe muss ein Objekt sein");
  if (!PRECISION_LEVELS.includes(inp.precision)) throw new ToolInputError(`'precision' muss einer von ${PRECISION_LEVELS.join(", ")} sein`);
  const result = {
    summary: str(inp, "summary"),
    precision: inp.precision,
    country: String(inp.country || ""),
    region: String(inp.region || ""),
    city: String(inp.city || ""),
    best_guess: cleanLocation(inp.best_guess, "best_guess"),
    candidates: [],
    clues: [],
    text_found: (Array.isArray(inp.text_found) ? inp.text_found : []).map(String).filter((t) => t.trim()),
    verification: String(inp.verification || ""),
  };
  for (const [i, cand] of (Array.isArray(inp.candidates) ? inp.candidates : []).entries()) {
    try {
      result.candidates.push(cleanLocation(cand, `candidates[${i}]`));
    } catch {
      // a broken alternative should not block the whole answer
    }
  }
  result.candidates = result.candidates.slice(0, 5);
  for (const clue of Array.isArray(inp.clues) ? inp.clues : []) {
    if (!clue || typeof clue !== "object") continue;
    const box = Array.isArray(clue.box) && clue.box.length === 4 && clue.box.every((v) => typeof v === "number")
      ? normalizeBox(...clue.box).map((v) => Math.round(v * 10000) / 10000)
      : [];
    result.clues.push({
      category: CLUE_CATEGORIES.includes(clue.category) ? clue.category : "sonstiges",
      description: String(clue.description || ""),
      implication: String(clue.implication || ""),
      strength: STRENGTHS.includes(clue.strength) ? clue.strength : "mittel",
      box,
    });
  }
  return result;
}

function parseUtc(value) {
  const text = value.trim();
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text + "Z");
  if (Number.isNaN(date.getTime())) throw new ToolInputError("'datetime_utc' ist kein ISO-8601-Zeitpunkt");
  return date;
}

/**
 * Runs client-side tools. `zoom(box, enhance)` must return
 * { data (base64 JPEG), width, height, sourceWidth, sourceHeight, thumbnail (data URL) }.
 */
export class ToolExecutor {
  // Stateless requests resend every crop, so the total is capped to stay well below request size limits.
  constructor({ zoom, osm, emit = () => {}, maxZooms = 24 }) {
    this.zoom = zoom;
    this.osm = osm;
    this.emit = emit;
    this.maxZooms = maxZooms;
    this.zoomCount = 0;
  }

  /** Returns { result, isError } where result is a string or an array of text/image content blocks. */
  async run(name, args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { result: JSON.stringify({ INVALID_INPUT: String(args).slice(0, 500) }), isError: true };
    }
    const handler = this[`tool_${name}`];
    if (typeof handler !== "function") return { result: `Unbekanntes Werkzeug: ${name}`, isError: true };
    try {
      return { result: await handler.call(this, args), isError: false };
    } catch (err) {
      if (err instanceof ToolInputError) return { result: `Ungültige Eingabe: ${err.message}`, isError: true };
      if (err instanceof OSMError) return { result: err.message, isError: true };
      return { result: `Fehler bei ${name}: ${err.name}: ${err.message}`, isError: true };
    }
  }

  async tool_zoom_image(args) {
    const box = normalizeBox(num(args, "x_min"), num(args, "y_min"), num(args, "x_max"), num(args, "y_max"));
    if (box[2] - box[0] <= 0 || box[3] - box[1] <= 0) throw new ToolInputError("Der Bereich hat keine Fläche (x_max > x_min und y_max > y_min nötig)");
    if (this.zoomCount >= this.maxZooms) throw new ToolInputError(`Zoom-Limit (${this.maxZooms}) erreicht – arbeite mit den bisherigen Ausschnitten weiter`);
    const crop = await this.zoom(box, Boolean(args.enhance));
    this.zoomCount += 1;
    this.emit("zoom", { index: this.zoomCount, box, purpose: String(args.purpose || ""), thumbnail: crop.thumbnail });
    const info =
      `Ausschnitt x ${box[0].toFixed(3)}-${box[2].toFixed(3)}, y ${box[1].toFixed(3)}-${box[3].toFixed(3)} ` +
      `= ${crop.sourceWidth}x${crop.sourceHeight} Originalpixel, vergrößert auf ${crop.width}x${crop.height}.`;
    return [
      { type: "text", text: info },
      { type: "image", mime_type: "image/jpeg", data: crop.data, resolution: "high" },
    ];
  }

  async tool_geocode(args) {
    const limit = Number.isInteger(args.limit) ? args.limit : 5;
    const results = await this.osm.geocode(str(args, "query"), str(args, "country_codes", false), limit);
    if (!results.length) return "Keine Treffer. Anders formulieren, Land eingrenzen oder Overpass/Websuche nutzen.";
    return JSON.stringify(results);
  }

  async tool_reverse_geocode(args) {
    const zoom = Number.isInteger(args.zoom) ? args.zoom : 18;
    return JSON.stringify(await this.osm.reverse(num(args, "lat", -90, 90), num(args, "lon", -180, 180), zoom));
  }

  async tool_overpass_query(args) {
    return JSON.stringify(await this.osm.overpass(str(args, "query")));
  }

  async tool_sun_position(args) {
    const when = parseUtc(str(args, "datetime_utc"));
    return JSON.stringify({ datetime_utc: when.toISOString(), ...sunPosition(num(args, "lat", -90, 90), num(args, "lon", -180, 180), when) });
  }
}

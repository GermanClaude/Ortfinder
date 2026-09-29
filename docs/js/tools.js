// Tools the geolocation agent can call: declarations for Gemini, input validation and execution.

import { OSMError, bearingDeg, destinationPoint, haversineKm, sunPosition } from "./geo.js";

export const SUBMIT_TOOL = "submit_result";
export const HYPOTHESIS_TOOL = "mark_hypothesis";
export const PRECISION_LEVELS = ["exakt", "strasse", "stadtteil", "stadt", "region", "land", "kontinent", "unbekannt"];
export const CLUE_CATEGORIES = [
  "text", "sprache", "verkehrszeichen", "schild", "strasse", "kennzeichen", "fahrzeug", "architektur",
  "infrastruktur", "menschen", "gegenstand", "marke", "vegetation", "tiere", "landschaft", "klima", "sonne",
  "innenraum", "wahrzeichen", "kultur", "symbol", "sonstiges",
];
const STRENGTHS = ["stark", "mittel", "schwach"];

const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required });
const LOCATION = {
  name: { type: "string", description: "Ortsbezeichnung, so genau wie belegt" },
  lat: { type: "number" },
  lon: { type: "number" },
  radius_km: { type: "number", description: "Unsicherheitsradius km" },
  confidence: { type: "number", description: "0-1: Wahrscheinlichkeit, dass der Ort im Radius liegt" },
};
const NUM = { type: "number" };

// Declarations are resent with every request, so descriptions are terse; the system prompt explains the method.
export const FUNCTION_TOOLS = [
  {
    type: "function",
    name: "zoom_image",
    description: "Ausschnitt des Originals in voller Auflösung, vergrößert (Schrift, Schilder, Kennzeichen, Details, Fernes). " +
      "Koordinaten 0-1 wie das Lineal (0 = links/oben). Mehrere parallel.",
    parameters: obj({
      x_min: NUM, y_min: NUM, x_max: NUM, y_max: NUM,
      enhance: { type: "boolean", description: "Kontrast/Schärfe anheben" },
      purpose: { type: "string", description: "was du erkennen willst" },
    }, ["x_min", "y_min", "x_max", "y_max", "purpose"]),
  },
  {
    type: "function",
    name: "geocode",
    description: "OpenStreetMap-Suche (Orte, Straßen, Adressen, Geschäfte, Wahrzeichen) → Koordinaten. Z.B. 'Bäckerei Müller, Bahnhofstraße, Freiburg'.",
    parameters: obj({
      query: { type: "string" },
      country_codes: { type: "string", description: "z.B. 'de,at' oder leer" },
      limit: { type: "integer", description: "1-10" },
    }, ["query"]),
  },
  {
    type: "function",
    name: "reverse_geocode",
    description: "Adresse/Ortsname zu Koordinaten.",
    parameters: obj({ lat: NUM, lon: NUM, zoom: { type: "integer", description: "3 Land … 18 Gebäude" } }, ["lat", "lon"]),
  },
  {
    type: "function",
    name: "overpass_query",
    description: "Overpass-QL auf OpenStreetMap für Merkmals-Kombinationen, immer mit around-/Gebietsfilter und Limit, z.B. " +
      "[out:json];way[\"highway\"][\"name\"=\"Lindenweg\"](around:3000,48.13,11.57);out center 20;",
    parameters: obj({ query: { type: "string" }, purpose: { type: "string" } }, ["query"]),
  },
  {
    type: "function",
    name: "map_view",
    description: "Luftbild (satellit) oder Detailkarte (karte) um einen Punkt: rotes Kreuz = Punkt, Meter-Gitter, Norden oben. " +
      "Zoom 17 ≈ 600 m, 18 ≈ 300 m, 19 ≈ 150 m breit. Mit view_bearing_deg/view_fov_deg wird das Sichtfeld eingezeichnet.",
    parameters: obj({
      lat: NUM, lon: NUM,
      zoom: { type: "integer", description: "15-19" },
      layer: { type: "string", enum: ["satellit", "karte"] },
      view_bearing_deg: { type: "number", description: "optional: Blickrichtung" },
      view_fov_deg: { type: "number", description: "optional: Bildwinkel" },
      purpose: { type: "string" },
    }, ["lat", "lon", "zoom", "layer"]),
  },
  {
    type: "function",
    name: "render_view",
    description: "3D-Nachbau vom Standpunkt (OSM-Gebäude, Straßen, Bäume, Gelände) im Seitenverhältnis des Fotos, Kompassskala " +
      "oben; zum Nachstellen von Standpunkt/Blick. texture \"satellit\" = Luftbild über dem Gelände, Gebäude als Drahtgitter.",
    parameters: obj({
      lat: NUM, lon: NUM,
      bearing_deg: { type: "number", description: "Blickrichtung, 0 = Nord" },
      fov_deg: { type: "number", description: "horizontaler Bildwinkel" },
      eye_height_m: { type: "number", description: "1.6 zu Fuß, 3-30 Fenster/Turm, 50-120 Drohne" },
      pitch_deg: { type: "number", description: "negativ = nach unten" },
      roll_deg: { type: "number", description: "meist 0" },
      texture: { type: "string", enum: ["modell", "satellit"] },
      purpose: { type: "string" },
    }, ["lat", "lon", "bearing_deg", "fov_deg"]),
  },
  {
    type: "function",
    name: "top_view",
    description: "Draufsicht: Foto per Sichtstrahlen aufs Gelände geklappt, neben dem Luftbild desselben Ausschnitts. " +
      "Deckungsgleich = Pose stimmt; verdreht → bearing, zu lang/kurz → pitch/eye_height, versetzt → Standpunkt. " +
      "style \"ueberlagert\" = übereinander.",
    parameters: obj({
      camera_lat: NUM, camera_lon: NUM, bearing_deg: NUM, fov_deg: NUM,
      pitch_deg: NUM, roll_deg: NUM,
      eye_height_m: { type: "number", description: "Kamerahöhe über Boden" },
      min_distance_m: { type: "number", description: "Vordergrund ausblenden (Fensterbank, eigenes Dach)" },
      max_distance_m: { type: "number", description: "Standard 1500; kleiner = schärfer" },
      photo_region: { type: "array", items: NUM, description: "optional: nur dieser Bildteil [x_min,y_min,x_max,y_max]" },
      style: { type: "string", enum: ["nebeneinander", "ueberlagert"] },
      purpose: { type: "string" },
    }, ["camera_lat", "camera_lon", "bearing_deg", "fov_deg"]),
  },
  {
    type: "function",
    name: "solve_camera",
    description: "Rückwärtsschnitt: exakte Kamerapose aus 3-8 Punkten, eindeutig im Foto UND im Luftbild (Hausecken am Boden, " +
      "Kreuzungen, Feldecken; sonst height_m). Gibt Richtung, Neigung, Schieflage, Bildwinkel, Höhe, ggf. Standpunkt, Fehler je Punkt, " +
      "dazu die Draufsicht.",
    parameters: obj({
      camera_lat: { type: "number", description: "vermuteter Standpunkt" },
      camera_lon: NUM,
      eye_height_m: { type: "number", description: "Schätzung" },
      fov_deg: { type: "number", description: "bekannter/typischer Bildwinkel" },
      fov_fixed: { type: "boolean", description: "true bei EXIF-Wert" },
      position_uncertainty_m: { type: "number", description: "Standard 25" },
      use_skyline: { type: "boolean", description: "skyline_match mitnutzen, Standard true" },
      points: {
        type: "array",
        items: obj({
          x: { type: "number", description: "0-1 im Foto" },
          y: { type: "number", description: "0-1 im Foto" },
          lat: NUM, lon: NUM,
          height_m: { type: "number", description: "über Boden, 0 = am Boden" },
          label: { type: "string" },
        }, ["x", "y", "lat", "lon"]),
      },
    }, ["camera_lat", "camera_lon", "points"]),
  },
  {
    type: "function",
    name: "skyline_match",
    description: "Bergkamm wie PeakFinder: Himmelslinie des Fotos gegen den Geländehorizont (bis 200 km). Gibt Richtung, Neigung, " +
      "Schieflage, Bildwinkel (±), prüft/sucht den Standpunkt, benennt Gipfel (Höhe, Entfernung, Richtung, Lage im Foto).",
    parameters: obj({
      camera_lat: NUM, camera_lon: NUM,
      bearing_deg: { type: "number", description: "grob; weglassen = rundum" },
      fov_deg: NUM, fov_fixed: { type: "boolean" },
      eye_height_m: NUM,
      search_radius_m: { type: "number", description: "Standpunkt suchen, 0-5000" },
      solve_height: { type: "boolean" },
      purpose: { type: "string" },
    }, ["camera_lat", "camera_lon"]),
  },
  {
    type: "function",
    name: "photos_nearby",
    description: "Fotos anderer nahe einem Punkt (Wikimedia Commons, Panoramax-Straßenbilder), nummeriert, wie Street View.",
    parameters: obj({ lat: NUM, lon: NUM, radius_m: { type: "integer", description: "50-5000, Standard 300" }, purpose: { type: "string" } }, ["lat", "lon"]),
  },
  {
    type: "function",
    name: "wiki_search",
    description: "Wikipedia-Suche mit Koordinaten (Wahrzeichen, Gebäude, Firmen, Texte im Bild).",
    parameters: obj({ query: { type: "string" }, languages: { type: "string", description: "z.B. 'de,en,fr'" } }, ["query"]),
  },
  {
    type: "function",
    name: "nearby_features",
    description: "Was OpenStreetMap im Umkreis eines Punktes kennt (Geschäfte, Haltestellen, Ampeln, Kirchen …) mit Entfernung und Richtung.",
    parameters: obj({ lat: NUM, lon: NUM, radius_m: { type: "integer", description: "20-1000, meist 100-250" } }, ["lat", "lon"]),
  },
  {
    type: "function",
    name: "street_geometry",
    description: "Verlauf einer Straße nahe einem Punkt: Punkte, Richtung je Abschnitt, nächster Straßenpunkt.",
    parameters: obj({
      name: { type: "string", description: "Straßenname wie in OSM" },
      lat: NUM, lon: NUM,
      radius_m: { type: "integer", description: "Standard 1500" },
    }, ["name", "lat", "lon"]),
  },
  {
    type: "function",
    name: "sun_position",
    description: "Sonnenstand (Azimut, Höhe), Schattenrichtung und -länge für Ort und UTC-Zeit.",
    parameters: obj({ lat: NUM, lon: NUM, datetime_utc: { type: "string", description: "ISO 8601" } }),
  },
  {
    type: "function",
    name: HYPOTHESIS_TOOL,
    description: "Zeigt deine aktuelle Vermutung auf der Karte des Nutzers. In Runde 1 und bei deutlicher Änderung, parallel zu anderem.",
    parameters: obj({
      label: { type: "string", description: "kurz" },
      camera_lat: NUM, camera_lon: NUM,
      radius_km: { type: "number", description: "Land ~300, Region ~50, Stadt ~5, Straße ~0.3" },
      subject_lat: NUM, subject_lon: NUM,
    }, ["label", "camera_lat", "camera_lon", "radius_km"]),
  },
  {
    type: "function",
    name: "bearing_distance",
    description: "Richtung (Grad ab Nord) und Entfernung (m) von A nach B.",
    parameters: obj({ from_lat: NUM, from_lon: NUM, to_lat: NUM, to_lon: NUM }),
  },
  {
    type: "function",
    name: "destination_point",
    description: "Punkt in Richtung bearing_deg und distance_m Metern von (lat, lon).",
    parameters: obj({ lat: NUM, lon: NUM, bearing_deg: NUM, distance_m: NUM }),
  },
  {
    type: "function",
    name: SUBMIT_TOOL,
    description: "Endergebnis, genau einmal am Ende. Texte auf Deutsch.",
    parameters: obj({
      summary: { type: "string", description: "2-5 Sätze: wo und warum" },
      precision: { type: "string", enum: PRECISION_LEVELS },
      country: { type: "string" },
      region: { type: "string" },
      city: { type: "string" },
      camera: obj({ ...LOCATION, name: { type: "string", description: "Standpunkt, z.B. 'Gehweg Hauptstraße vor Nr. 12'" } }),
      subject: obj({ name: { type: "string", description: "Hauptmotiv" }, lat: NUM, lon: NUM, radius_km: NUM }),
      view: obj({
        bearing_deg: { type: "number", description: "Blickrichtung ab Nord" },
        fov_deg: { type: "number", description: "horizontaler Bildwinkel" },
        distance_m: { type: "number", description: "Kamera → Motiv" },
        eye_height_m: NUM, pitch_deg: NUM, roll_deg: NUM,
      }, ["bearing_deg", "fov_deg", "distance_m"]),
      candidates: { type: "array", description: "Alternativen, max. 5", items: obj({ ...LOCATION, rationale: { type: "string" } }) },
      clues: {
        type: "array",
        items: obj({
          category: { type: "string", enum: CLUE_CATEGORIES },
          description: { type: "string", description: "was zu sehen ist" },
          implication: { type: "string", description: "was es verrät" },
          strength: { type: "string", enum: STRENGTHS },
          box: { type: "array", items: NUM, description: "[x_min,y_min,x_max,y_max] 0-1 oder []" },
        }),
      },
      text_found: { type: "array", items: { type: "string" } },
      verification: { type: "string", description: "was bestätigt/widerlegt wurde" },
    }, ["summary", "precision", "country", "region", "city", "camera", "subject", "view", "candidates", "clues", "text_found", "verification"]),
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

/** "nach Nordosten" etc. for an offset in metres east/north. */
function direction(east, north) {
  if (Math.hypot(east, north) < 0.5) return "(unverändert)";
  const names = ["Norden", "Nordosten", "Osten", "Südosten", "Süden", "Südwesten", "Westen", "Nordwesten"];
  const deg = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  return `nach ${names[Math.round(deg / 45) % 8]}`;
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
    camera: cleanLocation(inp.camera, "camera"),
    subject: null,
    view: null,
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
  const cam = result.camera;
  const subj = inp.subject;
  if (subj && typeof subj === "object" && Number.isFinite(subj.lat) && Number.isFinite(subj.lon) && Math.abs(subj.lat) <= 90 && Math.abs(subj.lon) <= 180) {
    const r = Number.isFinite(subj.radius_km) && subj.radius_km > 0 ? Math.min(subj.radius_km, 20000) : cam.radius_km;
    result.subject = { name: String(subj.name || "").trim() || "Motiv", lat: subj.lat, lon: subj.lon, radius_km: Math.round(r * 1000) / 1000 };
  }
  // Direction and distance: taken from the model, else derived from camera → subject.
  const v = inp.view && typeof inp.view === "object" ? inp.view : {};
  const derivedKm = result.subject ? haversineKm(cam.lat, cam.lon, result.subject.lat, result.subject.lon) : null;
  const bearing = Number.isFinite(v.bearing_deg) ? ((v.bearing_deg % 360) + 360) % 360
    : result.subject && derivedKm > 0.005 ? bearingDeg(cam.lat, cam.lon, result.subject.lat, result.subject.lon) : null;
  if (bearing != null) {
    const fov = Number.isFinite(v.fov_deg) ? Math.min(Math.max(v.fov_deg, 5), 180) : 65;
    const dist = Number.isFinite(v.distance_m) && v.distance_m > 0 ? v.distance_m : derivedKm != null && derivedKm > 0.005 ? derivedKm * 1000 : 150;
    result.view = {
      bearing_deg: Math.round(bearing * 10) / 10,
      fov_deg: Math.round(fov * 10) / 10,
      distance_m: Math.round(Math.min(dist, 200000)),
      eye_height_m: Number.isFinite(v.eye_height_m) ? Math.round(Math.min(Math.max(v.eye_height_m, 0.3), 3000) * 10) / 10 : 1.6,
      pitch_deg: Number.isFinite(v.pitch_deg) ? Math.round(Math.min(Math.max(v.pitch_deg, -90), 60) * 10) / 10 : 0,
      roll_deg: Number.isFinite(v.roll_deg) ? Math.round(Math.min(Math.max(v.roll_deg, -45), 45) * 10) / 10 : 0,
    };
  }
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
  constructor({
    zoom, mapView, renderView, topView, solveCamera, skylineMatch, web = null, osm, emit = () => {}, maxZooms = 24, maxMapViews = 12,
    maxRenders = 12, maxTopViews = 10, maxSkylines = 6, maxWeb = 16,
  }) {
    this.zoom = zoom;
    this.web = web; // { photosNearby(lat, lon, radiusM), wikiSearch(query, langs) }
    this.maxWeb = maxWeb;
    this.webCount = 0;
    this.skylineMatch = skylineMatch;
    this.maxSkylines = maxSkylines;
    this.skylineCount = 0;
    this.lastSkyline = null; // latest match, reused by solve_camera
    this.mapView = mapView;
    this.renderView = renderView;
    this.topView = topView;
    this.solveCamera = solveCamera;
    this.maxTopViews = maxTopViews;
    this.topViewCount = 0;
    this.osm = osm;
    this.emit = emit;
    this.maxZooms = maxZooms;
    this.maxMapViews = maxMapViews;
    this.maxRenders = maxRenders;
    this.zoomCount = 0;
    this.mapViewCount = 0;
    this.renderCount = 0;
  }

  /** Usage counters, saved with a checkpoint so limits still hold after resuming. */
  get counts() {
    return {
      zoom: this.zoomCount, mapView: this.mapViewCount, render: this.renderCount, topView: this.topViewCount, skyline: this.skylineCount, web: this.webCount,
    };
  }

  restoreCounts({ zoom = 0, mapView = 0, render = 0, topView = 0, skyline = 0, web = 0 } = {}) {
    this.webCount = web;
    this.zoomCount = zoom;
    this.mapViewCount = mapView;
    this.renderCount = render;
    this.topViewCount = topView;
    this.skylineCount = skyline;
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

  async tool_map_view(args) {
    if (!this.mapView) throw new ToolInputError("Luftbilder sind in dieser Umgebung nicht verfügbar");
    if (this.mapViewCount >= this.maxMapViews) throw new ToolInputError(`Limit für Luftbilder (${this.maxMapViews}) erreicht`);
    const lat = num(args, "lat", -85, 85);
    const lon = num(args, "lon", -180, 180);
    const zoom = Math.round(Math.min(Math.max(Number.isFinite(args.zoom) ? args.zoom : 18, 15), 19));
    const layer = args.layer === "karte" ? "karte" : "satellit";
    const opts = { lat, lon, zoom, layer };
    if (Number.isFinite(args.view_bearing_deg)) {
      opts.view = { bearing_deg: args.view_bearing_deg, fov_deg: Number.isFinite(args.view_fov_deg) ? Math.min(Math.max(args.view_fov_deg, 5), 150) : 60 };
    }
    const view = await this.mapView(opts);
    this.mapViewCount += 1;
    this.emit("mapview", { lat, lon, zoom, layer, purpose: String(args.purpose || ""), thumbnail: view.thumbnail });
    // Exact position of anything visible in the image, e.g. for solve_camera.
    const degN = view.metersPerPixel / 111195;
    const degE = view.metersPerPixel / (111195 * Math.cos((lat * Math.PI) / 180));
    const half = view.width / 2;
    const info =
      `${layer === "satellit" ? "Luftbild" : "Karte"} um ${lat.toFixed(6)}, ${lon.toFixed(6)} (rotes Kreuz), Zoom ${zoom}: ` +
      `${Math.round(view.spanM)} m breit, ${view.metersPerPixel.toFixed(2)} m pro Pixel, Norden oben.` +
      (view.gridM ? ` Gitter alle ${view.gridM} m, beschriftet in Metern Ost (O) / Nord (N) ab dem Kreuz.` : "") +
      ` Koordinaten eines Bildpunkts (px, py) im ${view.width}×${view.height}-Bild: lat = ${lat.toFixed(6)} − (py − ${half})·${degN.toExponential(4)}, ` +
      `lon = ${lon.toFixed(6)} + (px − ${half})·${degE.toExponential(4)}; oder per Gitter: 1 m Nord = ${(1 / 111195).toExponential(4)}°, ` +
      `1 m Ost = ${(degE / view.metersPerPixel).toExponential(4)}°.` +
      (opts.view ? ` Oranger Keil = Sichtfeld ${Math.round(opts.view.bearing_deg)}° ± ${Math.round(opts.view.fov_deg / 2)}°.` : "");
    return [{ type: "text", text: info }, { type: "image", mime_type: "image/jpeg", data: view.data, resolution: "high" }];
  }

  async tool_render_view(args) {
    if (!this.renderView) throw new ToolInputError("Der 3D-Nachbau ist in dieser Umgebung nicht verfügbar");
    if (this.renderCount >= this.maxRenders) throw new ToolInputError(`Limit für 3D-Nachbauten (${this.maxRenders}) erreicht`);
    const opts = {
      lat: num(args, "lat", -85, 85),
      lon: num(args, "lon", -180, 180),
      bearingDeg: ((num(args, "bearing_deg") % 360) + 360) % 360,
      fovDeg: Math.min(Math.max(num(args, "fov_deg"), 5), 150),
      eyeHeight: Number.isFinite(args.eye_height_m) ? Math.min(Math.max(args.eye_height_m, 0.3), 3000) : 1.6,
      pitchDeg: Number.isFinite(args.pitch_deg) ? Math.min(Math.max(args.pitch_deg, -89), 60) : 0,
      rollDeg: Number.isFinite(args.roll_deg) ? Math.min(Math.max(args.roll_deg, -45), 45) : 0,
      texture: args.texture === "satellit" ? "satellit" : "modell",
    };
    const view = await this.renderView(opts);
    this.renderCount += 1;
    this.emit("render", { lat: opts.lat, lon: opts.lon, bearing_deg: opts.bearingDeg, fov_deg: opts.fovDeg, purpose: String(args.purpose || ""), thumbnail: view.thumbnail });
    const s = view.stats;
    const parts = [
      `${s.texture === "satellit" ? "Luftbild-3D (Luftbild über dem Gelände, Gebäude als gelbe Drahtgitter)" : "3D-Nachbau"} ` +
        `vom Standpunkt ${opts.lat.toFixed(6)}, ${opts.lon.toFixed(6)} (Augenhöhe ${opts.eyeHeight} m), ` +
        `Blick ${Math.round(opts.bearingDeg)}°, Bildfeld ${Math.round(opts.fovDeg)}°, Neigung ${opts.pitchDeg}°${opts.rollDeg ? `, Schieflage ${opts.rollDeg}°` : ""}.`,
      s.buildings ? `${s.buildings} Gebäude sichtbar (Höhe bei ${s.heights_from_osm_pct} % aus OSM-Angaben, sonst geschätzt).` : "Keine Gebäude in OSM im Blickfeld.",
      s.building_ahead_m != null ? `Erstes Gebäude in Blickrichtung (Bildmitte): ${s.building_ahead_m} m.` : "",
      s.terrain ? `Geländemodell: Boden am Standpunkt ${s.ground_m} m ü. NN, Horizont bis ${Math.round(s.skyline_distance_m / 100) / 10} km.` : "Geländemodell nicht verfügbar – Boden flach angenommen.",
      view.note || "",
    ];
    return [{ type: "text", text: parts.filter(Boolean).join(" ") }, { type: "image", mime_type: "image/jpeg", data: view.data, resolution: "high" }];
  }

  async tool_top_view(args) {
    if (!this.topView) throw new ToolInputError("Die Draufsicht ist in dieser Umgebung nicht verfügbar");
    if (this.topViewCount >= this.maxTopViews) throw new ToolInputError(`Limit für Draufsichten (${this.maxTopViews}) erreicht`);
    const opt = (key, lo, hi, fallback) => (Number.isFinite(args[key]) ? Math.min(Math.max(args[key], lo), hi) : fallback);
    const eyeHeight = opt("eye_height_m", 0.3, 3000, 1.6);
    const opts = {
      lat: num(args, "camera_lat", -85, 85),
      lon: num(args, "camera_lon", -180, 180),
      bearingDeg: ((num(args, "bearing_deg") % 360) + 360) % 360,
      fovDeg: Math.min(Math.max(num(args, "fov_deg"), 5), 150),
      pitchDeg: opt("pitch_deg", -89, 60, 0),
      rollDeg: opt("roll_deg", -45, 45, 0),
      eyeHeight,
      // Right below a window or roof the photo mostly shows the building itself, not the ground.
      minDistM: opt("min_distance_m", 0, 20000, Math.max(8, eyeHeight * 2.5)),
      maxDistM: opt("max_distance_m", 20, 20000, 1500),
      region: Array.isArray(args.photo_region) && args.photo_region.length === 4 ? normalizeBox(...args.photo_region) : null,
      style: args.style === "ueberlagert" ? "ueberlagert" : "nebeneinander",
    };
    if (opts.maxDistM <= opts.minDistM + 5) throw new ToolInputError("max_distance_m muss deutlich größer als min_distance_m sein");
    if (opts.region && (opts.region[2] - opts.region[0] < 0.02 || opts.region[3] - opts.region[1] < 0.02)) {
      throw new ToolInputError("photo_region ist zu klein");
    }
    const view = await this.topView(opts);
    if (view.empty) return view.note;
    this.topViewCount += 1;
    this.emit("topview", { lat: opts.lat, lon: opts.lon, bearing_deg: opts.bearingDeg, fov_deg: opts.fovDeg, purpose: String(args.purpose || ""), thumbnail: view.thumbnail });
    const s = view.stats;
    const text = [
      `Draufsicht vom Standpunkt ${opts.lat.toFixed(6)}, ${opts.lon.toFixed(6)} (Augenhöhe ${opts.eyeHeight} m), Blick ${Math.round(opts.bearingDeg * 10) / 10}°, ` +
        `Bildwinkel ${Math.round(opts.fovDeg * 10) / 10}°, Neigung ${opts.pitchDeg}°${opts.rollDeg ? `, Schieflage ${opts.rollDeg}°` : ""}.`,
      `Ausschnitt ${s.width_m} × ${s.height_m} m (${s.m_per_px} m pro Pixel), Raster alle ${s.grid_m} m. Das Foto zeigt Boden von ${s.nearest_m} bis ${s.farthest_m} m ` +
        `(${s.covered_pct} % der Fläche).`,
      opts.style === "ueberlagert" ? "Luftbild mit dem Foto zu 60 % darüber." : "Links: das Foto auf den Boden projiziert; rechts: Luftbild desselben Ausschnitts.",
      s.terrain ? `Geländemodell: Boden am Standpunkt ${s.ground_m} m ü. NN.` : "Geländemodell nicht verfügbar – Boden flach angenommen.",
      s.imagery_tiles ? "" : "Luftbild nicht erreichbar.",
    ];
    return [{ type: "text", text: text.filter(Boolean).join(" ") }, { type: "image", mime_type: "image/jpeg", data: view.data, resolution: "high" }];
  }

  async tool_solve_camera(args) {
    if (!this.solveCamera) throw new ToolInputError("Der Rückwärtsschnitt ist in dieser Umgebung nicht verfügbar");
    if (!Array.isArray(args.points)) throw new ToolInputError("'points' muss eine Liste von Punktpaaren sein");
    const points = args.points.slice(0, 20).map((p, i) => {
      if (!p || typeof p !== "object") throw new ToolInputError(`Punkt ${i + 1} ist kein Objekt`);
      return {
        x: num(p, "x", 0, 1), y: num(p, "y", 0, 1), lat: num(p, "lat", -85, 85), lon: num(p, "lon", -180, 180),
        height_m: Number.isFinite(p.height_m) ? Math.min(Math.max(p.height_m, -50), 1000) : 0,
        label: typeof p.label === "string" ? p.label.slice(0, 80) : "",
      };
    });
    if (points.length < 3) throw new ToolInputError("Mindestens 3 Punktpaare nötig (besser 4–8, über das Bild verteilt)");
    const lat = num(args, "camera_lat", -85, 85);
    const lon = num(args, "camera_lon", -180, 180);
    const far = points.find((p) => haversineKm(lat, lon, p.lat, p.lon) > 60);
    if (far) throw new ToolInputError(`Punkt „${far.label || "?"}“ liegt über 60 km vom Standpunkt entfernt – Koordinaten prüfen`);
    const fovDeg = Number.isFinite(args.fov_deg) ? Math.min(Math.max(args.fov_deg, 5), 150) : null;
    // A good mountain-skyline match nearby holds the orientation; the points then fix standpoint and height.
    const sky = this.lastSkyline;
    const useSky = args.use_skyline !== false && sky && sky.confidence >= 0.5 && haversineKm(lat, lon, sky.lat, sky.lon) < 3;
    const sol = await this.solveCamera({
      points, lat, lon,
      eyeHeight: Number.isFinite(args.eye_height_m) ? Math.min(Math.max(args.eye_height_m, 0.3), 3000) : 1.6,
      fovDeg, fixFov: Boolean(fovDeg && args.fov_fixed),
      positionSigmaM: Number.isFinite(args.position_uncertainty_m) ? Math.min(Math.max(args.position_uncertainty_m, 2), 500) : 25,
      skyline: useSky ? sky.constraint : null,
    });
    const r1 = (v) => Math.round(v * 10) / 10;
    const bad = sol.points.filter((p) => p.error_pct == null || p.error_pct > Math.max(3, 2.5 * sol.rms_pct));
    const out = {
      camera: { lat: Math.round(sol.camera.lat * 1e6) / 1e6, lon: Math.round(sol.camera.lon * 1e6) / 1e6, eye_height_m: r1(sol.camera.eye_height_m), moved_m: r1(sol.camera.moved_m) },
      view: { bearing_deg: r1(sol.view.bearing_deg), pitch_deg: r1(sol.view.pitch_deg), roll_deg: r1(sol.view.roll_deg), fov_deg: r1(sol.view.fov_deg) },
      rms_pct_of_width: Math.round(sol.rms_pct * 100) / 100,
      points: sol.points.map((p, i) => ({ label: points[i].label || `Punkt ${i + 1}`, error_pct: p.error_pct == null ? null : Math.round(p.error_pct * 100) / 100 })),
      standpoint_solved: sol.solved_position,
      note: [
        sol.solved_position
          ? `Standpunkt mitberechnet: ${Math.round(sol.camera.moved_m)} m ${direction(sol.camera.east_m ?? 0, sol.camera.north_m ?? 0)} vom angenommenen` +
            (sol.position_by_fit ? " – nur weil die Punkte damit deutlich besser passen; übernimm das, wenn es zum Foto passt (z.B. anderes Fenster, anderer Gebäudeteil)." : ".")
          : `Standpunkt festgehalten (Punkte ${Math.round(sol.geometry.spreadDeg)}° breit, Entfernungsverhältnis ${r1(sol.geometry.depthRatio)} – für den Standpunkt braucht es ≥5 Punkte, >25° breit, nah und fern gemischt).`,
        bad.length ? `Verdächtig: ${bad.map((p) => sol.points.indexOf(p) + 1).map((n) => points[n - 1].label || `Punkt ${n}`).join(", ")} – vermutlich falsch zugeordnet.` : "",
        sol.rms_pct < 1.5 ? "Gute Übereinstimmung." : sol.rms_pct < 4 ? "Mäßige Übereinstimmung – Punkte prüfen." : "Schlechte Übereinstimmung – Zuordnung oder Standpunkt falsch.",
        useSky ? `Bergkamm aus skyline_match mitgenutzt: ${Math.round((sol.skyline_share ?? 0) * 100)} % der Himmelslinie liegen auf dem Geländehorizont.` : "",
      ].filter(Boolean).join(" "),
    };
    if (useSky) out.skyline_pct = Math.round((sol.skyline_share ?? 0) * 100);
    this.emit("solve", { lat: out.camera.lat, lon: out.camera.lon, bearing_deg: out.view.bearing_deg, fov_deg: out.view.fov_deg, rms_pct: out.rms_pct_of_width, points: points.length });
    // The check that normally follows comes right with it: the photo laid flat with the solved pose (saves a round).
    if (this.topView && sol.rms_pct < 5 && this.topViewCount < this.maxTopViews) {
      const far = Math.max(...points.map((p) => haversineKm(sol.camera.lat, sol.camera.lon, p.lat, p.lon) * 1000));
      const eye = Math.max(0.3, sol.camera.eye_height_m);
      const view = await this.topView({
        lat: sol.camera.lat, lon: sol.camera.lon, bearingDeg: sol.view.bearing_deg, fovDeg: sol.view.fov_deg,
        pitchDeg: sol.view.pitch_deg, rollDeg: sol.view.roll_deg, eyeHeight: eye,
        minDistM: Math.max(8, eye * 2.5), maxDistM: Math.min(Math.max(far * 1.3, 150), 3000), region: null, style: "nebeneinander",
      }).catch(() => null);
      if (view && !view.empty) {
        this.topViewCount += 1;
        this.emit("topview", { lat: out.camera.lat, lon: out.camera.lon, bearing_deg: out.view.bearing_deg, fov_deg: out.view.fov_deg, purpose: "Pose aus dem Rückwärtsschnitt", thumbnail: view.thumbnail });
        out.note += ` Dazu die Draufsicht mit dieser Pose (links Foto auf den Boden geklappt, rechts Luftbild, Raster ${view.stats.grid_m} m): ` +
          "liegen Wege, Feldgrenzen und Gebäudefüße deckungsgleich, stimmt die Pose; sonst mit top_view nachstellen.";
        return [{ type: "text", text: JSON.stringify(out) }, { type: "image", mime_type: "image/jpeg", data: view.data, resolution: "high" }];
      }
    }
    out.note += " Nächster Schritt: top_view mit genau diesen Werten.";
    return JSON.stringify(out);
  }

  async tool_skyline_match(args) {
    if (!this.skylineMatch) throw new ToolInputError("Der Bergkamm-Abgleich ist in dieser Umgebung nicht verfügbar");
    if (this.skylineCount >= this.maxSkylines) throw new ToolInputError(`Limit für Bergkamm-Abgleiche (${this.maxSkylines}) erreicht`);
    const fovDeg = Number.isFinite(args.fov_deg) ? Math.min(Math.max(args.fov_deg, 5), 150) : null;
    const opts = {
      lat: num(args, "camera_lat", -85, 85),
      lon: num(args, "camera_lon", -180, 180),
      bearingDeg: Number.isFinite(args.bearing_deg) ? ((args.bearing_deg % 360) + 360) % 360 : null,
      fovDeg, fixFov: Boolean(fovDeg && args.fov_fixed),
      eyeHeight: Number.isFinite(args.eye_height_m) ? Math.min(Math.max(args.eye_height_m, 0.3), 3000) : 1.6,
      searchRadiusM: Number.isFinite(args.search_radius_m) ? Math.min(Math.max(args.search_radius_m, 0), 5000) : 0,
      solveHeight: Boolean(args.solve_height),
    };
    const { match: m, image } = await this.skylineMatch(opts);
    this.skylineCount += 1;
    if (!m.ok) return m.note;
    const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
    const c = m.camera;
    this.lastSkyline = { lat: c.lat, lon: c.lon, confidence: m.confidence, constraint: { ...m.constraint, pose: m.pose } };
    const named = m.peaks.filter((p) => p.name);
    const peaks = [...named, ...m.peaks.filter((p) => !p.name)].slice(0, 20).map((p) => ({
      name: p.name || "(Gipfel ohne Namen)", ele_m: p.ele_m, km: r2(p.distance_m / 1000), bearing_deg: r1(p.bearing_deg),
      x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, ...(p.on_skyline ? { skyline: true } : {}),
    })).sort((a, b) => a.x - b.x);
    const standpoint = !c.searched_m ? "nur geprüft (search_radius_m 0)"
      : c.consistent ? `angenommener Standpunkt passt (±${Math.round(c.uncertainty_m)} m)` + (c.best_fit ? `; knapp besser, aber nicht signifikant: ${c.best_fit.lat.toFixed(6)}, ${c.best_fit.lon.toFixed(6)}` : "")
      : `Bergkamm passt deutlich besser ${Math.round(c.moved_m)} m ${direction(c.east_m, c.north_m)} (±${Math.round(c.uncertainty_m)} m)`;
    const out = {
      view: {
        bearing_deg: r2(m.pose.bearing), pitch_deg: r2(m.pose.pitch), roll_deg: r2(m.pose.roll), fov_deg: r2(m.pose.fov),
        sd_deg: Object.fromEntries(Object.entries(m.sd).map(([k, v]) => [k, r2(v)])),
      },
      camera: { lat: Math.round(c.lat * 1e6) / 1e6, lon: Math.round(c.lon * 1e6) / 1e6, eye_height_m: r1(c.eye_height_m), ground_m: Math.round(c.ground_m), standpoint },
      match_confidence: r2(m.confidence),
      fit: {
        on_skyline_pct: Math.round(m.fit.inlier_share * 100), rms_deg: r2(m.fit.rms_deg), skyline_width_pct: Math.round(m.fit.coverage * 100),
        relief_deg: r1(m.fit.relief_deg), ridges_km: [r1(m.skyline_km.median), r1(m.skyline_km.max)],
      },
      ...(m.alternative ? { next_best: { bearing_deg: r1(m.alternative.bearing_deg), fov_deg: r1(m.alternative.fov_deg) } } : {}),
      peaks,
      peak_names: m.peakSource || "keine (nur Geländemodell)",
      note: [
        m.confidence >= 0.9 ? "Eindeutige Zuordnung der Berge." : m.confidence >= 0.6 ? "Wahrscheinliche Zuordnung – mit dem Bild prüfen."
          : `Unsichere Zuordnung (begrenzt durch ${{ fit: "Übereinstimmung", relief: "flachen Horizont", coverage: "wenig sichtbare Himmelslinie", unique: "ähnlich gute andere Richtung" }[m.limit] || m.limit}).`,
        "Rot = Geländehorizont; liegt er auf der Himmelslinie, stimmen Richtung und Gegend (view übernehmen). Das Geländemodell weicht an " +
          "Graten 20–100 m ab, nahe Kämme passen nie ganz; den Standpunkt legt der Kamm nur grob fest.",
        "Exaktes Haus: solve_camera mit 3–8 Bodenpunkten – nutzt diesen Kamm automatisch (Punkte bestimmen dann Standpunkt und Höhe).",
        m.peakNote,
      ].filter(Boolean).join(" "),
    };
    this.emit("skyline", {
      lat: out.camera.lat, lon: out.camera.lon, bearing_deg: out.view.bearing_deg, fov_deg: out.view.fov_deg, confidence: m.confidence,
      peaks: named.slice(0, 8).map((p) => p.name), purpose: String(args.purpose || ""), thumbnail: image.thumbnail,
    });
    return [{ type: "text", text: JSON.stringify(out) }, { type: "image", mime_type: "image/jpeg", data: image.data, resolution: "high" }];
  }

  webAllowed() {
    if (!this.web) throw new ToolInputError("Die Internetsuche ist in dieser Umgebung nicht verfügbar");
    if (this.webCount >= this.maxWeb) throw new ToolInputError(`Limit für Internetsuchen (${this.maxWeb}) erreicht`);
    this.webCount += 1;
  }

  async tool_photos_nearby(args) {
    const lat = num(args, "lat", -85, 85);
    const lon = num(args, "lon", -180, 180);
    const radius = Math.round(Number.isFinite(args.radius_m) ? Math.min(Math.max(args.radius_m, 50), 5000) : 300);
    this.webAllowed();
    const res = await this.web.photosNearby(lat, lon, radius);
    const note = res.problems.length ? ` (${res.problems.join("; ")})` : "";
    if (!res.items.length) return `Keine frei verfügbaren Fotos im Umkreis von ${radius} m${note}. Radius vergrößern oder anderen Punkt prüfen.`;
    this.emit("photos", { lat, lon, radius_m: radius, count: res.items.length, purpose: String(args.purpose || ""), thumbnail: res.sheet?.thumbnail });
    const list = res.items.map((p, i) => `${i + 1}. ${p.source}: ${p.title || "Foto"}${p.description ? ` – ${p.description}` : ""} · ${p.distance_m} m, ` +
      `Richtung ${p.bearing_deg}°${p.heading != null ? `, Blick ${Math.round(p.heading)}°` : ""}${p.date ? `, ${p.date}` : ""} · ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`);
    const text = `Fotos anderer im Umkreis von ${radius} m um ${lat.toFixed(6)}, ${lon.toFixed(6)} (${res.found} gefunden, ${res.items.length} gezeigt)${note}:\n` +
      `${list.join("\n")}\nNummern wie im Bild. Gleiche Gebäude, Schilder, Bergformen = Ort bestätigt; Aufnahmeort des passenden Fotos als Standpunkt-Hinweis.`;
    return res.sheet ? [{ type: "text", text }, { type: "image", mime_type: "image/jpeg", data: res.sheet.data, resolution: "high" }] : text;
  }

  async tool_wiki_search(args) {
    const query = str(args, "query");
    this.webAllowed();
    const res = await this.web.wikiSearch(query, String(args.languages || ""));
    if (!res.results.length) return `Keine Wikipedia-Treffer für „${query}“${res.problems.length ? ` (${res.problems.join("; ")})` : ""}. Anders formulieren oder Sprache wechseln.`;
    return JSON.stringify({ query, results: res.results.slice(0, 10), ...(res.problems.length ? { problems: res.problems } : {}) });
  }

  async tool_nearby_features(args) {
    const radius = Number.isFinite(args.radius_m) ? args.radius_m : 150;
    const result = await this.osm.nearbyFeatures(num(args, "lat", -90, 90), num(args, "lon", -180, 180), radius);
    return JSON.stringify(result);
  }

  async tool_street_geometry(args) {
    const radius = Number.isFinite(args.radius_m) ? args.radius_m : 1500;
    const result = await this.osm.streetGeometry(str(args, "name"), num(args, "lat", -90, 90), num(args, "lon", -180, 180), radius);
    return JSON.stringify(result);
  }

  async tool_mark_hypothesis(args) {
    const hypo = {
      label: str(args, "label"),
      camera: { lat: num(args, "camera_lat", -90, 90), lon: num(args, "camera_lon", -180, 180) },
      radius_km: Math.min(Math.max(num(args, "radius_km"), 0.05), 5000),
    };
    if (Number.isFinite(args.subject_lat) && Number.isFinite(args.subject_lon)) {
      hypo.subject = { lat: num(args, "subject_lat", -90, 90), lon: num(args, "subject_lon", -180, 180) };
    }
    this.emit("hypothesis", hypo);
    return "Auf der Karte markiert.";
  }

  async tool_bearing_distance(args) {
    const [a, b, c, d] = [num(args, "from_lat", -90, 90), num(args, "from_lon", -180, 180), num(args, "to_lat", -90, 90), num(args, "to_lon", -180, 180)];
    return JSON.stringify({ bearing_deg: Math.round(bearingDeg(a, b, c, d) * 10) / 10, distance_m: Math.round(haversineKm(a, b, c, d) * 1000) });
  }

  async tool_destination_point(args) {
    const [lat, lon] = destinationPoint(num(args, "lat", -90, 90), num(args, "lon", -180, 180), num(args, "bearing_deg"), num(args, "distance_m", 0, 2e7) / 1000);
    return JSON.stringify({ lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 });
  }

  async tool_sun_position(args) {
    const when = parseUtc(str(args, "datetime_utc"));
    return JSON.stringify({ datetime_utc: when.toISOString(), ...sunPosition(num(args, "lat", -90, 90), num(args, "lon", -180, 180), when) });
  }
}

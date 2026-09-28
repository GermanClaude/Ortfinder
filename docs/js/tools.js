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
    name: "map_view",
    description:
      "Zeigt dir ein Luftbild (satellit) oder eine Detailkarte (karte) rund um einen Punkt – mit rotem Fadenkreuz in der " +
      "Mitte, Maßstab und Nordpfeil (Norden ist oben). Zum FEINORTEN: Gebäudeanordnung, Dachformen/-farben, Bäume, " +
      "Plätze, Kreuzungen und Straßenverlauf mit dem Foto vergleichen und so den genauen Standpunkt finden. " +
      "zoom 17 ≈ 600 m Bildbreite, 18 ≈ 300 m, 19 ≈ 150 m. Mit view_bearing_deg/view_fov_deg wird das Sichtfeld " +
      "der Kamera als Keil eingezeichnet – so prüfst du, welche Gebäude im Bild liegen müssten.",
    parameters: obj({
      lat: { type: "number" },
      lon: { type: "number" },
      zoom: { type: "integer", description: "15-19" },
      layer: { type: "string", enum: ["satellit", "karte"] },
      view_bearing_deg: { type: "number", description: "Optional: Blickrichtung der Kamera (0 = Nord, 90 = Ost)" },
      view_fov_deg: { type: "number", description: "Optional: horizontaler Bildwinkel in Grad" },
      purpose: { type: "string", description: "Was du vergleichen willst" },
    }, ["lat", "lon", "zoom", "layer"]),
  },
  {
    type: "function",
    name: "render_view",
    description:
      "3D-NACHBAU: Rendert, was eine Kamera an diesem Standpunkt sehen müsste – aus OpenStreetMap-Gebäuden " +
      "(Blöcke mit echter bzw. geschätzter Höhe), Straßen, Bäumen und einem Geländemodell mit Bergsilhouette, im " +
      "Seitenverhältnis des Fotos, mit Kompassskala oben. Vergleiche mit dem Foto: Gebäudekanten und -lücken, " +
      "Dachlinien, Straßenflucht, Horizont/Bergkamm. Passt es nicht, Standpunkt (±10–30 m) oder Blick (±5–10°) " +
      "ändern und erneut rendern – mehrere Varianten in EINER Runde parallel. Grenzen: keine Fenster/Fassaden-" +
      "details, Dachformen flach, Gebäudehöhen teils geschätzt. texture \"satellit\" legt das LUFTBILD über das " +
      "Gelände (wie Google Earth) und zeichnet Gebäude als gelbe Drahtgitter: ideal für Blicke über Felder, Dächer, " +
      "Täler und Ortschaften – Feldgrenzen, Wege, Hofplätze und Dachfarben direkt mit dem Foto vergleichen.",
    parameters: obj({
      lat: { type: "number", description: "Standpunkt der Kamera" },
      lon: { type: "number" },
      bearing_deg: { type: "number", description: "Blickrichtung (Bildmitte), 0 = Nord, 90 = Ost" },
      fov_deg: { type: "number", description: "horizontaler Bildwinkel in Grad (EXIF-Wert nutzen, falls angegeben)" },
      eye_height_m: { type: "number", description: "Kamerahöhe über Boden: 1.6 zu Fuß, 3–30 aus Fenster/Turm, 50–120 Drohne" },
      pitch_deg: { type: "number", description: "Neigung: 0 = waagrecht, negativ = nach unten" },
      roll_deg: { type: "number", description: "Schieflage: positiv = Horizont steigt nach rechts an (meist 0)" },
      texture: { type: "string", enum: ["modell", "satellit"], description: "modell (Standard) oder satellit (Luftbild über dem Gelände)" },
      purpose: { type: "string", description: "Was du prüfen willst" },
    }, ["lat", "lon", "bearing_deg", "fov_deg"]),
  },
  {
    type: "function",
    name: "top_view",
    description:
      "DRAUFSICHT: Klappt das Foto auf den Boden herunter – jeder Bildpunkt wird als Sichtstrahl bis zum Gelände " +
      "verfolgt – und zeigt es NEBEN dem Luftbild desselben Ausschnitts: Norden oben, gleiches Raster (A, B, C … / 1, 2, 3 …) " +
      "in beiden Hälften, roter Punkt = Standpunkt, gelbe Linien = linker und rechter Bildrand, Bögen = Entfernungen. " +
      "Stimmt die Kamerapose, liegen Straßen, Wege, Feldgrenzen, Hofplätze, Bäume und Hausgrundrisse deckungsgleich – so " +
      "prüfst du Standpunkt UND Blickrichtung auf wenige Meter. Alles über dem Boden (Dächer, Bäume, Masten) erscheint nach " +
      "hinten verlängert; vergleiche deshalb vor allem Bodenlinien und Gebäudefüße. Verdreht gegenüber dem Luftbild → " +
      "bearing_deg ändern; zu lang oder zu kurz gezogen → pitch_deg bzw. eye_height_m; seitlich versetzt → Standpunkt. " +
      "Am schnellsten erst solve_camera, dann top_view mit dessen Werten. style \"ueberlagert\" legt beides übereinander.",
    parameters: obj({
      camera_lat: { type: "number", description: "Standpunkt der Kamera" },
      camera_lon: { type: "number" },
      bearing_deg: { type: "number", description: "Blickrichtung (Bildmitte), 0 = Nord, 90 = Ost" },
      fov_deg: { type: "number", description: "horizontaler Bildwinkel (EXIF-Wert oder aus solve_camera)" },
      pitch_deg: { type: "number", description: "Neigung, negativ = nach unten (entscheidend bei Blicken ins Tal)" },
      roll_deg: { type: "number", description: "Schieflage, meist 0" },
      eye_height_m: { type: "number", description: "Kamerahöhe über Boden (Fenster im 3. Stock ≈ 10)" },
      min_distance_m: { type: "number", description: "Boden erst ab dieser Entfernung zeigen (Vordergrund wie Fensterbank/Dach ausblenden)" },
      max_distance_m: { type: "number", description: "bis zu dieser Entfernung (Standard 1500; kleiner = schärfer)" },
      photo_region: { type: "array", items: { type: "number" }, description: "Optional: nur diesen Bildteil verwenden [x_min, y_min, x_max, y_max] in 0-1" },
      style: { type: "string", enum: ["nebeneinander", "ueberlagert"] },
      purpose: { type: "string", description: "Was du prüfen willst" },
    }, ["camera_lat", "camera_lon", "bearing_deg", "fov_deg"]),
  },
  {
    type: "function",
    name: "solve_camera",
    description:
      "RÜCKWÄRTSSCHNITT (Photogrammetrie): Berechnet aus 4–8 Punkten, die du im Foto UND auf Luftbild/Karte eindeutig " +
      "wiedererkennst, die exakte Kamerapose – Blickrichtung, Neigung, Schieflage, Bildwinkel, Kamerahöhe und bei gut " +
      "verteilten Punkten (über 25° breit, nah und fern gemischt) auch den Standpunkt selbst. Gute Punkte liegen am BODEN: " +
      "Hausecken am Boden, Weg- und Straßenkreuzungen, Feldecken, Mast- und Baumfüße; oder mit bekannter Höhe über Boden " +
      "(height_m, z.B. Dachtraufe ≈ 3 m je Stockwerk). Verteile sie über das Bild (links/rechts, nah/fern). Die Antwort " +
      "nennt den Fehler je Punkt: Ein Punkt mit großem Fehler ist vermutlich falsch zugeordnet – korrigieren oder weglassen " +
      "und erneut rechnen. Koordinaten: aus map_view (Umrechnung steht in dessen Antwort), geocode oder overpass_query.",
    parameters: obj({
      camera_lat: { type: "number", description: "vermuteter Standpunkt" },
      camera_lon: { type: "number" },
      eye_height_m: { type: "number", description: "geschätzte Kamerahöhe über Boden" },
      fov_deg: { type: "number", description: "Optional: bekannter Bildwinkel (EXIF); mit fov_fixed: true festhalten" },
      fov_fixed: { type: "boolean" },
      position_uncertainty_m: { type: "number", description: "wie weit der Standpunkt sich verschieben darf (Standard 25)" },
      points: {
        type: "array",
        description: "Punktpaare Foto ↔ Karte",
        items: obj({
          x: { type: "number", description: "Position im Foto 0-1 (links → rechts)" },
          y: { type: "number", description: "Position im Foto 0-1 (oben → unten)" },
          lat: { type: "number" },
          lon: { type: "number" },
          height_m: { type: "number", description: "Höhe des Punktes über dem Boden (0 = am Boden)" },
          label: { type: "string", description: "was der Punkt ist" },
        }, ["x", "y", "lat", "lon"]),
      },
    }, ["camera_lat", "camera_lon", "points"]),
  },
  {
    type: "function",
    name: "nearby_features",
    description:
      "Listet, was in OpenStreetMap im Umkreis eines Punktes verzeichnet ist (Geschäfte, Haltestellen, Ampeln, " +
      "Zebrastreifen, Kirchen, Denkmäler, Straßennamen …) – jeweils mit Entfernung in Metern und Richtung ab dem Punkt. " +
      "Ideal, um einen Kandidaten-Standpunkt zu prüfen: Passt die Anordnung zu dem, was im Foto zu sehen ist?",
    parameters: obj({
      lat: { type: "number" },
      lon: { type: "number" },
      radius_m: { type: "integer", description: "20-1000, meist 100-250" },
    }, ["lat", "lon"]),
  },
  {
    type: "function",
    name: "street_geometry",
    description:
      "Liefert den genauen Verlauf einer Straße (Punkte, Richtung jedes Abschnitts in Grad) nahe einem Punkt und den " +
      "nächstgelegenen Straßenpunkt. Nutze es, um Blickrichtung und Standpunkt auf den tatsächlichen Straßenverlauf abzustimmen.",
    parameters: obj({
      name: { type: "string", description: "Straßenname genau wie in OSM, z.B. 'Hauptstraße'" },
      lat: { type: "number" },
      lon: { type: "number" },
      radius_m: { type: "integer", description: "Suchradius, Standard 1500" },
    }, ["name", "lat", "lon"]),
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
    name: HYPOTHESIS_TOOL,
    description:
      "Zeigt deine aktuelle Vermutung sofort auf der Karte des Nutzers (Zwischenstand). Rufe es in Runde 1 und immer, " +
      "wenn sich deine Vermutung deutlich ändert – parallel zu anderen Werkzeugen, damit keine Extra-Runde entsteht.",
    parameters: obj({
      label: { type: "string", description: "Kurz, z.B. 'Vermutung: Süddeutschland, Kleinstadt'" },
      camera_lat: { type: "number" },
      camera_lon: { type: "number" },
      radius_km: { type: "number", description: "Unsicherheit in km (Land ~300, Region ~50, Stadt ~5, Straße ~0.3)" },
      subject_lat: { type: "number", description: "Motiv, falls schon bekannt" },
      subject_lon: { type: "number" },
    }, ["label", "camera_lat", "camera_lon", "radius_km"]),
  },
  {
    type: "function",
    name: "bearing_distance",
    description: "Berechnet Richtung (Grad ab Norden, im Uhrzeigersinn) und Entfernung in Metern von Punkt A nach Punkt B.",
    parameters: obj({ from_lat: { type: "number" }, from_lon: { type: "number" }, to_lat: { type: "number" }, to_lon: { type: "number" } }),
  },
  {
    type: "function",
    name: "destination_point",
    description:
      "Berechnet den Punkt, der von (lat, lon) in Richtung bearing_deg nach distance_m Metern liegt. Beispiel: Kamera-Standpunkt " +
      "bestimmen, wenn das Motiv bekannt ist und man es aus Richtung Süd-West aus ~200 m sieht → vom Motiv 225° und 200 m.",
    parameters: obj({ lat: { type: "number" }, lon: { type: "number" }, bearing_deg: { type: "number" }, distance_m: { type: "number" } }),
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
      camera: obj({ ...LOCATION, name: { type: "string", description: "Standpunkt des Fotografen, z.B. 'Gehweg Hauptstraße vor Nr. 12'" } }),
      subject: obj({
        name: { type: "string", description: "Was hauptsächlich zu sehen ist, z.B. 'Stadtkirche St. Fabian'" },
        lat: { type: "number" },
        lon: { type: "number" },
        radius_km: { type: "number" },
      }),
      view: obj({
        bearing_deg: { type: "number", description: "Blickrichtung der Kamera, Grad ab Norden im Uhrzeigersinn" },
        fov_deg: { type: "number", description: "Horizontaler Bildwinkel (EXIF-Wert, sonst Schätzung: Handy ca. 65, Weitwinkel 90, Zoom 20)" },
        distance_m: { type: "number", description: "Entfernung Kamera → Motiv in Metern" },
        eye_height_m: { type: "number", description: "Kamerahöhe über Boden (1.6 zu Fuß, mehr aus Fenster/Turm/Drohne)" },
        pitch_deg: { type: "number", description: "Neigung der Kamera, 0 = waagrecht, negativ = nach unten" },
        roll_deg: { type: "number", description: "Schieflage (aus solve_camera), meist 0" },
      }, ["bearing_deg", "fov_deg", "distance_m"]),
      candidates: {
        type: "array",
        description: "Alternative Standpunkte (ohne camera), absteigend nach Wahrscheinlichkeit, max. 5",
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
    zoom, mapView, renderView, topView, solveCamera, osm, emit = () => {}, maxZooms = 24, maxMapViews = 12, maxRenders = 12, maxTopViews = 10,
  }) {
    this.zoom = zoom;
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
    return { zoom: this.zoomCount, mapView: this.mapViewCount, render: this.renderCount, topView: this.topViewCount };
  }

  restoreCounts({ zoom = 0, mapView = 0, render = 0, topView = 0 } = {}) {
    this.zoomCount = zoom;
    this.mapViewCount = mapView;
    this.renderCount = render;
    this.topViewCount = topView;
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
    const sol = await this.solveCamera({
      points, lat, lon,
      eyeHeight: Number.isFinite(args.eye_height_m) ? Math.min(Math.max(args.eye_height_m, 0.3), 3000) : 1.6,
      fovDeg, fixFov: Boolean(fovDeg && args.fov_fixed),
      positionSigmaM: Number.isFinite(args.position_uncertainty_m) ? Math.min(Math.max(args.position_uncertainty_m, 2), 500) : 25,
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
        "Nächster Schritt: top_view mit genau diesen Werten.",
      ].filter(Boolean).join(" "),
    };
    this.emit("solve", { lat: out.camera.lat, lon: out.camera.lon, bearing_deg: out.view.bearing_deg, fov_deg: out.view.fov_deg, rms_pct: out.rms_pct_of_width, points: points.length });
    return JSON.stringify(out);
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

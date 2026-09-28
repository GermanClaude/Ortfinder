// EXIF metadata. Embedded GPS is by far the most precise location source.

import exifr from "../vendor/exifr.esm.js";

const clean = (v) => {
  if (v == null) return null;
  const text = String(v).replace(/\0/g, "").trim();
  return text || null;
};

function gpsTime(raw) {
  const date = clean(raw.GPSDateStamp);
  const t = raw.GPSTimeStamp;
  if (!date || !Array.isArray(t) || t.length < 3) return null;
  const pad = (n) => String(Math.floor(n)).padStart(2, "0");
  return `${date.replace(/:/g, "-")}T${pad(t[0])}:${pad(t[1])}:${pad(t[2])}Z`;
}

/**
 * Camera, time and GPS info from the EXIF block. `input` is an ArrayBuffer/Uint8Array/File.
 * Keys are only present when the value exists; `gps` holds decimal `lat`/`lon`.
 */
const EXIF_OPTIONS = { tiff: true, exif: true, gps: true, xmp: true, iptc: false, icc: false, reviveValues: false, translateValues: true };

async function parse(input) {
  try {
    return (await exifr.parse(input, EXIF_OPTIONS)) || null;
  } catch {
    return null;
  }
}

/**
 * Fallback for containers exifr can't walk (e.g. HEIC/AVIF from some encoders): find the
 * "Exif\0\0" marker followed by a TIFF header and parse that TIFF block on its own.
 */
function findTiffBlock(bytes) {
  for (let i = 0; i + 10 < bytes.length; i++) {
    if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x78 || bytes[i + 2] !== 0x69 || bytes[i + 3] !== 0x66 || bytes[i + 4] !== 0 || bytes[i + 5] !== 0) continue;
    const t = i + 6;
    const motorola = bytes[t] === 0x4d && bytes[t + 1] === 0x4d && bytes[t + 2] === 0 && bytes[t + 3] === 0x2a;
    const intel = bytes[t] === 0x49 && bytes[t + 1] === 0x49 && bytes[t + 2] === 0x2a && bytes[t + 3] === 0;
    if (motorola || intel) return bytes.subarray(t);
  }
  return null;
}

const hasExifFields = (raw) => raw && ["Make", "Model", "DateTimeOriginal", "latitude", "GPSLatitude"].some((k) => k in raw);

export async function extractMetadata(input) {
  let raw = await parse(input);
  if (!hasExifFields(raw)) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
    const tiff = findTiffBlock(bytes);
    if (tiff) raw = (await parse(tiff)) || raw;
  }
  if (!raw) return { has_exif: false };
  const meta = {};
  const fields = {
    camera_make: raw.Make, camera_model: raw.Model, software: raw.Software, description: raw.ImageDescription,
    lens: raw.LensModel, taken_at: raw.DateTimeOriginal ?? raw.CreateDate ?? raw.ModifyDate, utc_offset: raw.OffsetTimeOriginal,
  };
  for (const [key, value] of Object.entries(fields)) {
    const v = clean(value);
    if (v) meta[key] = v;
  }
  const lat = raw.latitude;
  const lon = raw.longitude;
  // (0, 0) is what some apps write when they have no fix.
  if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    const gps = { lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7 };
    if (Number.isFinite(raw.GPSAltitude)) gps.altitude_m = Math.round((Number(raw.GPSAltitudeRef) === 1 ? -1 : 1) * raw.GPSAltitude * 10) / 10;
    if (Number.isFinite(raw.GPSImgDirection)) gps.direction_deg = Math.round(raw.GPSImgDirection * 10) / 10;
    meta.gps = gps;
  }
  const t = gpsTime(raw);
  if (t) meta.gps_time_utc = t;
  // Focal length gives the exact field of view; the compass direction (if stored) the viewing direction.
  const f35 = Number(raw.FocalLengthIn35mmFormat);
  if (f35 > 0) meta.focal_35mm = Math.round(f35);
  const f = Number(raw.FocalLength);
  if (f > 0) meta.focal_mm = Math.round(f * 100) / 100;
  if (Number.isFinite(raw.GPSImgDirection)) meta.direction_deg = Math.round((((raw.GPSImgDirection % 360) + 360) % 360) * 10) / 10;
  // PNG/WebP headers come back as data too; only real EXIF/GPS fields count.
  return { has_exif: Object.keys(meta).length > 0, ...meta };
}

/**
 * Horizontal field of view in degrees from the 35 mm-equivalent focal length. The equivalent is defined
 * on the 43.27 mm diagonal, so the image's aspect ratio decides how much of it is horizontal.
 */
export function horizontalFov(focal35, width, height) {
  if (!(focal35 > 0) || !(width > 0) || !(height > 0)) return null;
  const sensorWidth = (43.27 * width) / Math.hypot(width, height);
  return Math.round(((2 * Math.atan(sensorWidth / (2 * focal35)) * 180) / Math.PI) * 10) / 10;
}

/** Non-GPS metadata that is useful context (time for sun/shadow checks, camera model, lens). */
export function hintsForModel(meta) {
  const hints = [];
  const fov = horizontalFov(meta.focal_35mm, meta.width, meta.height);
  if (fov) {
    hints.push(`Brennweite laut EXIF: ${meta.focal_35mm} mm (Kleinbild-äquivalent) → horizontaler Bildwinkel ${fov}° ` +
      "(exakt, sofern das Foto nicht beschnitten wurde) – nutze diesen Wert für fov_deg und render_view.");
  } else if (meta.focal_mm) {
    hints.push(`Brennweite laut EXIF: ${meta.focal_mm} mm (echte Brennweite, ohne Kleinbild-Umrechnung).`);
  }
  if (meta.direction_deg != null) hints.push(`Kompassrichtung der Kamera laut EXIF: ${meta.direction_deg}° (Handy-Kompass, meist ±10–20° genau).`);
  if (meta.taken_at) hints.push(`Aufnahmezeit laut EXIF (Ortszeit der Kamera): ${meta.taken_at}${meta.utc_offset ? ` (UTC-Offset ${meta.utc_offset})` : ""}`);
  if (meta.gps_time_utc) hints.push(`GPS-Zeitstempel (UTC): ${meta.gps_time_utc}`);
  const camera = [meta.camera_make, meta.camera_model].filter(Boolean).join(" ");
  if (camera) hints.push(`Kamera: ${camera}`);
  if (meta.software) hints.push(`Software: ${meta.software}`);
  if (meta.description) hints.push(`Bildbeschreibung im EXIF: ${meta.description}`);
  return hints;
}

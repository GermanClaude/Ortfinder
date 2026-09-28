// Shared test data.

export const VALID_SUBMISSION = {
  summary: "Freiburg im Breisgau, Bahnhofstraße.",
  precision: "strasse",
  country: "Deutschland",
  region: "Baden-Württemberg",
  city: "Freiburg",
  camera: { name: "Bahnhofstraße, Freiburg", lat: 47.99, lon: 7.85, radius_km: 0.3, confidence: 0.8 },
  subject: { name: "Martinstor", lat: 47.9925, lon: 7.8495, radius_km: 0.05 },
  view: { bearing_deg: 350, fov_deg: 65, distance_m: 280 },
  candidates: [{ name: "Offenburg", lat: 48.47, lon: 7.94, radius_km: 5, confidence: 0.1, rationale: "ähnlich" }],
  clues: [{ category: "verkehrszeichen", description: "gelbes Ortsschild", implication: "Deutschland", strength: "stark", box: [0.75, 0.66, 0.8, 0.7] }],
  text_found: ["Bahnhofstr."],
  verification: "Straße per geocode bestätigt.",
};

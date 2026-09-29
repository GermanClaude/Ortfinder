import assert from "node:assert/strict";
import { test } from "node:test";

import { LiveStatus, nextFromText, thoughtTitle, toolActivity, typicalStep } from "../../docs/js/live.js";

test("the AI's own next step is read from its note, in German or English, with or without markdown", () => {
  assert.equal(nextFromText("Schild gelesen: Bahnhofstraße.\nNächster Schritt: Luftbild der Kreuzung prüfen."), "Luftbild der Kreuzung prüfen.");
  assert.equal(nextFromText("**Nächster Schritt:** Standpunkt per solve_camera"), "Standpunkt per solve_camera");
  assert.equal(nextFromText("- Als Nächstes: Overpass nach der Apotheke"), "Overpass nach der Apotheke");
  assert.equal(nextFromText("Next step: compare the aerial view"), "compare the aerial view");
  assert.equal(nextFromText("Kein Plan hier."), null);
  assert.equal(nextFromText("Nächster Schritt:   "), null);
  assert.ok(nextFromText(`Nächster Schritt: ${"x".repeat(400)}`).length <= 180);
  assert.equal(thoughtTitle("**Reading the Street Sign**\n\nI'm zooming in…"), "Reading the Street Sign");
  assert.equal(thoughtTitle("no heading"), null);
});

test("tools in plain words; the typical plan as the fallback", () => {
  assert.equal(toolActivity("geocode", { query: "Bahnhofstraße Freiburg" }), "sucht den Ort „Bahnhofstraße Freiburg“");
  assert.equal(toolActivity("map_view", { layer: "satellit", purpose: "Kreuzung vergleichen" }), "lädt ein Luftbild: Kreuzung vergleichen");
  assert.equal(toolActivity("zoom_image", {}), "zoomt auf ein Detail");
  assert.equal(toolActivity("zoom_image", { purpose: "Schild", ki_schaerfen: "Schild", sicherheit: 0.95 }), "zoomt und schärft (KI, mit Prüfung): Schild");
  assert.equal(toolActivity("top_view", { fov_deg: 60, horizon_y: 0.4 }), "legt das Foto als Draufsicht flach (Oberflächen, Meter-Raster)");
  assert.match(toolActivity("top_view", { camera_lat: 47.9, camera_lon: 7.8 }), /Luftbild/);
  assert.equal(toolActivity("new_tool"), "nutzt new_tool");
  assert.match(typicalStep(1, 10), /Zooms auf Schrift/);
  assert.equal(typicalStep(7, 10), "Ergebnis abgeben");
  assert.equal(typicalStep(9, 10), "weitere Prüfungen, dann Ergebnis abgeben");
  assert.equal(typicalStep(3, 3), "Ergebnis abgeben", "a short budget ends with the result");
});

test("now and next follow the run: thinking, tools in parallel, the AI's plan, retries", () => {
  let t = 0;
  const live = new LiveStatus({ clock: () => t });
  live.on("status", { message: "Lese Metadaten (EXIF) …" });
  assert.equal(live.now(), "Lese Metadaten (EXIF) …");
  assert.deepEqual(live.next(), { text: typicalStep(1, 10), source: "typisch" });

  live.on("step", { step: 1, max_steps: 10 });
  assert.equal(live.now(), "Die KI denkt nach (Runde 1/10) …");
  t = 4000;
  assert.equal(live.seconds(), 4);
  live.on("thinking", { text: "**Reading the sign**\nZooming in." });
  assert.equal(live.now(), "Die KI denkt nach (Runde 1/10): Reading the sign");
  assert.equal(live.seconds(), 0, "a new activity starts its own count");
  live.on("note", { text: "Deutsches Schild.\nNächster Schritt: Straße in Freiburg per Luftbild prüfen." });
  live.on("tool_call", { tool: "zoom_image", input: { purpose: "Schild lesen" } });
  live.on("tool_call", { tool: "geocode", input: { query: "Bahnhofstraße" } });
  live.on("tool_call", { tool: "geocode", input: { query: "Hauptstraße" } });
  live.on("tool_call", { tool: "wiki_search", input: { query: "Martinstor" } });
  assert.equal(live.now(), "Ortfinder zoomt: Schild lesen · sucht den Ort „Bahnhofstraße“ · sucht den Ort „Hauptstraße“ (+1 weitere)");
  assert.deepEqual(live.next(), { text: "Straße in Freiburg per Luftbild prüfen.", source: "ki" });
  live.on("tool_result", { tool: "geocode" });
  live.on("tool_result", { tool: "zoom_image" });
  assert.equal(live.now(), "Ortfinder sucht den Ort „Hauptstraße“ · sucht in Wikipedia nach „Martinstor“");

  live.on("step", { step: 2, max_steps: 10 });
  assert.match(live.now(), /Runde 2/);
  assert.equal(live.next().source, "ki", "the plan of the last round is what the AI works on now");
  live.on("warning", { message: "Gemini ist überlastet (HTTP 503) – neuer Versuch in 2 s …" });
  assert.equal(live.now(), "Gemini ist überlastet (HTTP 503) – neuer Versuch in 2 s …");
  live.on("step", { step: 3, max_steps: 10 });
  assert.deepEqual(live.next(), { text: typicalStep(3, 10), source: "typisch" }, "an old plan is not shown forever");
  live.on("tool_call", { tool: "solve_camera", input: {} });
  assert.deepEqual(live.next(), { text: typicalStep(4, 10), source: "typisch" }, "while tools run, the next round comes next");
});

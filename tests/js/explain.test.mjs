import assert from "node:assert/strict";
import { test } from "node:test";

import { explainMessage, reportUrl } from "../../docs/js/explain.js";

const fixes = (text, type) => (explainMessage(text, type)?.fixes || []).map(([action]) => action);

test("every kind of trouble message is explained, with the fitting fixes", () => {
  const cases = [
    ["render_view hat nach 120 s nicht geantwortet (Dienst hängt) – arbeite ohne dieses Ergebnis weiter.", "warning", /Hilfsdienst/, []],
    ["Die KI gibt seit 63 s kein Lebenszeichen – Ortfinder fragt dieselbe Runde neu an (Versuch 2 von 4) …", "warning", /keine Antwort zurück/, []],
    ["Die KI hat 4× nicht geantwortet. Der Dienst hängt gerade – bitte später erneut versuchen oder unter ⚙ einen anderen Anbieter wählen.", "error", /mehreren neuen Anfragen/, ["retry", "settings"]],
    ["Gemini ist gerade überlastet (HTTP 503): The model is overloaded. – neuer Versuch in 2 s …", "status", /mehr Anfragen, als er schafft/, ["settings"]],
    ["Der Gemini-API-Key ist ungültig. Einen neuen Key gibt es unter aistudio.google.com/apikey.", "error", /Schlüssel wird abgelehnt/, ["settings"]],
    ["Der DeepSeek-Key wird nicht angenommen (Authentication Fails). Unter ⚙ prüfen oder neu erstellen.", "error", /Schlüssel wird abgelehnt/, ["settings"]],
    ["Das Guthaben bei DeepSeek ist aufgebraucht – dort aufladen (auch mit PayPal) oder unter ⚙ einen kostenlosen Anbieter wählen.", "error", /Guthaben/, ["provider:puter", "settings"]],
    ["Tageslimit des kostenlosen Tarifs erreicht (20 Anfragen pro Tag).", "error", /pro Tag/, ["provider:puter", "settings"]],
    ["Für Claude fehlt noch dein API-Key. Unter ⚙ eintragen.", "warning", /noch kein Schlüssel/, ["settings", "provider:puter"]],
    ["Ortfinder ist im Hintergrund – die Anfrage wird wiederholt, sobald die Seite wieder sichtbar ist.", "status", /Handys halten Seiten an/, []],
    ["Gebäudedaten nicht verfügbar (Overpass ist gerade nicht verfügbar) – nur Gelände gezeigt.", "warning", /OpenStreetMap-Server/, []],
    ["Das Modell „x“ gibt es bei Mistral nicht (mehr). Unter ⚙ „Modelle laden“ tippen und ein anderes wählen.", "error", /gibt es bei diesem Anbieter nicht/, ["settings"]],
    ["Die KI hat innerhalb des Schrittlimits kein Ergebnis abgegeben (unter ⚙ mehr Runden erlauben).", "error", /Rundenbudget/, ["settings", "retry"]],
    ["Keine Verbindung zu OpenRouter (Internetverbindung prüfen).", "error", /Keine Verbindung zum Dienst/, ["retry"]],
    ["Google-Suche ist mit diesem Key/Tarif nicht verfügbar – weiter ohne Websuche.", "warning", /bezahlten Gemini-Tarif/, []],
    ["Analyse abgebrochen.", "error", /abgebrochen/, ["retry"]],
  ];
  for (const [text, type, why, expected] of cases) {
    const help = explainMessage(text, type);
    assert.ok(help, text);
    assert.match(help.why, why, text);
    assert.deepEqual(fixes(text, type), expected, text);
  }
  // Ordinary progress is not explained; an unknown error still gets help.
  assert.equal(explainMessage("Bild geladen (1600×1000). Starte KI-Analyse mit gemini-3.8-flash …", "status"), null);
  assert.deepEqual(fixes("Irgendetwas Seltsames ist passiert", "error"), ["retry", "report"]);
  const url = new URL(reportUrl("Fehler X", "gemini-3.8-flash"));
  assert.equal(url.origin + url.pathname, "https://github.com/GermanClaude/Ortfinder/issues/new");
  assert.match(url.searchParams.get("body"), /> Fehler X[\s\S]*keine privaten Fotos/);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commonsNearbyUrl, describeVisionError, languages, panoramaxUrl, parseCommons, parsePanoramax, parseVision, parseWiki, photosNearby,
  pickPhotos, reverseImageSearch, visionRequest, visionSummary, wikiSearch, wikiSearchUrl,
} from "../../docs/js/websearch.js";

const LAT = 48.8584;
const LON = 2.2945;

const COMMONS = {
  query: {
    pages: {
      1: {
        title: "File:Tour_Eiffel_vue_du_Champ-de-Mars.jpg", coordinates: [{ lat: 48.8556, lon: 2.2986 }],
        imageinfo: [{ thumburl: "https://upload.wikimedia.org/a/400px-t.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:T.jpg",
          extmetadata: { ImageDescription: { value: "<b>Eiffelturm</b> vom Marsfeld" }, DateTimeOriginal: { value: "2019-05-04 10:12:00" } } }],
      },
      2: { title: "File:Map.svg", coordinates: [{ lat: 48.858, lon: 2.294 }], imageinfo: [{ thumburl: "https://x/map.png" }] },
      3: { title: "File:Kein_Ort.jpg", imageinfo: [{ thumburl: "https://x/k.jpg" }] },
      4: { title: "File:Nah.jpg", coordinates: [{ lat: 48.8585, lon: 2.2946 }], imageinfo: [{ thumburl: "https://x/n.jpg", descriptionurl: "https://c/n" }] },
    },
  },
};

const PANORAMAX = {
  features: [
    { id: "a", geometry: { coordinates: [2.2950, 48.8586] }, properties: { "view:azimuth": 172, datetime: "2025-10-10T08:51:12Z" }, assets: { thumb: { href: "https://p/a.jpg" } } },
    { id: "b", geometry: { coordinates: [2.29501, 48.85861] }, properties: { "view:azimuth": 175 }, assets: { thumb: { href: "https://p/b.jpg" } } },
    { id: "c", geometry: { coordinates: [2.2990, 48.8600] }, properties: {}, assets: {} },
  ],
};

test("Commons and Panoramax: photos near a point, with distance, direction and camera heading", () => {
  const url = new URL(commonsNearbyUrl(LAT, LON, 25000));
  assert.equal(url.searchParams.get("ggsradius"), "10000", "the API allows at most 10 km");
  assert.equal(url.searchParams.get("origin"), "*");
  const commons = parseCommons(COMMONS, LAT, LON);
  assert.deepEqual(commons.map((p) => p.title), ["Nah", "Tour Eiffel vue du Champ-de-Mars"], "photos only, nearest first");
  assert.equal(commons[1].description, "Eiffelturm vom Marsfeld");
  assert.equal(commons[1].date, "2019-05-04");
  assert.ok(commons[1].distance_m > 400 && commons[1].distance_m < 460 && commons[1].bearing_deg > 130 && commons[1].bearing_deg < 150, JSON.stringify(commons[1]));
  assert.match(panoramaxUrl(LAT, LON, 300), /bbox=2\.290\d+,48\.855\d+,2\.298\d+,48\.861\d+&limit=30/);
  const streets = parsePanoramax(PANORAMAX, LAT, LON);
  assert.deepEqual(streets.map((p) => [p.source, p.heading]), [["Panoramax", 172], ["Panoramax", 175]]);
  // Street pictures right next to each other are one view; Commons photos come first.
  const picked = pickPhotos(commons, streets, 8);
  assert.deepEqual(picked.map((p) => p.source), ["Commons", "Commons", "Panoramax"]);
});

test("Wikipedia search: several languages, coordinates and short extracts", async () => {
  assert.deepEqual(languages("DE, en;fr it"), ["de", "en", "fr"]);
  assert.deepEqual(languages(""), ["de", "en"]);
  assert.match(wikiSearchUrl("fr", "Tour Eiffel"), /^https:\/\/fr\.wikipedia\.org\/w\/api\.php\?.*gsrsearch=Tour\+Eiffel.*prop=coordinates%7Cextracts%7Cinfo/);
  const json = { query: { pages: {
    9: { index: 2, title: "Champ-de-Mars", fullurl: "https://fr.wikipedia.org/wiki/Champ-de-Mars", extract: "Grand parc." },
    7: { index: 1, title: "Tour Eiffel", fullurl: "https://fr.wikipedia.org/wiki/Tour_Eiffel", extract: "La tour Eiffel est une tour de fer.", coordinates: [{ lat: 48.858222, lon: 2.2945 }] },
  } } };
  const parsed = parseWiki(json, "fr");
  assert.deepEqual(parsed.map((r) => r.title), ["Tour Eiffel", "Champ-de-Mars"]);
  assert.deepEqual([parsed[0].lat, parsed[0].lon], [48.85822, 2.2945]);
  // One language failing does not lose the others.
  const fetchImpl = async (url) => (url.includes("//de.") ? { ok: false, status: 429 } : { ok: true, json: async () => json });
  const res = await wikiSearch(fetchImpl, "Tour Eiffel", ["de", "fr"]);
  assert.equal(res.results.length, 2);
  assert.deepEqual(res.problems, ["de.wikipedia: HTTP 429"]);
});

test("photosNearby tolerates a failing source", async () => {
  const fetchImpl = async (url) => (url.includes("panoramax") ? Promise.reject(new TypeError("Failed to fetch")) : { ok: true, json: async () => COMMONS });
  const res = await photosNearby(fetchImpl, LAT, LON, 1000);
  assert.equal(res.items.length, 2);
  assert.match(res.problems[0], /Panoramax: Failed to fetch/);
});

test("reverse image search (Cloud Vision): request, parsing, summary and readable errors", async () => {
  const req = visionRequest("QUJD");
  assert.deepEqual(req.requests[0].features.map((f) => f.type), ["WEB_DETECTION", "LANDMARK_DETECTION"]);
  const answer = { responses: [{
    webDetection: {
      bestGuessLabels: [{ label: "eiffel tower paris" }],
      webEntities: [{ description: "Eiffel Tower", score: 1.2 }, { score: 0.3 }, { description: "Champ de Mars", score: 0.61234 }],
      pagesWithMatchingImages: [{ url: "https://example.org/paris", pageTitle: "<b>Paris</b> travel" }],
      fullMatchingImages: [{ url: "a" }], partialMatchingImages: [{ url: "b" }, { url: "c" }], visuallySimilarImages: [{ url: "d" }],
    },
    landmarkAnnotations: [{ description: "Eiffel Tower", score: 0.93, locations: [{ latLng: { latitude: 48.858461, longitude: 2.294351 } }] }],
  }] };
  const v = parseVision(answer);
  assert.deepEqual(v.labels, ["eiffel tower paris"]);
  assert.deepEqual(v.entities, [{ name: "Eiffel Tower", score: 1.2 }, { name: "Champ de Mars", score: 0.61 }]);
  assert.deepEqual(v.pages, [{ title: "Paris travel", url: "https://example.org/paris" }]);
  assert.equal(v.matches, 3);
  assert.deepEqual(v.landmarks, [{ name: "Eiffel Tower", score: 0.93, lat: 48.858461, lon: 2.294351 }]);
  const text = visionSummary(v);
  assert.match(text, /Erkannte Wahrzeichen: Eiffel Tower \(48\.85846, 2\.29435\), Sicherheit 0\.93/);
  assert.match(text, /Seiten mit demselben Bild:\n  - Paris travel – https:\/\/example\.org\/paris/);
  assert.equal(visionSummary(parseVision({ responses: [{}] })), "Keine Treffer (das Bild ist so nicht im Web zu finden).");

  let sent = null;
  const ok = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => answer }; };
  assert.equal((await reverseImageSearch(ok, "AIza+key", "QUJD")).landmarks[0].name, "Eiffel Tower");
  assert.equal(sent.url, "https://vision.googleapis.com/v1/images:annotate?key=AIza%2Bkey");
  assert.equal(sent.body.requests[0].image.content, "QUJD");
  const fail = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { message } }) });
  await assert.rejects(reverseImageSearch(fail(403, "Cloud Vision API has not been used in project 1 before or it is disabled."), "k", "x"), /noch nicht aktiviert/);
  await assert.rejects(reverseImageSearch(fail(403, "This API method requires billing to be enabled."), "k", "x"), /Abrechnung/);
  assert.equal(describeVisionError(400, { error: { message: "API key not valid. Please pass a valid API key." } }), "Cloud-Vision-Key ungültig.");
});

# Ortfinder

**Wo wurde dieses Foto aufgenommen?** Ortfinder ist eine Art extrem gründlicher GeoGuessr:
Du gibst ein beliebiges Foto hinein, und das Programm versucht so genau wie möglich
herauszufinden, wo es entstanden ist, bis hin zur Straße oder zum Standpunkt.

Ortfinder ist eine **reine Website** (HTML/JavaScript im Ordner [`docs/`](docs)) und läuft direkt auf
**GitHub Pages**, ganz ohne Server. Die KI-Analyse übernimmt **Google Gemini**.

![Oberfläche (Demo-Lauf)](docs/screenshot.png)

## Wie es funktioniert

1. **Metadaten (EXIF).** Viele Originalfotos von Handys (auch iPhone-HEIC) enthalten GPS-Koordinaten.
   Sind sie vorhanden, ist der Ort exakt bekannt. Aufnahmezeit und Kamera werden ebenfalls ausgelesen.
2. **KI-Bildanalyse mit Werkzeugen.** Gemini untersucht das Bild wie ein GeoGuessr-Profi bzw.
   OSINT-Analyst und geht dabei systematisch alle Hinweise durch:
   - **Schrift & Sprache:** Sonderzeichen, Wörter, Telefonvorwahlen, Postleitzahlen, Domains, Währung
   - **Verkehrszeichen:** Form, Farbe, Schriftart, Ortsschilder, Wegweiser, Straßennamensschilder, Ampeln
   - **regionale Schilder:** Läden, Gemeinden, Behörden, Vereine, Werbe- und Wahlplakate, Haltestellen
   - **Straße & Fahrzeuge:** Fahrseite, Markierungen, Leitpfosten, Kennzeichen, Automarken, Busse, Taxis
   - **Infrastruktur & Architektur:** Strommasten, Briefkästen, Hydranten, Laternen, Dächer, Fenster, Baustil
   - **Menschen (nur als Kontext):** Kleidung, Trachten, Uniformen, Trikots, Schriftzüge
   - **Gegenstände:** Produkte, Logos, Steckdosen, Schalter, Heizkörper, Möbel, Zeitschriften
   - **Natur:** Pflanzen, Bäume, Feldfrüchte, Boden, Berge, Tiere, Klima, Jahreszeit
   - **Sonne & Schatten:** Himmelsrichtung, Halbkugel, Tageszeit

   Dafür kann die KI selbstständig
   - **hineinzoomen** (`zoom_image`): Ausschnitte aus dem Original in voller Auflösung, vergrößert und
     auf Wunsch geschärft. So werden auch winzige Details lesbar;
   - **in OpenStreetMap suchen** (`geocode`, `reverse_geocode`): Gibt es die Bäckerei mit diesem Namen
     wirklich in dieser Straße?
   - **Merkmals-Kombinationen abfragen** (`overpass_query`): z.B. „Bushaltestelle X im Umkreis von 3 km
     um Straße Y“;
   - **mit Google suchen** (Google-Suche von Gemini, im bezahlten Tarif);
   - **den Sonnenstand berechnen** (`sun_position`), um Schatten gegen Kandidatenorte zu prüfen.

   Am Ende steht ein strukturiertes Ergebnis: bester Tipp mit Koordinaten, Unsicherheitsradius und
   Konfidenz, Alternativen, alle Hinweise (im Bild markiert), gelesene Texte und die Überprüfung.
3. **Blindtest.** Hat das Bild GPS-Daten, bekommt die KI diese *nicht* zu sehen. Am Ende zeigt
   Ortfinder, wie weit die reine Bildanalyse vom echten Ort entfernt lag. Das eignet sich gut zum
   Vorführen.

## Was realistisch ist

Eine Trefferquote von „nahezu 100 %“ schafft kein System der Welt, weil manche Fotos schlicht keine
Ortsinformation enthalten (weiße Wand, Nahaufnahme einer Blume).

| Bild | Zu erwarten |
|---|---|
| Originalfoto mit GPS in den Metadaten | exakt (auf wenige Meter) |
| Straßenszene mit lesbaren Schildern, Geschäften, Hausnummern | oft straßengenau |
| Landschaft/Stadt ohne Text, aber mit typischer Architektur und Vegetation | meist Land, oft Region |
| Innenraum, Baum vor neutralem Hintergrund, Nahaufnahme | eher Land oder Region, manchmal gar nichts |

Ortfinder gibt deshalb immer einen **Unsicherheitsradius** und eine **Konfidenz** an, statt Präzision
vorzutäuschen. Tipp: WhatsApp, Instagram & Co. entfernen die GPS-Daten. Für den Wow-Effekt am besten
Originaldateien direkt vom Handy verwenden.

## Auf GitHub Pages veröffentlichen

1. Im Repository auf GitHub: **Settings → Pages**.
2. Bei **Build and deployment → Source** „**Deploy from a branch**“ wählen.
3. Branch `main` (bzw. den Branch mit diesem Code) und Ordner **`/docs`** auswählen → **Save**.
4. Nach ca. einer Minute ist die Seite erreichbar unter
   **https://germanclaude.github.io/Ortfinder/**.

Lokal ausprobieren geht auch: `python -m http.server -d docs 8000` und dann <http://localhost:8000>
öffnen. Die Seite muss über `http(s)://` geladen werden; ein Doppelklick auf `index.html` reicht wegen
der JavaScript-Module nicht.

## Gemini-API-Key

1. Key kostenlos erstellen: <https://aistudio.google.com/apikey>. Ein Gemini-Key beginnt mit `AIza…`
   und hat 39 Zeichen. Eine 12-stellige Zahl ist eine Projektnummer, kein Key.
2. Auf der Website oben rechts auf **⚙** klicken, Key eintragen, **Speichern**.

**Den Key niemals in den Code oder ins Repository schreiben.** Eine GitHub-Pages-Seite ist öffentlich,
und Bots durchsuchen GitHub gezielt nach Keys. Ortfinder speichert den Key deshalb nur im
`localStorage` deines Browsers und schickt ihn ausschließlich direkt an Google.

Empfehlung: In der [Google Cloud Console](https://console.cloud.google.com/apis/credentials) den Key
einschränken: *Application restrictions → Websites* auf `https://germanclaude.github.io/*` (und für
lokale Tests `http://localhost:8000/*`), *API restrictions* auf die „Generative Language API“.

### Tarife

| | Kostenloser Tarif | Bezahlter Tarif |
|---|---|---|
| Gemini 3.8 Flash (Standard) | ✔ | ✔ |
| Gemini 3.1 Pro (stärker) | – | ✔ |
| Google-Suche | – (Ortfinder schaltet sie dann automatisch ab) | ✔ |
| Google darf Eingaben zur Produktverbesserung nutzen | **ja** | nein |

Im kostenlosen Tarif also keine privaten Fotos anderer Menschen hochladen.

Ortfinder ruft die [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
**zustandslos** auf (`store: false`). Die Bilder werden nicht als Unterhaltung bei Google gespeichert;
dafür wird der Verlauf bei jeder Runde vollständig mitgeschickt.

## Verantwortungsvoller Umgang

Ortfinder soll zeigen, wie viel ein einzelnes Foto verrät, auch um bewusster mit eigenen Bildern
umzugehen. Bitte nur eigene Bilder oder Bilder mit Einverständnis der Abgebildeten analysieren und
das Programm nicht nutzen, um Personen aufzuspüren. Die KI ist angewiesen, Personen nicht zu
identifizieren und keine Schlüsse aus Gesicht, Hautfarbe oder Körpermerkmalen zu ziehen. Menschen
zählen nur über Kleidung, Uniformen, Beschriftungen und Verhalten als Hinweis.

## Entwicklung

```
docs/                 die Website (wird von GitHub Pages ausgeliefert)
  index.html
  css/style.css
  js/app.js           Oberfläche und Ablauf
  js/agent.js         Gemini-Agent (Interactions API, Werkzeug-Schleife, Fehlerbehandlung)
  js/tools.js         Werkzeuge + Ergebnis-Schema und -Prüfung
  js/prompt.js        Anweisungen an die KI
  js/imaging.js       Bild laden (inkl. HEIC), Zoom-Ausschnitte, Schärfen, Raster
  js/metadata.js      EXIF/GPS auslesen
  js/geo.js           OpenStreetMap (Nominatim/Overpass), Entfernungen, Sonnenstand
  vendor/             Leaflet, exifr, heic2any (mit Lizenzen), kein CDN nötig
tests/js/             Unit-Tests der Website (Node)
tests/test_web_e2e.py Browser-Test der Website (Playwright, Gemini/OSM simuliert)
ortfinder/            ältere lokale Python-Version (mit Claude statt Gemini), siehe unten
```

Tests (alle ohne API-Key und ohne Internet):

```bash
npm test                                   # Website-Logik (Node ≥ 20)
pip install -r requirements-dev.txt
python -m playwright install chromium      # einmalig, für den Browser-Test
python -m pytest                           # Python-Version + Browser-Test der Website
```

### Lokale Python-Version (optional)

Im Ordner `ortfinder/` liegt zusätzlich eine lokale Variante mit Python-Server und Kommandozeile, die
Anthropic Claude statt Gemini verwendet (`pip install -r requirements.txt`,
`ANTHROPIC_API_KEY` in `.env`, dann `python -m ortfinder --web` oder `python -m ortfinder bild.jpg`).
Für GitHub Pages wird sie nicht gebraucht.

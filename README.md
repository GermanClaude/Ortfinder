# Ortfinder

**Wo wurde dieses Foto aufgenommen?** Ortfinder ist eine Art extrem gründlicher GeoGuessr:
Du gibst ein beliebiges Foto hinein, und das Programm versucht so genau wie möglich
herauszufinden, wo es entstanden ist, bis hin zur Straße oder zum Standpunkt.

Ortfinder ist eine **reine Website** (HTML/JavaScript im Ordner [`docs/`](docs)) und läuft direkt auf
**GitHub Pages**, ganz ohne Server. Die KI-Analyse läuft **kostenlos und ohne API-Key über
[Puter](https://puter.com)** (Standard: Gemini 3.8 Flash); wer möchte, kann stattdessen einen eigenen
Google-Gemini-Key nutzen.

![Oberfläche mit simulierter KI-Antwort (Foto: R.kaelcke, Wikimedia Commons, CC BY-SA 4.0)](docs/screenshot.png)

## Benutzung

**Direkt im Browser:** <https://germanclaude.github.io/Ortfinder/>

1. Ein Foto in das große Feld ziehen, mit Strg+V einfügen oder „Foto auswählen“ klicken.
2. Beim allerersten Foto einmalig auf **„Bei Puter anmelden (kostenlos)“** klicken und mit Google, Microsoft,
   Apple oder E-Mail anmelden. Danach läuft die Analyse automatisch weiter; beim nächsten Mal ist man
   schon angemeldet.
3. Live verfolgen, wohin die KI zoomt und was sie sucht. Ihre Zwischenstände erscheinen sofort auf der
   Karte, die von der Weltkarte aus immer weiter heranzoomt.
4. Am Ende zeigt die Karte zwei Punkte:
   - **📷 Standpunkt**: von hier wurde fotografiert (mit Unsicherheits-Areal),
   - **🎯 Motiv**: das ist auf dem Foto zu sehen,
   dazwischen das **Sichtfeld** (Blickrichtung und Bildwinkel). Darunter zeigt „Woran Ortfinder den Ort
   erkennt“ jeden Hinweis als Bildausschnitt: Verkehrszeichen, Schrift und Sprache, Symbole, Pflanzen,
   Architektur, Kleidung usw.

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

   Am Ende steht ein strukturiertes Ergebnis: Standpunkt der Kamera und Motiv mit Koordinaten,
   Blickrichtung, Unsicherheitsradius und Konfidenz, Alternativen, alle Hinweise (im Bild markiert und
   als Ausschnitte), gelesene Texte und die Überprüfung.

   Hautfarbe, Gesichter oder Körpermerkmale werden bewusst **nicht** als Hinweis verwendet: Sie verraten
   keinen Ort zuverlässig und würden auf Stereotype hinauslaufen. Menschen zählen nur über Kleidung,
   Uniformen, Trikots und Schriftzüge.
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
3. Den Branch mit diesem Code auswählen, Ordner **`/ (root)`** oder **`/docs`** (beides funktioniert:
   die Startseite im Hauptordner leitet direkt zur App weiter) → **Save**.
4. Nach ca. einer Minute ist die Seite erreichbar unter
   **https://germanclaude.github.io/Ortfinder/**.

Lokal ausprobieren geht auch: `python -m http.server -d docs 8000` und dann <http://localhost:8000>
öffnen. Die Seite muss über `http(s)://` geladen werden; ein Doppelklick auf `index.html` reicht wegen
der JavaScript-Module nicht.

## KI-Anbieter

### Puter (Standard): kostenlos, ohne API-Key

Ortfinder nutzt [Puter.js](https://docs.puter.com/) nach dem „User-Pays“-Prinzip: Jede Person meldet sich
einmal kostenlos bei Puter an und nutzt ihr **eigenes kostenloses Monatskontingent**. Für dich als
Betreiber entstehen keine Kosten, es gibt keinen Key im Code und keinen, der ablaufen oder gesperrt werden
kann. Eine Analyse mit Gemini 3.8 Flash kostet grob 5–10 Cent aus diesem Kontingent, die sparsamen
Modelle (unter ⚙ wählbar) deutlich weniger. Ist das Kontingent aufgebraucht, bietet Puter an, es
aufzustocken; Ortfinder zeigt dann einen Hinweis.

Warum kein fest eingebauter Key für alle? Ein Key im öffentlichen Code wird von Bots gefunden und
missbraucht; Google, OpenAI & Co. sperren solche Keys automatisch. Außerdem teilen sich dann alle Besucher
ein einziges Limit (bei Gemini kostenlos 20 Anfragen pro Tag), sodass es schon nach einer Analyse für alle
anderen nicht mehr funktionieren würde.

### Google Gemini mit eigenem API-Key (optional)

Unter ⚙ „Google Gemini – eigener API-Key“ wählen. Dann:

1. Key kostenlos erstellen: <https://aistudio.google.com/apikey>. Neue Gemini-Keys beginnen mit `AQ.`
   (ältere mit `AIza`). Eine 12-stellige Zahl ist eine Projektnummer, kein Key.
2. Auf der Website oben rechts auf **⚙** klicken, Key eintragen, **Speichern**.

**Den Key niemals in den Code oder ins Repository schreiben.** Eine GitHub-Pages-Seite ist öffentlich,
und Bots durchsuchen GitHub gezielt nach Keys. Ortfinder speichert den Key deshalb nur im
`localStorage` deines Browsers und schickt ihn ausschließlich direkt an Google.

Empfehlung: In der [Google Cloud Console](https://console.cloud.google.com/apis/credentials) den Key
einschränken: *Application restrictions → Websites* auf `https://germanclaude.github.io/*` (und für
lokale Tests `http://localhost:8000/*`), *API restrictions* auf die „Generative Language API“.

#### Gemini-Tarife

| | Kostenloser Tarif | Bezahlter Tarif |
|---|---|---|
| Gemini 3.8 Flash (Standard) | ✔ | ✔ |
| Gemini 3.1 Pro (stärker) | – | ✔ |
| Google-Suche | – (Ortfinder schaltet sie dann automatisch ab) | ✔ |
| Anfragen (Gemini 3.8 Flash) | **20 pro Tag**, 5 pro Minute: reicht für etwa 1–2 Analysen am Tag, jede dauert einige Minuten | deutlich mehr; eine Analyse kostet meist nur wenige Cent |
| Google darf Eingaben zur Produktverbesserung nutzen | **ja** | nein |

Im kostenlosen Tarif also keine privaten Fotos anderer Menschen hochladen. Meldet Google ein
Anfrage-Limit, wartet Ortfinder automatisch die angegebene Zeit ab und verteilt die weiteren
Anfragen entsprechend (im Protokoll sichtbar). Ist das Tageslimit erreicht, bricht Ortfinder mit einem
klaren Hinweis ab.

**Tempo:** Große Fotos gehen gleich mit vier hochaufgelösten Detail-Kacheln an die KI, die Werkzeuge einer
Runde laufen parallel, und die KI soll nach 2–4 Runden abgeben (höchstens 8, einstellbar unter ⚙).
Standard-Denktiefe ist „mittel“; „hoch“ ist gründlicher, aber langsamer. Im bezahlten Tarif dauert eine
Analyse so meist unter einer Minute; im kostenlosen bremst das Limit von 5 Anfragen pro Minute.

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
  js/puter-agent.js   Puter-Agent (Standard: kostenlos, ohne Key; OpenAI-Format mit Werkzeugen)
  js/agent.js         Gemini-Agent (eigener Key; Interactions API, Werkzeug-Schleife, Fehlerbehandlung)
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

### Beispiel-Analyse hinterlegen (optional)

Der Knopf „Beispiel ansehen“ erscheint, sobald unter `docs/demo/` eine aufgezeichnete echte Analyse liegt
(`beispiel.json` + das Foto). Nach einer Analyse steht der Lauf in der Browser-Konsole unter
`window.ortfinderLastRun`; das Format der Datei zeigt `test_example_runs_without_api_key` in
`tests/test_web_e2e.py`.

### Lokale Python-Version (optional)

Im Ordner `ortfinder/` liegt zusätzlich eine lokale Variante mit Python-Server und Kommandozeile, die
Anthropic Claude statt Gemini verwendet (`pip install -r requirements.txt`,
`ANTHROPIC_API_KEY` in `.env`, dann `python -m ortfinder --web` oder `python -m ortfinder bild.jpg`).
Für GitHub Pages wird sie nicht gebraucht.

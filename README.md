# Ortfinder

**Wo wurde dieses Foto aufgenommen?** Ortfinder ist eine Art extrem gründlicher GeoGuessr:
Du gibst ein beliebiges Foto hinein, und das Programm versucht so genau wie möglich
herauszufinden, wo es entstanden ist, bis hin zur Straße oder zum Standpunkt.

![Oberfläche (Demo-Lauf)](docs/screenshot.png)

## Wie es funktioniert

Ortfinder kombiniert drei Stufen:

1. **Metadaten (EXIF).** Viele Originalfotos von Handys enthalten GPS-Koordinaten. Sind sie
   vorhanden, ist der Ort exakt bekannt. Ortfinder liest außerdem Aufnahmezeit und Kamera aus.
2. **KI-Bildanalyse mit Werkzeugen.** Ein Claude-Modell (Standard: `claude-opus-5`) untersucht das
   Bild wie ein GeoGuessr-Profi bzw. OSINT-Analyst und kann dabei selbstständig
   - **hineinzoomen** (`zoom_image`): Ausschnitte aus dem Original in voller Auflösung, vergrößert und
     auf Wunsch geschärft. So werden auch winzige Details lesbar: Schilder, Kennzeichen, Logos,
     Hausnummern, Steckdosen, der Blick aus einem Fenster;
   - **in OpenStreetMap suchen** (`geocode`, `reverse_geocode`): Gibt es die Bäckerei mit diesem
     Namen wirklich in dieser Straße?
   - **Merkmals-Kombinationen abfragen** (`overpass_query`): z.B. „Bushaltestelle X im Umkreis von
     3 km um Straße Y“;
   - **im Web suchen** (Websuche von Claude): Firmen, Vereine, Wahrzeichen, Veranstaltungen;
   - **den Sonnenstand berechnen** (`sun_position`): Schattenrichtung und -länge für Kandidatenorte
     prüfen, wenn die Aufnahmezeit bekannt ist.

   Das Modell sammelt Hinweise (Sprache, Schrift, Straßenmarkierungen, Architektur, Vegetation,
   Strommasten, Kennzeichen …), bildet Hypothesen vom Kontinent bis zur Straße, **überprüft sie mit
   echten Kartendaten** und gibt am Ende ein strukturiertes Ergebnis ab: bester Tipp mit Koordinaten,
   Unsicherheitsradius und Konfidenz, Alternativen, alle Hinweise (im Bild markiert) und gelesene Texte.
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

Ortfinder gibt deshalb immer einen **Unsicherheitsradius** und eine **Konfidenz** an, statt
Präzision vorzutäuschen.

Tipp: WhatsApp, Instagram & Co. entfernen die GPS-Daten. Für den Wow-Effekt am besten
Originaldateien direkt vom Handy verwenden.

## Installation

Voraussetzungen: Python 3.10 oder neuer und ein
[Anthropic API-Key](https://console.anthropic.com/). Ohne Key funktioniert nur die
Metadaten-Auswertung.

```bash
git clone https://github.com/germanclaude/ortfinder.git
cd ortfinder
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # Windows: copy .env.example .env
# dann in .env den ANTHROPIC_API_KEY eintragen
```

## Benutzung

### Weboberfläche

```bash
python -m ortfinder --web
```

Dann <http://127.0.0.1:8000> öffnen und ein Bild hineinziehen, mit **Strg+V** einfügen oder
auswählen (JPEG, PNG, WebP, HEIC). Du siehst live, wohin die KI zoomt, was sie sucht und wie sie
eingrenzt. Am Ende erscheinen Karte, Ergebnis und die im Bild markierten Hinweise (mit der Maus über
einen Hinweis fahren, dann wird er im Bild hervorgehoben).

### Kommandozeile

```bash
python -m ortfinder urlaubsfoto.jpg            # Zwischenschritte + Zusammenfassung
python -m ortfinder urlaubsfoto.jpg --json     # komplettes Ergebnis als JSON
python -m ortfinder urlaubsfoto.jpg --only-metadata
python -m ortfinder urlaubsfoto.jpg --effort max --no-web-search
```

## Einstellungen (`.env`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | API-Key (Pflicht für die Bildanalyse) |
| `ORTFINDER_MODEL` | `claude-opus-5` | Claude-Modell |
| `ORTFINDER_EFFORT` | `high` | Denkaufwand: `low`, `medium`, `high`, `xhigh`, `max` |
| `ORTFINDER_MAX_STEPS` | `30` | maximale Agenten-Runden pro Bild |
| `ORTFINDER_WEB_SEARCH` | `1` | Websuche an/aus |
| `ORTFINDER_WEB_SEARCH_MAX_USES` | `10` | maximale Websuchen pro Bild |
| `ORTFINDER_CONTACT` | – | Kontakt (E-Mail/URL) für den User-Agent bei OpenStreetMap; bitte setzen, laut Nominatim-Nutzungsrichtlinie |
| `ORTFINDER_OVERPASS_URL` | drei öffentliche Server | kommagetrennte Overpass-Server, es wird automatisch auf den nächsten ausgewichen |

**Kosten:** Jede Analyse ruft die kostenpflichtige Anthropic API mehrfach auf (typisch 5–20 Runden,
jeder Zoom ist ein weiteres Bild). Die bisherigen Runden werden per Prompt-Caching günstig
wiederverwendet. Websuchen kosten extra. `ORTFINDER_EFFORT=medium` und weniger `MAX_STEPS`
machen es günstiger. Die tatsächlichen Token-Zahlen stehen nach jeder Analyse unter dem Ergebnis.

Falls das Modell eine Anfrage ablehnt, springt automatisch ein von Anthropic empfohlenes
Ersatzmodell ein (Server-seitiger Fallback, `fallbacks: "default"`).

## Verantwortungsvoller Umgang

Ortfinder soll zeigen, wie viel ein einzelnes Foto verrät, auch um bewusster mit eigenen Bildern
umzugehen. Bitte nur eigene Bilder oder Bilder mit Einverständnis der Abgebildeten analysieren und
das Programm nicht nutzen, um Personen aufzuspüren. Die KI ist angewiesen, Personen im Bild nicht zu
identifizieren und sie nur als Kontext (z.B. Kleidung) zu nutzen.

## Entwicklung

```bash
pip install -r requirements-dev.txt
python -m pytest
```

Die Tests laufen ohne API-Key und ohne Internet (Modell und OpenStreetMap werden simuliert; ein Test
prüft zusätzlich über das echte Anthropic-SDK, was tatsächlich gesendet würde).

```
ortfinder/
  agent.py      Pipeline + Agenten-Schleife (Claude API, Tool-Aufrufe, Ergebnis)
  tools.py      Werkzeuge (Zoom, Geocoding, Overpass, Sonnenstand, Ergebnis-Schema)
  prompts.py    System-Prompt
  imaging.py    Bild laden (inkl. HEIC), drehen, zoomen, Raster
  metadata.py   EXIF/GPS auslesen
  geo.py        OpenStreetMap-Client, Entfernungen, Sonnenstand
  server.py     Weboberfläche (FastAPI, Live-Updates per Server-Sent Events)
  static/       Frontend (HTML/CSS/JS, Leaflet-Karte)
tests/
```

// Every error or trouble message in the log explained in plain words, with fixes where there is one.
// Rules are checked in order (the more specific first); a fix is an action the page carries out:
// "settings" (open the settings), "provider:<id>" (switch and start again), "retry" (start again with the
// same photo), "pick" (choose another photo), "report" (prefilled GitHub issue) or a link.

const RULES = [
  {
    test: /^(\w+) hat nach \d+ s nicht geantwortet/,
    why: "Ein Hilfsdienst aus dem Internet (Karten, Gebäude-, Höhen- oder Fotodaten) hat nicht rechtzeitig geantwortet. Die KI arbeitet ohne dieses eine Ergebnis weiter – du musst nichts tun.",
  },
  {
    test: /fehlt noch (dein|der) API-Key|fehlt noch der API-Key/,
    why: "Für diesen Anbieter ist noch kein Schlüssel (API-Key) eingetragen. Ohne ihn kann die KI nicht arbeiten; ausgewertet wurden nur die GPS-/EXIF-Daten der Datei.",
    fixes: [["settings", "Key eintragen"], ["provider:puter", "Mit Puter starten (kostenlos, ohne Key)"]],
  },
  {
    test: /Tageslimit|requests per day|Anfragen (pro|am) Tag.*erreicht|per-day|daily/i,
    why: "Der kostenlose Tarif erlaubt nur eine bestimmte Zahl Anfragen pro Tag (Gemini: 20 je Modell, OpenRouter: 50). Das Limit gilt bis zum nächsten Tag; Ortfinder weicht, wo es geht, schon selbst auf ein anderes Modell aus.",
    fixes: [["provider:puter", "Mit Puter weitermachen (kostenlos)"], ["settings", "Anderen Anbieter wählen"]],
  },
  {
    test: /Guthaben.*aufgebraucht|Kontingent.*(aufgebraucht|erschöpft)|braucht OpenRouter Guthaben|insufficient|out of (funds|points)/i,
    why: "Das Guthaben bzw. das Gratis-Kontingent bei diesem Anbieter ist leer. Entweder dort aufladen oder einen kostenlosen Anbieter wählen.",
    fixes: [["provider:puter", "Mit Puter weitermachen (kostenlos)"], ["settings", "Anderen Anbieter wählen"]],
  },
  {
    test: /Key (ist ungültig|wird nicht angenommen)|API key not valid|Anmeldung ist ungültig|darf das nicht|Kein Zugriff/i,
    why: "Der eingetragene Schlüssel wird abgelehnt – meist vertippt, gelöscht, abgelaufen oder für diese Website bzw. dieses Modell gesperrt.",
    fixes: [["settings", "Key prüfen"]],
  },
  {
    test: /nicht geantwortet\. Der Dienst hängt/,
    why: "Die KI hat auch nach mehreren neuen Anfragen nicht geantwortet. Der Dienst steckt gerade fest; mit einem anderen Anbieter geht es meist sofort.",
    fixes: [["retry", "Noch einmal versuchen"], ["settings", "Anderen Anbieter wählen"]],
  },
  {
    test: /kein Lebenszeichen|antwortet nicht/,
    why: "Die Anfrage an die KI kam an, aber es kam keine Antwort zurück. Ortfinder fragt automatisch neu oder wechselt das Modell – meist geht es danach normal weiter.",
  },
  {
    test: /überlastet|ausgelastet|Serverfehler|HTTP 5\d\d|overloaded|UNAVAILABLE/i,
    why: "Der KI-Dienst bekommt gerade mehr Anfragen, als er schafft. Ortfinder versucht es automatisch erneut oder weicht auf ein anderes Modell aus.",
    fixes: [["settings", "Anderes Modell wählen"]],
  },
  {
    test: /Tarif-Limit|pro Minute|zu viele Anfragen|Rate-Limit|too many/i,
    why: "Der Tarif erlaubt nur wenige Anfragen pro Minute. Ortfinder wartet automatisch die nötige Zeit und macht dann weiter.",
  },
  {
    test: /im Hintergrund/,
    why: "Handys halten Seiten an, die gerade nicht sichtbar sind. Sobald Ortfinder wieder im Vordergrund ist, geht es von selbst weiter.",
  },
  {
    test: /Gebäudedaten nicht verfügbar|Overpass/,
    why: "Die kostenlosen OpenStreetMap-Server sind oft überlastet. Der 3D-Nachbau zeigt dann nur Gelände; die KI nutzt Luftbilder und die übrigen Hinweise.",
  },
  {
    test: /Nominatim/,
    why: "Die Adresssuche von OpenStreetMap erlaubt nur eine Anfrage pro Sekunde und ist manchmal überlastet. Die KI sucht dann anders weiter.",
  },
  {
    test: /Luftbild-Kacheln|Luftbild-Überzug/,
    why: "Die Luftbilder konnten gerade nicht geladen werden; der 3D-Nachbau wird ohne sie gezeichnet.",
  },
  {
    test: /Google-Suche/,
    why: "Die Google-Suche gehört zum bezahlten Gemini-Tarif. Ohne sie arbeitet Ortfinder ganz normal weiter.",
  },
  {
    test: /Bildersuche nicht möglich|Cloud Vision/,
    why: "Die automatische Bildersuche (Google Cloud Vision) ging nicht – meist Key, Abrechnung oder Kontingent. Die Analyse läuft ohne sie.",
    fixes: [["settings", "Bildersuche-Key prüfen"]],
  },
  {
    test: /Datenschutz|privacy|data policy/i,
    why: "OpenRouter leitet kostenlose Modelle nur weiter, wenn du es in deinen Datenschutz-Einstellungen erlaubst.",
    fixes: [["url:https://openrouter.ai/settings/privacy", "Datenschutz-Einstellungen öffnen"]],
  },
  {
    test: /Modell.*(nicht gefunden|nicht installiert|gibt es .* nicht|nicht verfügbar|nicht freigeschaltet)|Modelle laden/,
    why: "Das gewählte Modell gibt es bei diesem Anbieter nicht (mehr), es ist nicht freigeschaltet oder – beim eigenen PC – nicht installiert.",
    fixes: [["settings", "Anderes Modell wählen"]],
  },
  {
    test: /keine Bilder|Bildverständnis|keine Werkzeuge/,
    why: "Ortfinder braucht ein Modell, das Bilder sehen und Werkzeuge (zoomen, Karten, 3D) benutzen kann.",
    fixes: [["settings", "Anderes Modell wählen"]],
  },
  {
    test: /abgelehnt\.$|content_filter|Sicherheitsfilter/,
    why: "Das Modell hat die Analyse dieses Bildes abgelehnt (Sicherheitsfilter). Ein anderes Modell hat damit oft kein Problem.",
    fixes: [["settings", "Anderes Modell wählen"]],
  },
  {
    test: /Schrittlimit|Rundenlimit/,
    why: "Die KI hat ihr Rundenbudget aufgebraucht, ohne ein Ergebnis abzugeben. Mit mehr erlaubten Runden oder einem stärkeren Modell klappt es meist.",
    fixes: [["settings", "Mehr Runden erlauben"], ["retry", "Noch einmal versuchen"]],
  },
  {
    test: /zu groß geworden/,
    why: "Die Anfrage wurde mit allen Bildern zu groß für das Modell.",
    fixes: [["settings", "Weniger Runden einstellen"], ["retry", "Noch einmal versuchen"]],
  },
  {
    test: /Anmeldung|anmelden/,
    why: "Die Anmeldung beim Anbieter ist nicht abgeschlossen. Ohne sie kann die KI nicht starten.",
    fixes: [["retry", "Erneut anmelden und starten"]],
  },
  {
    test: /Keine Verbindung|nicht erreichbar|Failed to fetch|Netzwerk|Verbindung .* unterbrochen/i,
    why: "Keine Verbindung zum Dienst: Internet kurz weg, ein Werbeblocker oder eine Firewall blockiert ihn, oder der Dienst ist gerade nicht erreichbar. Ortfinder wiederholt Anfragen selbst.",
    fixes: [["retry", "Noch einmal versuchen"]],
  },
  {
    test: /Bild .*nicht (gelesen|geöffnet)|Format|HEIC|decode/i,
    why: "Das Bild konnte nicht geöffnet werden – Format nicht unterstützt oder Datei beschädigt.",
    fixes: [["pick", "Anderes Foto wählen"]],
  },
  {
    test: /abgebrochen\.$/,
    why: "Die Analyse wurde abgebrochen (von dir oder weil ein neues Foto gewählt wurde).",
    fixes: [["retry", "Neu starten"]],
  },
];

const FALLBACK = {
  why: "Ein unerwarteter Fehler. Oft hilft ein neuer Versuch; bleibt er, hilft eine kurze Meldung beim Beheben.",
  fixes: [["retry", "Noch einmal versuchen"], ["report", "Fehler melden"]],
};

/**
 * The explanation of a message: { why, fixes: [[action, label]] }, or null for messages that are not about
 * a problem. Errors always get one (the fallback, if no rule fits).
 */
export function explainMessage(text, type = "warning") {
  const rule = RULES.find((r) => r.test.test(String(text)));
  if (rule) return { why: rule.why, fixes: rule.fixes || [] };
  return type === "error" ? FALLBACK : null;
}

/** A prefilled GitHub issue for an unexpected error (the message only – no photo, no location). */
export function reportUrl(message, context = "") {
  const body = `**Fehlermeldung:**\n\n> ${String(message).slice(0, 800)}\n\n**Umgebung:** ${context}\n\n(Bitte keine privaten Fotos oder Orte angeben.)`;
  return `https://github.com/GermanClaude/Ortfinder/issues/new?${new URLSearchParams({ title: `Fehler: ${String(message).slice(0, 80)}`, body })}`;
}

// Step-by-step guides for every AI option, per device (shown in the settings and on anleitung.html).
// Markup in the texts: [link](https://…), `code` (tap to copy), **bold**.

export const DEVICES = [
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "android", label: "Android" },
  { id: "ios", label: "iPhone" },
];

/** Guess the visitor's device; the guide opens on its tab (the others stay one tap away). */
export function detectDevice(nav = globalThis.navigator) {
  const ua = nav?.userAgent || "";
  if (/android/i.test(ua)) return "android";
  // iPads report themselves as Macs, but have touch.
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && nav.maxTouchPoints > 1)) return "ios";
  if (/mac os x|macintosh/i.test(ua)) return "macos";
  return "windows";
}

const ORTFINDER = "[Ortfinder](https://germanclaude.github.io/Ortfinder/)";
const PASTE = {
  windows: "mit **Strg+V** einfügen",
  macos: "mit **⌘+V** einfügen",
  android: "lange in das Feld tippen → **Einfügen**",
  ios: "in das Feld tippen, noch einmal tippen → **Einfügen** (fragt das iPhone „Einfügen erlauben?“ → **Erlauben**)",
};
const CLICK = { windows: "klicken", macos: "klicken", android: "antippen", ios: "antippen" };
const BROWSER = { windows: "Chrome, Edge oder Firefox", macos: "Safari, Chrome oder Firefox", android: "Chrome", ios: "Safari" };
const OPEN_SETTINGS = (d) => `oben rechts auf **⚙** ${CLICK[d]} → bei „KI-Anbieter“`;
const PICK_PHOTO = {
  windows: "**Foto auswählen** klicken (oder ein Foto ins Fenster ziehen bzw. mit **Strg+V** einfügen).",
  macos: "**Foto auswählen** klicken (oder ein Foto ins Fenster ziehen bzw. mit **⌘+V** einfügen).",
  android: "**Foto auswählen** antippen → **Fotos**/**Galerie** (oder **Kamera** für ein neues Foto).",
  ios: "**Foto auswählen** antippen → **Fotomediathek** (oder **Foto aufnehmen**).",
};
const each = (fn) => Object.fromEntries(DEVICES.map(({ id }) => [id, fn(id)]));

export const GUIDES = {
  puter: {
    title: "Puter (kostenlos, ohne Key)",
    intro: "Nichts abzutippen: Beim ersten Foto meldest du dich einmal kostenlos bei Puter an, danach nutzt Ortfinder dein eigenes kostenloses Puter-Kontingent.",
    steps: each((d) => [
      `${ORTFINDER} in ${BROWSER[d]} öffnen.`,
      `In Ortfinder ${OPEN_SETTINGS(d)} **Puter** wählen → **Speichern**.`,
      PICK_PHOTO[d],
      d === "android" || d === "ios"
        ? "Puter öffnet sich (als Fenster oder neuer Tab): mit Google, Microsoft, Apple oder E-Mail anmelden – kostenlos."
        : "Ein kleines Puter-Fenster öffnet sich: mit Google, Microsoft, Apple oder E-Mail anmelden – kostenlos.",
      d === "ios"
        ? "Zurück zum Ortfinder-Tab (unten auf das Tab-Symbol tippen) – die Analyse läuft. Beim nächsten Foto bist du schon angemeldet."
        : d === "android"
          ? "Zurück zu Ortfinder (falls nötig über die Tab-Übersicht oben rechts) – die Analyse läuft. Beim nächsten Foto bist du schon angemeldet."
          : "Das Fenster schließt sich und die Analyse startet. Beim nächsten Foto bist du schon angemeldet.",
    ]),
    notes: {
      windows: "Kommt kein Fenster? Rechts in der Adressleiste auf das Symbol für blockierte Pop-ups klicken → **Pop-ups immer zulassen** → Foto erneut auswählen.",
      macos: "Blockiert Safari das Fenster: Menü **Safari** → **Einstellungen** → **Websites** → **Pop-up-Fenster** → bei germanclaude.github.io **Erlauben**. Oder Chrome verwenden.",
      android: "Blockiert Chrome das Fenster („Pop-up blockiert“): **Immer anzeigen** antippen. Oder Chrome **⋮** → **Einstellungen** → **Website-Einstellungen** → **Pop-ups und Weiterleitungen** → erlauben.",
      ios: "Passiert nach der Fotoauswahl nichts: iPhone-**Einstellungen** → **Apps** → **Safari** → **Pop-ups blockieren** ausschalten (ältere iOS-Versionen: Einstellungen → Safari).",
    },
  },

  gemini: {
    title: "Google Gemini (eigener Key)",
    intro: "Du brauchst ein Google-Konto. Der kostenlose Tarif reicht für etwa 6–7 Analysen am Tag (je 20 Anfragen für Gemini 3.8 und 3.7 Flash, Ortfinder wechselt selbst); das Limit setzt sich jeden Tag um 9 Uhr (deutsche Zeit) zurück.",
    steps: each((d) => [
      `[aistudio.google.com/apikey](https://aistudio.google.com/apikey) in ${BROWSER[d]} öffnen und mit deinem Google-Konto anmelden (beim ersten Mal die Nutzungsbedingungen bestätigen).` +
        (d === "android" ? " Ist die Seite zu klein: Chrome **⋮** → **Desktopwebsite**." : d === "ios" ? " Ist die Seite zu klein: in der Adressleiste **aA** → **Desktop-Website anfordern**." : ""),
      `**Create API key** („API-Schlüssel erstellen“) ${CLICK[d]}; wenn gefragt, ein Projekt auswählen oder neu anlegen.`,
      `Beim neuen Key auf das Kopier-Symbol ${CLICK[d]}. Der Key beginnt mit **AQ.** (ältere Keys mit **AIza**).`,
      `${ORTFINDER} öffnen → ${OPEN_SETTINGS(d)} **Google Gemini** wählen → **Speichern**.`,
      `Oben auf der Seite erscheint das Feld „Gemini-API-Key“: ${PASTE[d]} → **Speichern**. Fertig – jetzt ein Foto auswählen.`,
    ]),
    notes: {
      all: "Meldet Ortfinder „Tageslimit erreicht“: bis 9 Uhr warten oder so lange OpenRouter nutzen. Ein zweiter Key hilft nicht – das Limit gilt pro Google-Projekt, nicht pro Key.",
    },
  },

  openrouter: {
    title: "OpenRouter (kostenlos, 50 Anfragen am Tag)",
    intro: "Nichts abzutippen: Ortfinder holt sich den Schlüssel bei der Anmeldung selbst. Gut geeignet fürs Handy.",
    steps: each((d) => [
      `${ORTFINDER} in ${BROWSER[d]} öffnen → ${OPEN_SETTINGS(d)} **OpenRouter** wählen.`,
      `**Bei OpenRouter anmelden (kostenlos)** ${CLICK[d]}.`,
      "Auf der OpenRouter-Seite mit **Google**, **GitHub** oder **E-Mail** anmelden – beim ersten Mal wird dabei kostenlos ein Konto angelegt, ohne Kreditkarte." +
        (d === "android" || d === "ios" ? " Öffnet sich zwischendurch eine andere App (z.B. die Google-Kontoauswahl), danach zurück in den Browser wechseln." : ""),
      `Die Frage, ob Ortfinder einen Schlüssel bekommen darf, mit **Authorize** bestätigen.`,
      `Du landest wieder bei Ortfinder und siehst „✔ Bei OpenRouter angemeldet“. **Speichern** ${CLICK[d]} – fertig.`,
      PICK_PHOTO[d],
    ]),
    notes: {
      all: "Meldet Ortfinder „Datenschutz-Einstellungen“: [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy) öffnen und die kostenlosen Modelle erlauben. Die 50 Anfragen reichen für etwa 7–10 Analysen am Tag.",
      ios: "Meldet Ortfinder „Datenschutz-Einstellungen“: [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy) öffnen und die kostenlosen Modelle erlauben. Anmelden und analysieren im selben Browser (Safari) – eine Verknüpfung auf dem Home-Bildschirm hat eigene Einstellungen.",
    },
  },

  claude: {
    title: "Claude (Anthropic) – eigener API-Key, kostenpflichtig",
    intro: "Ein Claude-Abo (Free, Pro oder Max) kann Ortfinder nicht nutzen – Anthropic erlaubt das für fremde Websites nicht. Nötig ist ein API-Key aus der Claude Console. " +
      "Bezahlt wird pro Nutzung von Guthaben, das du vorher kaufst (ab 5 $). Richtwert: eine Analyse mit Opus 5 kostet etwa 0,50–2 $, Sonnet 5 und Haiku 4.5 sind günstiger.",
    steps: each((d) => [
      `[platform.claude.com](https://platform.claude.com) in ${BROWSER[d]} öffnen → mit Google anmelden oder E-Mail-Adresse eingeben und den Link aus der Bestätigungs-E-Mail öffnen. ` +
        "Du kannst dieselbe E-Mail wie bei claude.ai nehmen – das API-Guthaben ist trotzdem getrennt vom Abo.",
      "Den kurzen Einrichtungsdialog ausfüllen (Name; als Organisation genügt dein Name).",
      `Guthaben kaufen: [Settings → Billing](https://platform.claude.com/settings/billing) → **Buy credits** ${CLICK[d]} → Kreditkarte eintragen → Betrag wählen (mindestens 5 $) → kaufen. ` +
        "**Auto reload** ausgeschaltet lassen – dann wird nie mehr abgebucht als dein Guthaben.",
      `Key erstellen: [API Keys](https://platform.claude.com/settings/keys) → **Create Key** → als Name z.B. \`Ortfinder\` → bestätigen.`,
      `Den angezeigten Key (beginnt mit **sk-ant-**) mit **Copy** kopieren. Wichtig: Er wird nur dieses eine Mal angezeigt – sonst einfach einen neuen erstellen.`,
      `${ORTFINDER} öffnen → ${OPEN_SETTINGS(d)} **Claude (Anthropic)** wählen.`,
      `Im Feld „Claude-API-Key“: ${PASTE[d]}. Modell wählen (**Opus 5** = am genauesten) → **Speichern**. Fertig – jetzt ein Foto auswählen.`,
    ]),
    notes: {
      all: "Der Key bleibt nur in diesem Browser und geht nur an Anthropic. Wer ihn hat, kann dein Guthaben verbrauchen – nicht weitergeben; unter [API Keys](https://platform.claude.com/settings/keys) jederzeit löschbar. " +
        "Kostenbremse: unter [Limits](https://platform.claude.com/settings/limits) ein Monatslimit setzen. Was eine Analyse wirklich gekostet hat, zeigt [Usage](https://platform.claude.com/usage).",
      android: "Den Key kannst du direkt am Handy erstellen – die Claude Console funktioniert auch im Handy-Browser. Er bleibt nur in diesem Browser; nicht weitergeben. Kostenbremse: unter [Limits](https://platform.claude.com/settings/limits) ein Monatslimit setzen.",
      ios: "Den Key kannst du direkt am iPhone erstellen – die Claude Console funktioniert auch in Safari. Er bleibt nur in diesem Browser; nicht weitergeben. Kostenbremse: unter [Limits](https://platform.claude.com/settings/limits) ein Monatslimit setzen.",
    },
  },

  ollama: {
    title: "Eigener PC (Ollama) – unbegrenzt & kostenlos",
    intro: "Die KI läuft auf deinem Windows-PC oder Mac (mindestens 16 GB Arbeitsspeicher, am besten mit Grafikkarte oder Apple-Chip). Handys nutzen die KI des PCs über einen QR-Code.",
    steps: {
      windows: [
        "[ollama.com/download](https://ollama.com/download) öffnen → **Download for Windows** → die heruntergeladene Datei **OllamaSetup** öffnen → **Install**.",
        `${ORTFINDER} öffnen → oben rechts **⚙** → bei „KI-Anbieter“ **Eigener PC (Ollama)** wählen → [Startskript für Windows](ki/ortfinder-ki-windows.bat) herunterladen.`,
        "Im Ordner **Downloads** doppelt auf **ortfinder-ki-windows** klicken. Warnt Windows („Der Computer wurde durch Windows geschützt“): **Weitere Informationen** → **Trotzdem ausführen**.",
        "Beim ersten Start lädt das Skript das KI-Modell (ca. 8 GB, einige Minuten). Das schwarze Fenster offen lassen, solange du Ortfinder nutzt.",
        "Ortfinder öffnet sich von selbst (sonst unter ⚙ **Verbindung prüfen** klicken). Fragt der Browser, ob die Seite auf Apps/Geräte im lokalen Netzwerk zugreifen darf: **Zulassen**. Dann **Speichern** → Foto auswählen.",
        "Fürs Handy (optional, einmalig): **Windows-Taste** drücken → **Terminal** tippen → öffnen → `winget install Cloudflare.cloudflared` einfügen (Rechtsklick) → **Enter**. Danach das Startskript neu starten – es zeigt einen QR-Code für das Handy.",
      ],
      macos: [
        "[ollama.com/download](https://ollama.com/download) öffnen → **Download for macOS** → die ZIP-Datei öffnen → **Ollama** in den Ordner **Programme** ziehen → einmal starten (Lama-Symbol oben in der Menüleiste).",
        `${ORTFINDER} öffnen → oben rechts **⚙** → bei „KI-Anbieter“ **Eigener PC (Ollama)** wählen → [Startskript für Mac](ki/ortfinder-ki-mac-linux.sh) herunterladen.`,
        "**⌘+Leertaste** drücken → **Terminal** tippen → **Enter**. Dann `bash ~/Downloads/ortfinder-ki-mac-linux.sh` einfügen (hier klicken zum Kopieren, im Terminal **⌘+V**) → **Enter**.",
        "Beim ersten Start lädt das Skript das KI-Modell (ca. 8 GB, einige Minuten). Das Terminal offen lassen, solange du Ortfinder nutzt.",
        "Ortfinder öffnet sich von selbst (sonst unter ⚙ **Verbindung prüfen** klicken) → **Speichern** → Foto auswählen. Klappt die Verbindung in Safari nicht: Chrome oder Firefox nehmen.",
        "Fürs Handy (optional, einmalig): [Homebrew](https://brew.sh) installieren, dann im Terminal `brew install cloudflared` → **Enter**. Danach das Startskript neu starten – es zeigt einen QR-Code für das Handy.",
      ],
      android: [
        "Auf dem Handy allein läuft das nicht: Du brauchst einen eingeschalteten Windows-PC oder Mac, auf dem die Schritte unter „Windows“ bzw. „macOS“ erledigt sind – einschließlich des letzten Schritts fürs Handy.",
        "Am PC das Startskript starten: Ortfinder öffnet sich dort mit einem QR-Code (sonst unter ⚙ → „📱 Mit dem Handy nutzen“).",
        "Am Handy die **Kamera**-App (oder Google Lens) öffnen, auf den QR-Code richten und den angezeigten Link antippen.",
        "Ortfinder öffnet sich in Chrome – schon mit deinem PC verbunden. **Foto auswählen** antippen → Foto wählen.",
        "Während der Analyse muss der PC an bleiben und das Skript-Fenster offen sein. Die Adresse ändert sich bei jedem Start des Skripts – dann den QR-Code neu scannen.",
      ],
      ios: [
        "Auf dem iPhone allein läuft das nicht: Du brauchst einen eingeschalteten Windows-PC oder Mac, auf dem die Schritte unter „Windows“ bzw. „macOS“ erledigt sind – einschließlich des letzten Schritts fürs Handy.",
        "Am PC das Startskript starten: Ortfinder öffnet sich dort mit einem QR-Code (sonst unter ⚙ → „📱 Mit dem Handy nutzen“).",
        "Am iPhone die **Kamera**-App öffnen, auf den QR-Code richten und den gelben Link antippen.",
        "Ortfinder öffnet sich in Safari – schon mit deinem PC verbunden. **Foto auswählen** antippen → **Fotomediathek** → Foto wählen.",
        "Während der Analyse muss der PC an bleiben und das Skript-Fenster offen sein. Die Adresse ändert sich bei jedem Start des Skripts – dann den QR-Code neu scannen.",
      ],
    },
    notes: {
      all: "Wer den Handy-Link kennt, kann die KI deines PCs mitbenutzen, solange das Skript läuft – also nicht weitergeben.",
    },
  },
};

const TOKEN = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;

/** Split guide text into plain text, links, code and bold parts. */
export function parseInline(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ type: "link", text: m[1], href: m[2] });
    else if (m[3] !== undefined) parts.push({ type: "code", text: m[3] });
    else parts.push({ type: "bold", text: m[4] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

/** Guide text as DOM nodes; `code` copies itself when tapped, scripts are offered as downloads. */
export function inlineNodes(text, doc = globalThis.document) {
  return parseInline(text).map((part) => {
    if (part.type === "link") {
      const a = doc.createElement("a");
      a.href = part.href;
      a.textContent = part.text;
      if (/\.(bat|sh)$/.test(part.href)) a.setAttribute("download", "");
      else Object.assign(a, { target: "_blank", rel: "noopener" });
      return a;
    }
    if (part.type === "bold") {
      const b = doc.createElement("strong");
      b.textContent = part.text;
      return b;
    }
    if (part.type === "code") {
      const code = doc.createElement("code");
      code.className = "copy";
      code.textContent = part.text;
      code.title = "Antippen zum Kopieren";
      code.tabIndex = 0;
      code.setAttribute("role", "button");
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(part.text);
          code.classList.add("copied");
          setTimeout(() => code.classList.remove("copied"), 1500);
        } catch {
          // no clipboard access (old browser): the text can still be selected by hand
        }
      };
      code.addEventListener("click", copy);
      code.addEventListener("keydown", (e) => e.key === "Enter" && copy());
      return code;
    }
    return doc.createTextNode(part.text);
  });
}

/** Intro, numbered steps and notes of one guide for one device. */
export function guideNodes(provider, device, doc = globalThis.document) {
  const guide = GUIDES[provider];
  const p = (text, cls) => {
    const node = doc.createElement("p");
    node.className = cls;
    node.append(...inlineNodes(text, doc));
    return node;
  };
  const list = doc.createElement("ol");
  list.className = "guide-steps";
  for (const step of guide.steps[device]) {
    const li = doc.createElement("li");
    li.append(...inlineNodes(step, doc));
    list.append(li);
  }
  const note = guide.notes?.[device] ?? guide.notes?.all;
  return [...(guide.intro ? [p(guide.intro, "small")] : []), list, ...(note ? [p(note, "small muted")] : [])];
}

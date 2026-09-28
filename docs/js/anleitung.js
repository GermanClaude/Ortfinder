// anleitung.html: all guides on one page; the choice is kept in the address (#claude/ios) for sharing.

import { DEVICES, GUIDES, detectDevice, guideNodes } from "./guides.js";

const PROVIDERS = [
  { id: "puter", label: "Puter", hint: "kostenlos, ohne Key" },
  { id: "openrouter", label: "OpenRouter", hint: "kostenlos, 50 Anfragen am Tag – gut fürs Handy" },
  { id: "gemini", label: "Google Gemini", hint: "eigener Key, kostenloser Tarif möglich" },
  { id: "claude", label: "Claude", hint: "eigener API-Key, kostenpflichtig" },
  { id: "ollama", label: "Eigener PC", hint: "unbegrenzt & kostenlos, Handy per QR-Code" },
];

const $ = (sel) => document.querySelector(sel);

function readHash() {
  const [provider, device] = location.hash.slice(1).split("/");
  return {
    provider: GUIDES[provider] ? provider : "puter",
    device: DEVICES.some((d) => d.id === device) ? device : detectDevice(),
  };
}

function tabs(container, items, active, onPick) {
  container.replaceChildren(...items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "tab";
    button.className = item.id === active ? "tab active" : "tab";
    button.setAttribute("aria-selected", String(item.id === active));
    button.textContent = item.label;
    button.addEventListener("click", () => onPick(item.id));
    return button;
  }));
}

function render() {
  const { provider, device } = readHash();
  const go = (p, d) => { location.hash = `${p}/${d}`; };
  tabs($("#provider-tabs"), PROVIDERS, provider, (p) => go(p, device));
  tabs($("#device-tabs"), DEVICES, device, (d) => go(provider, d));
  $("#provider-hint").textContent = PROVIDERS.find((p) => p.id === provider).hint;
  $("#guide-heading").textContent = `${GUIDES[provider].title} · ${DEVICES.find((d) => d.id === device).label}`;
  $("#guide-body").replaceChildren(...guideNodes(provider, device));
}

window.addEventListener("hashchange", render);
render();

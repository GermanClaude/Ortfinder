import assert from "node:assert/strict";
import { test } from "node:test";

import { DEVICES, GUIDES, detectDevice, parseInline } from "../../docs/js/guides.js";

test("every AI option has steps for Windows, macOS, Android and iPhone", () => {
  assert.deepEqual(Object.keys(GUIDES).sort(), ["claude", "gemini", "ollama", "openrouter", "puter"]);
  assert.deepEqual(DEVICES.map((d) => d.id), ["windows", "macos", "android", "ios"]);
  for (const [provider, guide] of Object.entries(GUIDES)) {
    assert.ok(guide.title, provider);
    for (const { id } of DEVICES) {
      const steps = guide.steps[id];
      assert.ok(Array.isArray(steps) && steps.length >= 4, `${provider}/${id}`);
      for (const step of steps) {
        assert.equal(typeof step, "string");
        // Markup must be balanced, or the text would show stray ** or `.
        const plain = parseInline(step).filter((p) => p.type === "text").map((p) => p.text).join("");
        assert.ok(!/\*\*|`|\]\(/.test(plain), `${provider}/${id}: ${step}`);
      }
    }
  }
});

test("device-specific paste gestures appear where a key is typed in", () => {
  for (const provider of ["gemini", "claude"]) {
    const text = (d) => GUIDES[provider].steps[d].join(" ");
    assert.match(text("windows"), /Strg\+V/);
    assert.match(text("macos"), /⌘\+V/);
    assert.match(text("android"), /lange in das Feld tippen/);
    assert.match(text("ios"), /Einfügen erlauben/);
  }
  const claude = GUIDES.claude.steps.windows.join(" ");
  assert.match(claude, /platform\.claude\.com\/settings\/billing/);
  assert.match(claude, /platform\.claude\.com\/settings\/keys/);
  assert.match(claude, /sk-ant-/);
  assert.match(GUIDES.claude.intro, /Abo/);
});

test("inline markup: links, code and bold", () => {
  assert.deepEqual(parseInline("Öffne [Seite](https://x.de/a) und tippe `ollama pull x` → **Enter**."), [
    { type: "text", text: "Öffne " },
    { type: "link", text: "Seite", href: "https://x.de/a" },
    { type: "text", text: " und tippe " },
    { type: "code", text: "ollama pull x" },
    { type: "text", text: " → " },
    { type: "bold", text: "Enter" },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("nur Text"), [{ type: "text", text: "nur Text" }]);
});

test("device detection from the browser", () => {
  const ua = (userAgent, maxTouchPoints = 0) => detectDevice({ userAgent, maxTouchPoints });
  assert.equal(ua("Mozilla/5.0 (Linux; Android 16; SM-S947B) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36"), "android");
  assert.equal(ua("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1"), "ios");
  assert.equal(ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15", 5), "ios");
  assert.equal(ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15"), "macos");
  assert.equal(ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"), "windows");
  assert.equal(detectDevice(undefined), "windows");
});

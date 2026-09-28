import assert from "node:assert/strict";
import { test } from "node:test";

import { TILES_MARK } from "../../docs/js/compact.js";
import { ROUNDS_NOW, fakeJpeg, measureAll } from "./token-scenario.mjs";

// Measured with the same scenario before the token diet (8 rounds; photo + grid image + 4 tiles resent
// every round, every earlier image and result resent, long prompt and tool descriptions).
const BEFORE = { gemini: 225491, puter: 234871, openrouter: 244449, ollama: 210104, claude_billed: 71003 };

test("a typical analysis uses at least 60 % fewer tokens than before (Claude: cheaper through its cache)", async () => {
  const images = [
    { type: "image", mime_type: "image/jpeg", data: fakeJpeg(1644, 1244), resolution: "high" },
    { type: "text", text: TILES_MARK },
    ...[0, 1, 2, 3].flatMap((i) => [{ type: "text", text: `Detail-Kachel ${i}:` }, { type: "image", mime_type: "image/jpeg", data: fakeJpeg(1536, 1152), resolution: "high" }]),
  ];
  const now = await measureAll({ intro: "Bestimme, wo dieses Foto aufgenommen wurde. Originalauflösung: 4000×3000 Pixel. ".repeat(3), images, rounds: ROUNDS_NOW });
  for (const provider of ["gemini", "puter", "openrouter", "ollama"]) {
    const saved = 1 - now[provider].tokens / BEFORE[provider];
    assert.ok(saved >= 0.6, `${provider}: nur ${Math.round(saved * 100)} % gespart (${now[provider].tokens} Tokens)`);
    assert.equal(now[provider].requests, 7, `${provider}: solve_camera brings the top view along`);
  }
  assert.ok(now.claude.billed_equivalent < BEFORE.claude_billed * 0.9, `claude: ${now.claude.billed_equivalent}`);
  assert.ok(now.claude.billed_equivalent < now.claude.tokens * 0.4, "Claude's prompt cache bills repeats at a tenth");
});

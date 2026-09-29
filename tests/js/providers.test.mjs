import assert from "node:assert/strict";
import { test } from "node:test";

import { PuterAgent } from "../../docs/js/puter-agent.js";
import {
  COMPAT_PROVIDERS, PROVIDER_GROUPS, CompatHttpError, cleanMessages, compatChat, compatSettings, describeCompatError, isCompat, limitImages,
  listCompatModels,
} from "../../docs/js/providers.js";
import { ToolExecutor } from "../../docs/js/tools.js";
import { VALID_SUBMISSION } from "./fixtures.mjs";

test("every service is grouped, reachable over https and brings models with image input", () => {
  const groups = PROVIDER_GROUPS.map((g) => g.id);
  assert.deepEqual(groups, ["free", "trial", "paypal", "card"]);
  for (const [id, p] of Object.entries(COMPAT_PROVIDERS)) {
    assert.ok(groups.includes(p.group), id);
    assert.ok(p.name && p.label && p.lines.length, id);
    if (id === "custom") continue;
    assert.match(p.baseUrl, /^https:\/\/[^/]+/, id);
    assert.match(p.keyUrl, /^https:\/\//, id);
    assert.ok(p.models.length >= 1, id);
  }
  assert.deepEqual(Object.entries(COMPAT_PROVIDERS).filter(([, p]) => p.paypal).map(([id]) => id), ["deepseek", "poe"]);
  assert.ok(isCompat("groq") && !isCompat("puter") && !isCompat("toString"));
});

test("settings per service: defaults, own model, own address for the custom service", () => {
  assert.deepEqual(compatSettings({}, "deepseek"), { key: "", model: "deepseek-flash", baseUrl: "https://api.deepseek.com" });
  assert.deepEqual(compatSettings({ compat: { mistral: { key: "k", model: "pixtral-large-latest" } } }, "mistral"),
    { key: "k", model: "pixtral-large-latest", baseUrl: "https://api.mistral.ai/v1" });
  assert.deepEqual(compatSettings({ compat: { custom: { key: "k", model: "m", url: "https://api.together.xyz/v1/" } } }, "custom"),
    { key: "k", model: "m", baseUrl: "https://api.together.xyz/v1" });
});

test("assistant turns go back with the common fields only; pictures beyond a service's limit become notes", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Wo?" }, { type: "image_url", image_url: { url: "data:photo" } }, { type: "image_url", image_url: { url: "data:tile1" } }] },
    { role: "assistant", content: null, reasoning: "x", refusal: null, reasoning_content: "denken", tool_calls: [{ id: "a", type: "function", function: { name: "zoom_image", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "ok" },
    { role: "user", content: [{ type: "text", text: "Zoom 1" }, { type: "image_url", image_url: { url: "data:z1" } }, { type: "text", text: "Zoom 2" }, { type: "image_url", image_url: { url: "data:z2" } }] },
  ];
  const clean = cleanMessages(messages, ["reasoning_content"]);
  assert.deepEqual(clean[1], { role: "assistant", content: "", tool_calls: messages[1].tool_calls, reasoning_content: "denken" });
  assert.deepEqual(cleanMessages(messages)[1], { role: "assistant", content: "", tool_calls: messages[1].tool_calls });
  const limited = limitImages(clean, 3);
  const urls = limited.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  assert.deepEqual(urls, ["data:photo", "data:z1", "data:z2"], "the photo and the newest pictures");
  assert.match(limited[0].content[2].text, /höchstens 3 Bilder/);
  assert.equal(limitImages(clean, 9), clean);
});

test("requests and errors: key, model, tools; clear messages for key, credit, model, pictures, limits", async () => {
  const calls = [];
  const chat = compatChat({
    baseUrl: "https://api.deepseek.com", key: "sk-test", keep: ["reasoning_content"],
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hallo" }, finish_reason: "stop" }], usage: { prompt_tokens: 5 } }));
    },
  });
  const r = await chat([{ role: "user", content: "Hi" }], { model: "deepseek-flash", tools: [{ type: "function", function: { name: "x" } }] });
  assert.deepEqual(r, { message: { role: "assistant", content: "Hallo" }, finish_reason: "stop", usage: { prompt_tokens: 5 } });
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.deepEqual([calls[0].body.model, calls[0].body.tool_choice, calls[0].body.tools.length], ["deepseek-flash", "auto", 1]);

  const failing = (status, body, headers = {}) => compatChat({ baseUrl: "https://x", key: "k", fetchImpl: async () => new Response(JSON.stringify(body), { status, headers }) });
  const describe = describeCompatError("deepseek", "deepseek-flash");
  const fail = async (status, body, headers) => describe(await failing(status, body, headers)([], { model: "m" }).catch((e) => e));
  assert.equal((await fail(401, { error: { message: "Authentication Fails" } })).code, "AUTH");
  const credit = await fail(402, { error: { message: "Insufficient Balance" } });
  assert.equal(credit.code, "ALLOWANCE");
  assert.match(credit.message, /aufgebraucht – dort aufladen \(auch mit PayPal\)/);
  assert.match((await fail(404, { error: { message: "Model Not Exist" } })).message, /„deepseek-flash“ gibt es bei DeepSeek nicht \(mehr\)\. Unter ⚙ „Modelle laden“/);
  assert.equal((await fail(400, { error: { message: "This model does not support image input" } })).code, "NO_VISION");
  const busy = await fail(429, { error: { message: "Rate limit reached" } }, { "retry-after": "7" });
  assert.deepEqual([busy.code, busy.retryable, busy.retryAfterMs], ["BUSY", true, 7000]);
  assert.equal((await fail(503, {})).retryable, true);
  assert.equal(describe(new TypeError("Failed to fetch")).code, "BUSY");
  assert.ok(new CompatHttpError(500, "x") instanceof Error);
});

test("model list from the service: presets first, then models with image input", async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://api.poe.com/v1/models");
    assert.equal(init.headers.Authorization, "Bearer k");
    return new Response(JSON.stringify({ data: [
      { id: "aaa-text", architecture: { input_modalities: ["text"] } },
      { id: "zzz-vision", architecture: { input_modalities: ["text", "image"] } },
      { id: "gemini-3.8-flash", architecture: { input_modalities: ["text", "image"] } },
    ] }));
  };
  const models = await listCompatModels("poe", { baseUrl: "https://api.poe.com/v1", key: "k" }, fetchImpl);
  assert.deepEqual(models.map((m) => [m.id, m.vision]), [["gemini-3.8-flash", true], ["zzz-vision", true], ["aaa-text", false]]);
});

test("a whole analysis over such a service (DeepSeek: its thinking goes back as it came)", async () => {
  const bodies = [];
  const answers = [
    { choices: [{ message: { role: "assistant", content: "", reasoning_content: "Schild prüfen", tool_calls: [{ id: "c1", type: "function", function: { name: "geocode", arguments: JSON.stringify({ query: "Bahnhofstraße" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 900, completion_tokens: 50 } },
    { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "submit_result", arguments: JSON.stringify(VALID_SUBMISSION) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1000, completion_tokens: 80 } },
  ];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(answers.shift()));
  };
  const p = COMPAT_PROVIDERS.deepseek;
  const agent = new PuterAgent({
    model: "deepseek-flash", maxSteps: 5,
    chat: compatChat({ baseUrl: p.baseUrl, key: "sk-test", keep: p.keep, fetchImpl }),
    describeError: describeCompatError("deepseek", "deepseek-flash"),
  });
  const executor = new ToolExecutor({ zoom: async () => ({}), osm: { geocode: async (q) => [{ name: `${q}, Freiburg`, lat: 47.99, lon: 7.85 }] } });
  const { analysis, usage } = await agent.run({ intro: "Wo?", images: [{ type: "image", mime_type: "image/jpeg", data: "QkFTRQ==" }], executor });
  assert.equal(analysis.subject.name, "Martinstor");
  assert.equal(usage.requests, 2);
  assert.equal(bodies[1].messages[2].reasoning_content, "Schild prüfen");
  assert.equal(bodies[1].messages[1].content[1].type, "image_url");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  OPENROUTER_DEFAULT_MODEL, OpenRouterHttpError, describeOpenRouterError, fallbackModels, finishOpenRouterSignIn, listFreeVisionModels, openRouterChat,
  openRouterSignInUrl, pkceChallenge,
} from "../../docs/js/openrouter.js";
import { PuterAgent, pruneImageParts } from "../../docs/js/puter-agent.js";
import { ToolExecutor } from "../../docs/js/tools.js";
import { VALID_SUBMISSION } from "./fixtures.mjs";

const memoryStorage = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
};

test("only free models with image input and tool use are offered, the default first", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "https://openrouter.ai/api/v1/models");
    const model = (id, image, tools, price = "0") => ({
      id, name: id, context_length: 262144, pricing: { prompt: price, completion: price },
      architecture: { input_modalities: image ? ["text", "image"] : ["text"] }, supported_parameters: tools ? ["tools", "max_tokens"] : ["max_tokens"],
    });
    return Response.json({ data: [
      model("google/gemma-4-31b-it:free", true, true),
      model("text-only/model:free", false, true),
      model("no-tools/vision:free", true, false),
      model("openai/gpt-5:paid", true, true, "0.000001"),
      model(OPENROUTER_DEFAULT_MODEL, true, true),
      model("openrouter/free", true, true),
      model("stealth/space-bunny-alpha", true, true),
    ] });
  };
  const models = await listFreeVisionModels(fetchImpl);
  assert.deepEqual(models.map((m) => m.id), [OPENROUTER_DEFAULT_MODEL, "google/gemma-4-31b-it:free"]);
});

test("fallback models: preferred order, never the chosen one, only models OpenRouter lists", () => {
  assert.deepEqual(fallbackModels("qwen/qwen3.8-27b:free"), ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"]);
  assert.deepEqual(fallbackModels("google/gemma-4-31b-it:free", ["google/gemma-4-31b-it:free", "qwen/qwen3.8-27b:free", "new/vision:free"]), ["qwen/qwen3.8-27b:free", "new/vision:free"]);
  assert.deepEqual(fallbackModels("a:free", []), []);
});

test("chat requests name fallback models, report the model used and keep Retry-After", async () => {
  const seen = [];
  const used = [];
  const chat = openRouterChat({
    key: "k", fallbacks: ["b:free", "c:free"], onModel: (m) => used.push(m),
    fetchImpl: async (url, init) => {
      seen.push(JSON.parse(init.body));
      return Response.json({ model: "b:free", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    },
  });
  await chat([], { model: "a:free", tools: [] });
  assert.deepEqual([seen[0].model, seen[0].models], ["a:free", ["a:free", "b:free", "c:free"]]);
  assert.deepEqual(used, ["b:free"]);
  const busy = openRouterChat({ key: "k", fetchImpl: async () => Response.json({ error: { code: 429, message: "Provider returned error" } }, { status: 429, headers: { "retry-after": "7" } }) });
  await assert.rejects(busy([], { model: "a:free" }), (err) => err.retryAfterMs === 7000);
});

test("chat requests carry the key and tools; errors keep status and message", async () => {
  const seen = [];
  const ok = openRouterChat({
    key: "sk-or-v1-test",
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ choices: [{ message: { role: "assistant", content: "Hallo" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    },
  });
  const r = await ok([{ role: "user", content: "Hi" }], { model: "m:free", tools: [{ type: "function" }] });
  assert.deepEqual(r, { message: { role: "assistant", content: "Hallo" }, finish_reason: "stop", usage: { prompt_tokens: 10, completion_tokens: 2 } });
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seen[0].headers.Authorization, "Bearer sk-or-v1-test");
  assert.deepEqual([seen[0].body.model, seen[0].body.tools.length, seen[0].body.tool_choice], ["m:free", 1, "auto"]);

  const limited = openRouterChat({ key: "k", fetchImpl: async () => Response.json({ error: { code: 429, message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day" } }, { status: 429 }) });
  await assert.rejects(limited([], {}), (err) => err instanceof OpenRouterHttpError && err.status === 429);
  const upstream = openRouterChat({ key: "k", fetchImpl: async () => Response.json({ choices: [{ error: { code: 502, message: "Provider returned error" } }] }) });
  await assert.rejects(upstream([], {}), (err) => err.status === 502);
});

test("OpenRouter errors become clear German messages", () => {
  const d = (status, message, metadata) => describeOpenRouterError(new OpenRouterHttpError(status, message, metadata));
  assert.equal(d(401, "No auth credentials found").code, "AUTH");
  const daily = d(429, "Rate limit exceeded: free-models-per-day");
  assert.equal(daily.code, "ALLOWANCE");
  assert.equal(daily.retryable, false);
  assert.match(daily.message, /Tageslimit.*50 Anfragen/);
  const perMinute = d(429, "Rate limit exceeded: free-models-per-min");
  assert.equal(perMinute.retryable, true);
  assert.match(perMinute.message, /20 Anfragen pro Minute/);
  assert.equal(perMinute.retryAfterMs, 30000);
  // A free model's provider is overloaded (shared by all OpenRouter users): patient retries, honest message.
  const upstream = d(429, "Provider returned error", { raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly" });
  assert.equal(upstream.retryable, true);
  assert.match(upstream.message, /überlastet.*teilen sich/);
  assert.deepEqual([upstream.backoffMs, upstream.maxRetries], [15000, 4]);
  assert.equal(d(404, "No endpoints found matching your data policy").code, "POLICY");
  assert.equal(d(404, "No endpoints found that support image input").code, "MODEL");
  assert.equal(d(402, "Insufficient credits").code, "ALLOWANCE");
  assert.equal(d(503, "Service unavailable").retryable, true);
  const offline = describeOpenRouterError(new TypeError("Failed to fetch"));
  assert.equal(offline.retryable, true);
  assert.match(offline.message, /Keine Verbindung/);
});

test("sign-in with PKCE: S256 challenge, code exchanged with the stored verifier", async () => {
  const v = "dBjftJeZ4CVP-mJ92K9SiKkfBDNzWHnGMCHfcGZvKf0";
  assert.equal(await pkceChallenge(v), createHash("sha256").update(v).digest("base64url"));
  const storage = memoryStorage();
  const url = new URL(await openRouterSignInUrl("https://germanclaude.github.io/Ortfinder/docs/", storage));
  assert.equal(url.origin + url.pathname, "https://openrouter.ai/auth");
  assert.equal(url.searchParams.get("callback_url"), "https://germanclaude.github.io/Ortfinder/docs/");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const verifier = storage.getItem("ortfinder.openrouter.verifier");
  assert.equal(url.searchParams.get("code_challenge"), await pkceChallenge(verifier));

  let body;
  const key = await finishOpenRouterSignIn("abc123", {
    storage,
    fetchImpl: async (u, init) => {
      assert.equal(u, "https://openrouter.ai/api/v1/auth/keys");
      body = JSON.parse(init.body);
      return Response.json({ key: "sk-or-v1-user" });
    },
  });
  assert.equal(key, "sk-or-v1-user");
  assert.deepEqual(body, { code: "abc123", code_verifier: verifier, code_challenge_method: "S256" });
  assert.equal(storage.getItem("ortfinder.openrouter.verifier"), null, "the verifier is used once");
  await assert.rejects(finishOpenRouterSignIn("abc", { storage, fetchImpl: async () => Response.json({}) }), /anderen Browser/);
  storage.setItem("ortfinder.openrouter.verifier", "v");
  await assert.rejects(finishOpenRouterSignIn("bad", { storage, fetchImpl: async () => Response.json({ error: { message: "Invalid code" } }, { status: 400 }) }), /Invalid code/);
});

test("only the newest images are sent; the photo in the first message always stays", () => {
  const img = { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } };
  const messages = [
    { role: "system", content: "S" },
    { role: "user", content: [{ type: "text", text: "Foto" }, img, img] },
    { role: "user", content: [{ type: "text", text: "Zooms 1" }, img, img, img] },
    { role: "tool", tool_call_id: "x", content: "ok" },
    { role: "user", content: [{ type: "text", text: "Zooms 2" }, img, img] },
  ];
  const sent = pruneImageParts(messages, 2);
  const count = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0);
  assert.deepEqual(sent.map(count), [0, 2, 0, 0, 2]);
  assert.match(sent[2].content.at(-1).text, /3 Bild\(er\) aus einer früheren Runde entfernt/);
  assert.equal(count(messages[2]), 3, "the stored conversation is unchanged");
});

test("a full analysis runs over OpenRouter with the OpenAI-style agent", async () => {
  const bodies = [];
  const replies = [
    { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "geocode", arguments: JSON.stringify({ query: "Bahnhofstraße" }) } }] }, finish_reason: "tool_calls" }] },
    { error: { code: 429, message: "Rate limit exceeded: free-models-per-min" }, retryAfter: "2" },
    { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "submit_result", arguments: JSON.stringify(VALID_SUBMISSION) } }] }, finish_reason: "tool_calls" }] },
  ];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = replies.shift();
    return Response.json(next, { status: next.error ? next.error.code : 200, headers: next.retryAfter ? { "retry-after": next.retryAfter } : {} });
  };
  const events = [];
  const executor = new ToolExecutor({ zoom: async () => ({}), osm: { geocode: async (q) => [{ name: `${q}, Freiburg`, lat: 47.99, lon: 7.85 }] }, emit: () => {} });
  const agent = new PuterAgent({
    model: OPENROUTER_DEFAULT_MODEL, chat: openRouterChat({ key: "k", fetchImpl }), describeError: describeOpenRouterError, keepImages: 8,
    emit: (t, d) => events.push([t, d]), maxSteps: 5,
  });
  const started = Date.now();
  const { analysis } = await agent.run({ intro: "Wo?", images: [{ type: "image", mime_type: "image/jpeg", data: "QQ==" }], executor });
  assert.equal(analysis.city, "Freiburg");
  assert.equal(bodies.length, 3, "the per-minute limit was retried");
  assert.ok(Date.now() - started >= 1900, "with a short wait");
  assert.ok(events.some(([t, d]) => t === "status" && /20 Anfragen pro Minute.*Neuer Versuch in 2 s/.test(d.message)));
  assert.equal(bodies[0].messages[1].content[1].image_url.url, "data:image/jpeg;base64,QQ==");
});

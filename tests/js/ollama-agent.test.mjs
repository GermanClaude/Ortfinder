import assert from "node:assert/strict";
import { test } from "node:test";

import { OllamaAgent, OllamaError, listOllamaModels, normalizeOllamaUrl } from "../../docs/js/ollama-agent.js";
import { TILES_MARK, compactOllama } from "../../docs/js/compact.js";
import { ToolExecutor } from "../../docs/js/tools.js";
import { VALID_SUBMISSION } from "./fixtures.mjs";

const call = (name, args, id = `call_${name}`) => ({ id, function: { index: 0, name, arguments: args } });
/** Ollama streams newline-delimited JSON chunks; the last one carries done and the token counts. */
const stream = (message, { chunks = 2 } = {}) => {
  const lines = [];
  const text = message.content || "";
  const step = Math.ceil(text.length / chunks) || 1;
  for (let i = 0; i < text.length; i += step) lines.push({ message: { role: "assistant", content: text.slice(i, i + step) }, done: false });
  if (message.thinking) lines.push({ message: { role: "assistant", content: "", thinking: message.thinking }, done: false });
  if (message.tool_calls) lines.push({ message: { role: "assistant", content: "", tool_calls: message.tool_calls }, done: false });
  lines.push({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 5000, eval_count: 120 });
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });
};

function setup(responses, options = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    return typeof next === "function" ? next(init) : next;
  };
  const events = [];
  const emit = (t, d) => events.push([t, d]);
  const osm = { geocode: async (q) => [{ name: `${q}, Deutschland`, lat: 47.99, lon: 7.85 }] };
  const executor = new ToolExecutor({
    zoom: async () => ({ data: "Wk9PTQ==", width: 1024, height: 768, sourceWidth: 120, sourceHeight: 90, thumbnail: "data:," }),
    osm, emit,
  });
  const agent = new OllamaAgent({ baseUrl: "localhost:11434", model: "gemma4:12b", numCtx: 32768, maxSteps: 6, fetchImpl, emit, ...options });
  const images = [
    { type: "image", mime_type: "image/jpeg", data: "T1ZFUg==" },
    { type: "text", text: TILES_MARK },
    { type: "text", text: "Detail-Kachel oben links" },
    { type: "image", mime_type: "image/jpeg", data: "VElMRQ==" },
  ];
  const run = () => agent.run({ intro: "Wo ist das?", images, executor });
  return { agent, run, requests, events, executor };
}

test("addresses are normalised", () => {
  assert.equal(normalizeOllamaUrl(""), "http://localhost:11434");
  assert.equal(normalizeOllamaUrl("localhost:11434/"), "http://localhost:11434");
  assert.equal(normalizeOllamaUrl("127.0.0.1:11434/api"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaUrl("brave-lemon.trycloudflare.com"), "https://brave-lemon.trycloudflare.com");
  assert.equal(normalizeOllamaUrl(" https://x.trycloudflare.com/ "), "https://x.trycloudflare.com");
});

test("installed models: capabilities from /api/tags, else from /api/show", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/api/tags")) {
      return Response.json({ models: [
        { name: "gemma4:12b", size: 7.6e9, details: { parameter_size: "12B" }, capabilities: ["completion", "vision", "tools"] },
        { name: "llama3:8b", size: 4.7e9, details: { parameter_size: "8B" }, capabilities: ["completion", "tools"] },
        { name: "old-vision:7b", size: 5e9, details: {} },
      ] });
    }
    assert.equal(JSON.parse(init.body).model, "old-vision:7b");
    return Response.json({ capabilities: ["completion", "vision", "tools"] });
  };
  const models = await listOllamaModels("http://localhost:11434", fetchImpl);
  assert.deepEqual(models.map((m) => [m.name, m.usable, m.sizeGb]), [["gemma4:12b", true, 7.6], ["llama3:8b", false, 4.7], ["old-vision:7b", true, 5]]);
  assert.deepEqual(calls, ["http://localhost:11434/api/tags", "http://localhost:11434/api/show"]);
  await assert.rejects(listOllamaModels("http://localhost:1", async () => { throw new TypeError("Failed to fetch"); }), (err) => err instanceof OllamaError && err.code === "UNREACHABLE" && /OLLAMA_ORIGINS/.test(err.message));
});

test("earlier rounds' images and the tiles are not resent, the photo itself always", () => {
  const img = (n) => Array.from({ length: n }, (_, i) => `img${i}`);
  const messages = [
    { role: "system", content: "S" },
    { role: "user", content: "Foto", images: img(1) },
    { role: "user", content: `${TILES_MARK}\nKachel oben links`, images: img(4) },
    { role: "assistant", content: `Notiz: Schild „Bahnhofstraße“, Café Müller bei 47.99, 7.85. ${"n".repeat(1500)}`, tool_calls: [{}] },
    { role: "tool", content: "Ausschnitt x 0.1-0.2 …" + "x".repeat(2000) },
    { role: "user", content: "Zooms 1", images: img(3) },
    { role: "assistant", content: "", tool_calls: [{}] },
    { role: "tool", content: "neu" },
    { role: "user", content: "Zooms 2", images: img(2) },
  ];
  const sent = compactOllama(messages);
  assert.deepEqual(sent.map((m) => m.images?.length ?? 0), [0, 1, 0, 0, 0, 0, 0, 0, 2]);
  assert.match(sent[2].content, /nur in der ersten Runde/);
  assert.ok(sent[4].content.length < 900 && /gekürzt/.test(sent[4].content));
  assert.match(sent[5].content, /nicht erneut mitgeschickt/);
  assert.equal(messages[5].images.length, 3, "the stored conversation is not changed");
  assert.equal(sent[3].content, messages[3].content, "the model's own notes are never cut");
  assert.deepEqual(compactOllama(messages.slice(0, 3)).map((m) => m.images?.length ?? 0), [0, 1, 4], "before the first answer the tiles go along");
});

test("full loop over Ollama's native chat API: tools, images, streaming", async () => {
  const { run, requests, events } = setup([
    stream({ content: "Ich zoome auf das Schild.", thinking: "Schild unten rechts.", tool_calls: [
      call("zoom_image", { x_min: 0.7, y_min: 0.6, x_max: 0.9, y_max: 0.8, purpose: "Schild" }),
      call("geocode", { query: "Bahnhofstraße" }),
    ] }),
    stream({ tool_calls: [call("submit_result", VALID_SUBMISSION)] }),
  ]);
  const { analysis, usage } = await run();
  assert.equal(analysis.city, "Freiburg");
  assert.deepEqual(usage, { requests: 2, input_tokens: 10000, output_tokens: 240, thought_tokens: 0, cached_tokens: 0 });

  const [first, second] = requests;
  assert.equal(first.url, "http://localhost:11434/api/chat");
  assert.equal(first.body.model, "gemma4:12b");
  assert.equal(first.body.stream, true);
  assert.deepEqual(first.body.options, { num_ctx: 32768 });
  assert.ok(first.body.tools.length >= 12 && first.body.tools.every((t) => t.type === "function" && t.function.name));
  assert.deepEqual(first.body.messages.map((m) => [m.role, m.images?.length ?? 0]), [["system", 0], ["user", 1], ["user", 1]]);
  assert.match(first.body.messages[2].content, /Detail-Kachel oben links/);

  const roles = second.body.messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "user", "assistant", "tool", "tool", "user"]);
  assert.deepEqual(second.body.messages.map((m) => m.images?.length ?? 0), [0, 1, 0, 0, 0, 0, 1], "tiles only with the first request");
  const assistant = second.body.messages[3];
  assert.equal(assistant.content, "Ich zoome auf das Schild.");
  assert.equal(assistant.thinking, undefined, "earlier thinking is not sent back");
  assert.equal(assistant.tool_calls.length, 2);
  const [zoomResult, geocodeResult] = second.body.messages.slice(4, 6);
  assert.deepEqual([zoomResult.tool_name, zoomResult.tool_call_id], ["zoom_image", "call_zoom_image"]);
  assert.match(zoomResult.content, /Bild folgt/);
  assert.equal(geocodeResult.tool_name, "geocode");
  assert.match(geocodeResult.content, /Bahnhofstraße, Deutschland/);
  assert.deepEqual(second.body.messages[6].images, ["Wk9PTQ=="], "the zoom crop follows as an image");
  assert.deepEqual(events.filter(([t]) => t === "thinking").map(([, d]) => d.text), ["Schild unten rechts."]);
  assert.ok(events.some(([t, d]) => t === "note" && d.text === "Ich zoome auf das Schild."));
});

test("string arguments are parsed, broken JSON is reported back to the model", async () => {
  const { run, requests } = setup([
    stream({ tool_calls: [{ id: "c1", function: { name: "geocode", arguments: "{\"query\": \"Freiburg\"}" } }, { id: "c2", function: { name: "geocode", arguments: "{kaputt" } }] }),
    stream({ tool_calls: [call("submit_result", VALID_SUBMISSION)] }),
  ]);
  await run();
  const tools = requests[1].body.messages.filter((m) => m.role === "tool");
  assert.match(tools[0].content, /Freiburg, Deutschland/);
  assert.match(tools[1].content, /kein gültiges JSON/);
});

test("clear errors: model not installed, model without tools", async () => {
  const missing = setup([new Response(JSON.stringify({ error: "model 'gemma4:12b' not found" }), { status: 404 })]);
  await assert.rejects(missing.run(), /nicht installiert.*ollama pull gemma4:12b/);
  const noTools = setup([new Response(JSON.stringify({ error: "registry.ollama.ai/library/llava does not support tools" }), { status: 400 })]);
  await assert.rejects(noTools.run(), /kann keine Werkzeuge benutzen/);
});

test("an unreachable PC is retried, and waited for while the page is in the background", async () => {
  const down = () => { throw new TypeError("Failed to fetch"); };
  let waits = 0;
  const started = Date.now();
  const { run, requests } = setup([down, down, down, down, stream({ tool_calls: [call("submit_result", VALID_SUBMISSION)] })], {
    whenActive: async () => (waits++ < 4),
  });
  const { analysis } = await run();
  assert.equal(analysis.city, "Freiburg");
  assert.equal(requests.length, 5);
  assert.ok(Date.now() - started < 1500);
});

test("checkpoint after every round, resume from the saved messages", async () => {
  const saved = [];
  const first = setup([stream({ tool_calls: [call("geocode", { query: "Bahnhofstraße" })] })], {
    checkpoint: async (s) => { saved.push(structuredClone(s)); throw new Error("Seite verworfen"); },
  });
  await assert.rejects(first.run(), /Seite verworfen/);
  const [state] = saved;
  assert.equal(state.step, 1);
  const second = setup([stream({ tool_calls: [call("submit_result", VALID_SUBMISSION)] })]);
  const { usage } = await second.agent.run({ intro: "egal", images: [], executor: second.executor, resume: state });
  // The saved conversation is complete; what is sent drops the tiles after the first answer.
  assert.deepEqual(second.requests[0].body.messages, compactOllama(state.conversation));
  assert.ok(state.conversation[2].images?.length, "tiles stay in the saved state");
  assert.equal(usage.requests, 2);
});

test("without tool calls the model is nudged, then the run gives up", async () => {
  const { run, requests } = setup([stream({ content: "Ich glaube, das ist Freiburg." }), stream({ content: "Freiburg." }), stream({ content: "..." })]);
  await assert.rejects(run(), /kein Ergebnis/);
  assert.equal(requests.length, 3);
  assert.match(requests[1].body.messages.at(-1).content, /submit_result/);
});

test("a stream that stops sending is dropped and the round asked again", async () => {
  const stuck = (init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { role: "assistant", content: "Ich schaue" }, done: false }) + "\n"));
      init.signal.addEventListener("abort", () => c.error(init.signal.reason));
    },
  }), { status: 200 });
  const { run, requests, events } = setup([stuck, stream({ tool_calls: [call("submit_result", VALID_SUBMISSION)] })], { stallMs: 40 });
  const { analysis } = await run();
  assert.equal(analysis.subject.name, "Martinstor");
  assert.equal(requests.length, 2);
  assert.ok(events.some(([t, d]) => t === "warning" && /Versuch 2 von 4/.test(d.message)));
});

import assert from "node:assert/strict";
import { test } from "node:test";

import Anthropic from "../../docs/vendor/anthropic-sdk.mjs";
import { CLAUDE_TOOLS, ClaudeAgent, describeClaudeError, echoable, loadSdk } from "../../docs/js/claude-agent.js";
import { SYSTEM_PROMPT } from "../../docs/js/prompt.js";
import { ToolExecutor } from "../../docs/js/tools.js";
import { VALID_SUBMISSION } from "./fixtures.mjs";

await loadSdk();

const USAGE = { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 };

/** A streamed Messages API answer (server-sent events) as api.anthropic.com sends it. */
function sse({ content, stop_reason = "tool_use", model = "claude-opus-5", usage = USAGE }) {
  const events = [["message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
  }]];
  content.forEach((block, index) => {
    const delta = (d) => events.push(["content_block_delta", { type: "content_block_delta", index, delta: d }]);
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      delta({ type: "text_delta", text: block.text });
    } else if (block.type === "thinking") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }]);
      delta({ type: "thinking_delta", thinking: block.thinking });
      delta({ type: "signature_delta", signature: block.signature });
    } else if (block.type === "tool_use") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      delta({ type: "input_json_delta", partial_json: JSON.stringify(block.input) });
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 80 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const apiError = (status, type, message, headers = {}) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json", ...headers } });

const use = (id, name, input) => ({ type: "tool_use", id, name, input });

function setup(responses, options = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error("keine Antwort mehr vorbereitet");
    return typeof next === "function" ? next() : next;
  };
  const client = new Anthropic({ apiKey: "sk-ant-test", dangerouslyAllowBrowser: true, fetch, maxRetries: 0 });
  const events = [];
  const emit = (t, d) => events.push([t, d]);
  const osm = { geocode: async (q) => [{ name: `${q}, Deutschland`, lat: 47.99, lon: 7.85 }] };
  const executor = new ToolExecutor({
    zoom: async () => ({ data: "Wk9PTQ==", width: 1024, height: 768, sourceWidth: 120, sourceHeight: 90, thumbnail: "data:," }),
    osm, emit,
  });
  const agent = new ClaudeAgent({ client, emit, maxSteps: 6, ...options });
  const run = (resume = null) => agent.run({
    intro: "Wo ist das?",
    images: [{ type: "image", mime_type: "image/jpeg", data: "QkFTRQ==", resolution: "high" }, { type: "text", text: "Kachel" }],
    executor, resume,
  });
  return { run, requests, events, agent, executor };
}

test("tools are declared in the Claude format with streamed inputs", () => {
  assert.ok(CLAUDE_TOOLS.length >= 8);
  for (const t of CLAUDE_TOOLS) {
    assert.ok(t.name && t.description);
    assert.equal(t.input_schema.type, "object");
    assert.equal(t.eager_input_streaming, true);
  }
});

test("full loop on Opus 5: parallel tools with images, then submit", async () => {
  const { run, requests, events } = setup([
    sse({ content: [
      { type: "thinking", thinking: "Schild unten rechts.", signature: "sig1" },
      { type: "text", text: "Ich prüfe das Schild." },
      use("t1", "zoom_image", { x_min: 0.7, y_min: 0.6, x_max: 0.9, y_max: 0.8, enhance: true, purpose: "Schild" }),
      use("t2", "geocode", { query: "Bahnhofstraße", country_codes: "de" }),
      use("t3", "mark_hypothesis", { label: "Südbaden", camera_lat: 47.99, camera_lon: 7.85, radius_km: 30 }),
    ] }),
    sse({ content: [use("t4", "submit_result", VALID_SUBMISSION)] }),
  ]);
  const { analysis, usage } = await run();
  assert.equal(analysis.subject.name, "Martinstor");
  assert.deepEqual(usage, { requests: 2, input_tokens: 3400, output_tokens: 160, thought_tokens: 0, cached_tokens: 1000 });

  const first = requests[0];
  assert.equal(first.url, "https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(first.headers.get("x-api-key"), "sk-ant-test");
  assert.equal(first.headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(first.headers.get("anthropic-beta"), "server-side-fallback-2026-07-01");
  assert.equal(first.body.fallbacks, "default");
  assert.equal(first.body.model, "claude-opus-5");
  assert.equal(first.body.stream, true);
  assert.equal(first.body.max_tokens, 64000);
  assert.deepEqual(first.body.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
  assert.equal(first.body.system, SYSTEM_PROMPT);
  assert.deepEqual(first.body.tools, CLAUDE_TOOLS);
  const [intro, image, tile] = first.body.messages[0].content;
  assert.match(intro.text, /^Wo ist das\?\n\nBudget: höchstens 6 Runden/);
  assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QkFTRQ==" } });
  assert.deepEqual(tile, { type: "text", text: "Kachel" });

  // Second request: the assistant turn comes back unchanged (thinking with signature), then all results in one message.
  const history = requests[1].body.messages;
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(history[1].content[0], { type: "thinking", thinking: "Schild unten rechts.", signature: "sig1" });
  assert.deepEqual(history[1].content.map((b) => b.type), ["thinking", "text", "tool_use", "tool_use", "tool_use"]);
  const results = history[2].content;
  assert.deepEqual(results.map((b) => b.tool_use_id), ["t1", "t2", "t3"]);
  assert.match(results[0].content[0].text, /Ausschnitt/);
  assert.deepEqual(results[0].content[1], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Wk9PTQ==" } });
  assert.equal(JSON.parse(results[1].content)[0].lat, 47.99);
  assert.ok(results.every((b) => !b.is_error));

  assert.deepEqual(events.filter(([t]) => t === "thinking").map(([, d]) => d.text), ["Schild unten rechts."]);
  assert.deepEqual(events.filter(([t]) => t === "note").map(([, d]) => d.text), ["Ich prüfe das Schild."]);
  assert.deepEqual(events.filter(([t]) => t === "tool_call").map(([, d]) => d.tool), ["zoom_image", "geocode", "mark_hypothesis"]);
});

test("Sonnet 5 and Haiku 4.5: no fallback beta; Haiku gets a fixed thinking budget", async () => {
  const sonnet = setup([sse({ model: "claude-sonnet-5", content: [use("s", "submit_result", VALID_SUBMISSION)] })], { model: "claude-sonnet-5" });
  await sonnet.run();
  assert.equal(sonnet.requests[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(sonnet.requests[0].headers.get("anthropic-beta"), null);
  assert.equal(sonnet.requests[0].body.fallbacks, undefined);
  assert.deepEqual(sonnet.requests[0].body.thinking, { type: "adaptive", display: "summarized" });

  const haiku = setup([sse({ model: "claude-haiku-4-5", content: [use("h", "submit_result", VALID_SUBMISSION)] })], { model: "claude-haiku-4-5" });
  await haiku.run();
  assert.deepEqual(haiku.requests[0].body.thinking, { type: "enabled", budget_tokens: 8000 });
  assert.equal(haiku.requests[0].body.max_tokens, 32000);
});

test("invalid tool input and invalid results go back as errors, the run continues", async () => {
  const bad = { ...VALID_SUBMISSION, camera: { ...VALID_SUBMISSION.camera, lat: 123 } };
  const { run, requests } = setup([
    sse({ content: [use("a", "zoom_image", { x_min: 0.5 }), use("b", "submit_result", bad)] }),
    sse({ content: [use("c", "submit_result", VALID_SUBMISSION)] }),
  ]);
  const { analysis } = await run();
  assert.equal(analysis.camera.lat, 47.99);
  const results = requests[1].body.messages[2].content;
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content, /Ungültige Eingabe/);
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /Ergebnis ungültig/);
});

test("a refusal stops the run before any tool runs", async () => {
  const { run, events } = setup([
    sse({ stop_reason: "refusal", content: [use("r", "geocode", { query: "Hal" })] }),
  ]);
  await assert.rejects(run(), (err) => err.code === "REFUSAL" && /abgelehnt/.test(err.message));
  assert.equal(events.filter(([t]) => t === "tool_call").length, 0);
});

test("fallback: the declined part keeps only its text, the user is told once", async () => {
  const content = [
    { type: "thinking", thinking: "abgelehnt", signature: "x" },
    { type: "text", text: "Teil A" },
    use("dropped", "geocode", { query: "weg" }),
    { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
    { type: "text", text: "Teil B" },
    use("kept", "geocode", { query: "Freiburg" }),
  ];
  assert.deepEqual(echoable(content).map((b) => b.text ?? b.id), ["Teil A", "Teil B", "kept"]);
  assert.equal(echoable(content.slice(0, 3)).length, 3);

  const { run, requests, events } = setup([
    sse({ model: "claude-opus-4-8", content }),
    sse({ model: "claude-opus-4-8", content: [use("s", "submit_result", VALID_SUBMISSION)] }),
  ]);
  await run();
  const history = requests[1].body.messages;
  assert.deepEqual(history[1].content.map((b) => b.type), ["text", "text", "tool_use"]);
  assert.deepEqual(history[2].content.map((b) => b.tool_use_id), ["kept"]);
  const notes = events.filter(([t, d]) => t === "status" && /claude-opus-4-8/.test(d.message));
  assert.equal(notes.length, 1);
});

test("a tool call cut off by max_tokens is asked for again, not run", async () => {
  const { run, requests, events } = setup([
    sse({ stop_reason: "max_tokens", content: [use("cut", "geocode", { query: "Bahnh" })] }),
    sse({ content: [use("s", "submit_result", VALID_SUBMISSION)] }),
  ]);
  await run();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body.messages, requests[0].body.messages);
  assert.equal(events.filter(([t]) => t === "tool_call").length, 0);
});

test("no tool call: a reminder to submit follows", async () => {
  const { run, requests } = setup([
    sse({ stop_reason: "end_turn", content: [{ type: "text", text: "Ich denke, es ist Freiburg." }] }),
    sse({ content: [use("s", "submit_result", VALID_SUBMISSION)] }),
  ]);
  await run();
  const history = requests[1].body.messages;
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user"]);
  assert.match(history[2].content, /submit_result/);
});

test("errors: invalid key, empty credit, missing model get clear German messages", async () => {
  for (const [response, code, pattern] of [
    [apiError(401, "authentication_error", "invalid x-api-key"), "AUTH", /API-Key ist ungültig/],
    [apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."), "CREDITS", /Guthaben/],
    [apiError(404, "not_found_error", "model: claude-x"), "MODEL", /nicht verfügbar/],
  ]) {
    const { run } = setup([response]);
    await assert.rejects(run(), (err) => err.code === code && pattern.test(err.message));
  }
});

test("rate limit: waits as asked, then retries", async () => {
  const { run, requests, events } = setup([
    apiError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", { "retry-after": "0.01" }),
    sse({ content: [use("s", "submit_result", VALID_SUBMISSION)] }),
  ]);
  const { analysis } = await run();
  assert.ok(analysis);
  assert.equal(requests.length, 2);
  assert.ok(events.some(([t, d]) => t === "status" && /Ratenlimit.*Neuer Versuch in 0 s/.test(d.message)));
  assert.equal(describeClaudeError(new Error("kaputt")).reissue, true);
});

test("a garbled stream is asked for again at once", async () => {
  const garbled = () => new Response("event: message_start\ndata: {kein json\n\n", { headers: { "content-type": "text/event-stream" } });
  const { run, requests } = setup([garbled, sse({ content: [use("s", "submit_result", VALID_SUBMISSION)] })]);
  await run();
  assert.equal(requests.length, 2);
});

test("connection lost while in the background: waits for the page, then continues", async () => {
  let waits = 0;
  const { run, requests, events } = setup([
    () => { throw new TypeError("Failed to fetch"); },
    sse({ content: [use("s", "submit_result", VALID_SUBMISSION)] }),
  ], { whenActive: () => new Promise((r) => setTimeout(() => r(waits++ === 0), 80)) });
  await run();
  assert.equal(requests.length, 2);
  assert.ok(events.some(([t, d]) => t === "status" && /Hintergrund/.test(d.message)));
});

test("checkpoints after every round and resumes from the saved conversation", async () => {
  const saved = [];
  const first = setup([
    sse({ content: [use("g", "geocode", { query: "Bahnhofstraße" })] }),
  ], { checkpoint: async (s) => { saved.push(structuredClone(s)); throw new Error("Seite verworfen"); } });
  await assert.rejects(first.run(), /Seite verworfen/);
  const state = saved[0];
  assert.equal(state.step, 1);
  assert.deepEqual(state.conversation.map((m) => m.role), ["user", "assistant", "user"]);

  const second = setup([sse({ content: [use("s", "submit_result", VALID_SUBMISSION)] })]);
  const { analysis, usage } = await second.run(state);
  assert.ok(analysis);
  assert.equal(usage.requests, 2);
  assert.deepEqual(second.requests[0].body.messages, state.conversation);
  assert.deepEqual(second.events.find(([t]) => t === "step")[1], { step: 2, max_steps: 6 });
});

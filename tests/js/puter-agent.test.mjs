import assert from "node:assert/strict";
import { test } from "node:test";

import { OPENAI_TOOLS, PuterAgent, PuterError, describePuterError, handoffMessages } from "../../docs/js/puter-agent.js";
import { TILES_MARK } from "../../docs/js/compact.js";
import { ToolExecutor } from "../../docs/js/tools.js";
import { VALID_SUBMISSION } from "./fixtures.mjs";

const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (message, finish = "tool_calls") => ({ message: { role: "assistant", content: null, ...message }, finish_reason: finish, usage: { prompt_tokens: 900, completion_tokens: 80 } });

function setup(responses, options = {}) {
  const calls = [];
  const chat = async (messages, opts) => {
    calls.push({ messages: structuredClone(messages), opts });
    const next = responses.shift();
    if (typeof next === "function") return next();
    return next;
  };
  const events = [];
  const emit = (t, d) => events.push([t, d]);
  const osm = { geocode: async (q) => [{ name: `${q}, Deutschland`, lat: 47.99, lon: 7.85 }] };
  const executor = new ToolExecutor({
    zoom: async () => ({ data: "Wk9PTQ==", width: 1024, height: 768, sourceWidth: 120, sourceHeight: 90, thumbnail: "data:," }),
    osm, emit,
  });
  const agent = new PuterAgent({ chat, emit, maxSteps: 6, ...options });
  const run = () => agent.run({
    intro: "Wo ist das?",
    images: [{ type: "image", mime_type: "image/jpeg", data: "QkFTRQ==", resolution: "high" }, { type: "text", text: "Kachel" }],
    executor,
  });
  return { run, calls, events, executor, agent };
}

test("tools are declared in the OpenAI function format", () => {
  assert.ok(OPENAI_TOOLS.length >= 8);
  for (const t of OPENAI_TOOLS) {
    assert.equal(t.type, "function");
    assert.ok(t.function.name && t.function.parameters.type === "object");
  }
});

test("full loop: zoom + geocode + hypothesis, then submit", async () => {
  const { run, calls, events } = setup([
    reply({
      content: "Ich prüfe das Schild.",
      reasoning: "Schild unten rechts.",
      reasoning_details: [{ type: "thinking", signature: "sig" }],
      tool_calls: [
        toolCall("c1", "zoom_image", { x_min: 0.7, y_min: 0.6, x_max: 0.9, y_max: 0.8, enhance: true, purpose: "Schild" }),
        toolCall("c2", "geocode", { query: "Bahnhofstraße", country_codes: "de" }),
        toolCall("c3", "mark_hypothesis", { label: "Südbaden", camera_lat: 47.99, camera_lon: 7.85, radius_km: 30 }),
      ],
    }),
    reply({ tool_calls: [toolCall("c4", "submit_result", VALID_SUBMISSION)] }),
  ]);
  const { analysis, usage } = await run();
  assert.equal(analysis.subject.name, "Martinstor");
  assert.deepEqual(usage, { requests: 2, input_tokens: 1800, output_tokens: 160, thought_tokens: 0, cached_tokens: 0 });

  const first = calls[0];
  assert.equal(first.opts.model, "gemini-3.8-flash");
  assert.equal(first.opts.normalize, true);
  assert.equal(first.opts.tools, OPENAI_TOOLS);
  assert.equal(first.messages[0].role, "system");
  const userParts = first.messages[1].content;
  assert.match(userParts[0].text, /^Wo ist das\?\n\nBudget: höchstens 6 Runden/);
  assert.deepEqual(userParts[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,QkFTRQ==" } });
  assert.deepEqual(userParts[2], { type: "text", text: "Kachel" });

  // Second request: assistant turn echoed (with reasoning_details), one tool message per call, then the zoom image.
  const history = calls[1].messages;
  assert.deepEqual(history.slice(2).map((m) => m.role), ["assistant", "tool", "tool", "tool", "user"]);
  assert.deepEqual(history[2].reasoning_details, [{ type: "thinking", signature: "sig" }]);
  assert.deepEqual(history.slice(3, 6).map((m) => m.tool_call_id), ["c1", "c2", "c3"]);
  assert.ok(history.slice(3, 6).every((m) => typeof m.content === "string"));
  assert.equal(JSON.parse(history[4].content)[0].lat, 47.99);
  const imageMsg = history[6].content;
  assert.match(imageMsg[0].text, /Ausschnitt/);
  assert.deepEqual(imageMsg[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,Wk9PTQ==" } });

  const types = events.map(([t]) => t);
  for (const t of ["step", "thinking", "note", "zoom", "hypothesis", "tool_call", "tool_result"]) assert.ok(types.includes(t), t);
});

test("text-only answer is nudged, broken JSON arguments are reported back", async () => {
  const { run, calls } = setup([
    reply({ content: "Freiburg." }, "stop"),
    reply({ tool_calls: [{ id: "x", type: "function", function: { name: "geocode", arguments: "{kaputt" } }] }),
    reply({ tool_calls: [toolCall("c1", "submit_result", VALID_SUBMISSION)] }),
  ]);
  await run();
  assert.match(calls[1].messages.at(-1).content, /submit_result/);
  assert.match(calls[2].messages.at(-1).content, /kein gültiges JSON/);
});

test("Puter errors become clear German messages; busy errors are retried", async () => {
  assert.equal(describePuterError({ error: { code: "insufficient_funds", message: "Insufficient funds" } }).code, "ALLOWANCE");
  assert.equal(describePuterError({ message: "User cancelled sign in" }).code, "AUTH");
  assert.equal(describePuterError(new Error("429 Too Many Requests")).retryable, true);
  assert.match(describePuterError({ foo: 1 }).message, /Fehler bei Puter/);

  const { run, calls } = setup([
    () => { throw { error: { code: "rate_limited", message: "Too many requests" } }; },
    reply({ tool_calls: [toolCall("c1", "submit_result", VALID_SUBMISSION)] }),
  ]);
  const t0 = Date.now();
  await run();
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - t0 >= 1900);

  const denied = setup([() => { throw { error: { code: "insufficient_funds", message: "Insufficient funds" } }; }]);
  await assert.rejects(denied.run(), /Puter-Guthaben/);
});

test("refusal and step limit", async () => {
  await assert.rejects(setup([reply({ content: "Nein." }, "content_filter")]).run(), /abgelehnt/);
  const loop = Array.from({ length: 3 }, (_, i) => reply({ tool_calls: [toolCall(`c${i}`, "geocode", { query: "x" })] }));
  const limited = setup(loop, { maxSteps: 3 });
  await assert.rejects(limited.run(), /Schrittlimit/);
  assert.match(limited.calls[2].messages.at(-1).content.at(-1).text, /Nur noch 1 Runde/);
});

test("Puter: checkpoints after every round and resumes from the saved messages", async () => {
  const saved = [];
  const first = setup([reply({ tool_calls: [toolCall("c1", "geocode", { query: "Bahnhofstraße" })] })], {
    checkpoint: async (s) => { saved.push(structuredClone(s)); throw new Error("Seite verworfen"); },
  });
  await assert.rejects(first.run(), /Seite verworfen/);
  const [state] = saved;
  assert.equal(state.step, 1);
  assert.deepEqual(state.conversation.map((m) => m.role), ["system", "user", "assistant", "tool"]);

  const second = setup([reply({ tool_calls: [toolCall("c2", "submit_result", VALID_SUBMISSION)] })]);
  const { analysis, usage } = await second.agent.run({ intro: "egal", images: [], executor: second.executor, resume: state });
  assert.equal(analysis.city, "Freiburg");
  assert.deepEqual(second.calls[0].messages, state.conversation);
  assert.deepEqual(second.events.filter(([t]) => t === "step").map(([, d]) => d.step), [2]);
  assert.equal(usage.requests, 2);
});

test("Puter: a connection dropped in the background is retried once the page is visible", async () => {
  const drop = () => Promise.reject({ error: { message: "Failed to fetch" } });
  let waits = 0;
  const started = Date.now();
  const { run, calls } = setup([drop, drop, drop, drop, drop, reply({ tool_calls: [toolCall("c1", "submit_result", VALID_SUBMISSION)] })], {
    whenActive: async () => (waits++ < 5),
  });
  const { analysis } = await run();
  assert.equal(analysis.city, "Freiburg");
  assert.equal(calls.length, 6);
  assert.ok(Date.now() - started < 1500);
});

test("a request that hangs without an answer is asked again after the stall limit", async () => {
  const { run, calls, events } = setup([
    () => new Promise(() => {}), // Puter never answers this one
    reply({ tool_calls: [toolCall("c1", "submit_result", VALID_SUBMISSION)] }),
  ], { stallMs: 40 });
  const { analysis } = await run();
  assert.equal(analysis.subject.name, "Martinstor");
  assert.equal(calls.length, 2, "the same round asked again");
  assert.deepEqual(calls[1].messages, calls[0].messages);
  const warning = events.find(([t]) => t === "warning");
  assert.match(warning[1].message, /kein Lebenszeichen – Ortfinder fragt dieselbe Runde neu an \(Versuch 2 von 4\)/);
});

test("a service that keeps hanging gives up after four attempts with a clear message", async () => {
  const { run, calls } = setup(Array.from({ length: 6 }, () => () => new Promise(() => {})), { stallMs: 15 });
  await assert.rejects(run(), /Die KI hat 4× nicht geantwortet.*anderen Anbieter/);
  assert.equal(calls.length, 4);
});

test("a busy model hands over to the next one with the analysis so far, and gets it back later", async () => {
  const busy = () => { throw { error: { code: 503, message: "Model is overloaded" } }; };
  const { run, calls, events } = setup([
    reply({ tool_calls: [toolCall("c1", "geocode", { query: "Bahnhofstraße" })] }),
    busy, busy,
    reply({ tool_calls: [toolCall("c2", "geocode", { query: "Martinstor" })] }),
    reply({ tool_calls: [toolCall("c3", "submit_result", VALID_SUBMISSION)] }),
  ], { model: "gemini-3.8-flash", fallbackModels: ["gemini-3.1-flash-lite", "gpt-5.4-mini"], backAfterMs: 0 });
  const { analysis } = await run();
  assert.equal(analysis.subject.name, "Martinstor");
  assert.deepEqual(calls.map((c) => c.opts.model), ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash"]);
  const handed = calls[3].messages;
  assert.deepEqual(handed.map((m) => m.role), ["system", "user"], "a fresh start with a transcript, no foreign thinking");
  const note = handed[1].content.find((p) => p.type === "text" && p.text.startsWith("Bisheriger Stand dieser Analyse")).text;
  assert.match(note, /bis hier mit gemini-3\.8-flash; du setzt als gemini-3\.1-flash-lite fort/);
  assert.match(note, /→ geocode \{"query":"Bahnhofstraße"\}\n  ← .*Bahnhofstraße, Deutschland/);
  assert.match(calls[4].messages[1].content.find((p) => p.type === "text" && p.text.startsWith("Bisheriger Stand")).text, /Bahnhofstraße[\s\S]*Martinstor/);
  assert.ok(events.some(([t, d]) => t === "status" && d.message === "gemini-3.8-flash ist gerade überlastet – Ortfinder macht mit gemini-3.1-flash-lite weiter (der bisherige Stand geht mit) und versucht es in 0 s wieder mit gemini-3.8-flash."));
  assert.ok(events.some(([t, d]) => t === "status" && d.message === "Ortfinder versucht es wieder mit gemini-3.8-flash (der bisherige Stand geht mit)."));
});

test("a stuck model is left at once when another one is at hand; an account limit is waited out instead", async () => {
  const stuck = setup([
    () => new Promise(() => {}),
    reply({ tool_calls: [toolCall("c1", "submit_result", VALID_SUBMISSION)] }),
  ], { model: "gemini-3.8-flash", fallbackModels: ["gemini-3.1-flash-lite"], stallMs: 40 });
  await stuck.run();
  assert.deepEqual(stuck.calls.map((c) => c.opts.model), ["gemini-3.8-flash", "gemini-3.1-flash-lite"]);
  assert.ok(stuck.events.some(([t, d]) => t === "status" && /^gemini-3\.8-flash antwortet nicht – Ortfinder macht mit gemini-3\.1-flash-lite weiter/.test(d.message)));
  // A per-minute limit of the account (explicit wait): switching models would not help.
  const limit = new PuterError("Kurz zu viele Anfragen.", { code: "BUSY", retryable: true, retryAfterMs: 20, maxRetries: 3 });
  const limited = setup([
    () => { throw limit; },
    reply({ tool_calls: [toolCall("c1", "submit_result", VALID_SUBMISSION)] }),
  ], { model: "m1", fallbackModels: ["m2"] });
  await limited.run();
  assert.deepEqual(limited.calls.map((c) => c.opts.model), ["m1", "m1"]);
});

test("hand-over transcript in chat format: tiles and old pictures stay behind, the current ones come along", () => {
  const img = (id) => ({ type: "image_url", image_url: { url: `data:${id}` } });
  const messages = [
    { role: "system", content: "SYS" },
    { role: "user", content: [{ type: "text", text: "Wo?" }, img("photo"), { type: "text", text: TILES_MARK }, img("tile")] },
    { role: "assistant", content: "Ich zoome.", reasoning_details: [{ signature: "geheim" }], tool_calls: [toolCall("a", "zoom_image", { x_min: 0.1 })] },
    { role: "tool", tool_call_id: "a", content: "Ausschnitt 1\n(Bild folgt in der nächsten Nachricht.)" },
    { role: "user", content: [{ type: "text", text: "Ausschnitt 1" }, img("z1")] },
    { role: "assistant", content: "", tool_calls: [toolCall("b", "zoom_image", { x_min: 0.2 })] },
    { role: "tool", tool_call_id: "b", content: "Ausschnitt 2" },
    { role: "user", content: [{ type: "text", text: "Ausschnitt 2" }, img("z2")] },
  ];
  const once = handoffMessages(messages, "m1", "m2");
  assert.deepEqual(once.map((m) => m.role), ["system", "user"]);
  const content = once[1].content;
  assert.deepEqual(content.slice(0, 2), [{ type: "text", text: "Wo?" }, img("photo")], "photo kept, tiles left out");
  const note = content[2].text;
  assert.ok(!note.includes("geheim"));
  assert.match(note, /KI: Ich zoome\.\n→ zoom_image \{"x_min":0\.1\}\n  ← Ausschnitt 1[\s\S]*  \[Bild: Ausschnitt 1\][\s\S]*→ zoom_image \{"x_min":0\.2\}\n  ← Ausschnitt 2$/);
  assert.deepEqual(content.slice(3), [{ type: "text", text: "Ausschnitt 2" }, img("z2")], "the current round's picture comes along");
  const twice = handoffMessages([...once, { role: "assistant", content: "", tool_calls: [toolCall("c", "geocode", { query: "X" })] }, { role: "tool", tool_call_id: "c", content: "1 Treffer" }], "m2", "m1");
  assert.equal(twice[1].content.filter((p) => p.type === "image_url").length, 1, "only the photo now");
  assert.match(twice[1].content[2].text, /Ausschnitt 2[\s\S]*→ geocode \{"query":"X"\}\n  ← 1 Treffer$/);
  assert.equal(handoffMessages(messages.slice(0, 2), "a", "b").length, 2, "nothing to hand over in the first round");
});

test("a page reloaded after a switch continues with the model it was using", async () => {
  const saved = [];
  const first = setup([
    () => new Promise(() => {}),
    reply({ tool_calls: [toolCall("c1", "geocode", { query: "Bahnhofstraße" })] }),
    () => { throw new PuterError("Seite geschlossen"); }, // the page goes away during this round
  ], { model: "m1", fallbackModels: ["m2"], stallMs: 30, backAfterMs: 60000, checkpoint: async (st) => { saved.push(structuredClone(st)); } });
  await assert.rejects(first.run(), /Seite geschlossen/);
  const state = saved.at(-1);
  assert.equal(state.model, "m2");
  const again = setup([reply({ tool_calls: [toolCall("c2", "submit_result", VALID_SUBMISSION)] })], { model: "m1", fallbackModels: ["m2"] });
  await again.agent.run({ intro: "x", images: [], executor: again.executor, resume: state });
  assert.deepEqual(again.calls.map((c) => c.opts.model), ["m2"]);
});

// Smaller requests. The AI services are stateless: every round resends the whole conversation. What the
// model already looked at in earlier rounds – images and long tool results – is replaced by short notes
// when sending (the stored conversation stays complete, and the model can ask again). The photo itself is
// always sent; the high-resolution detail tiles only with the first request. Claude keeps its history
// unchanged instead (edited history would invalidate its thinking; its prompt cache makes repeats cheap).

/** Marks where the detail tiles start in the first message (everything from here on is sent once). */
export const TILES_MARK = "Detail-Kacheln (nur in der ersten Runde mitgeschickt – später bei Bedarf zoom_image):";
export const TILES_NOTE = "[Die Detail-Kacheln wurden nur in der ersten Runde mitgeschickt – für Details zoom_image nutzen.]";
export const OLD_TEXT_CHARS = 700;

export function shortenOld(text, max = OLD_TEXT_CHARS) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)} … [aus einer früheren Runde gekürzt – bei Bedarf erneut abfragen]`;
}

export function oldImageNote(label = "") {
  const what = String(label).split(/[.:\n]/)[0].slice(0, 90).trim();
  return `[Bild aus einer früheren Runde nicht erneut mitgeschickt${what ? ` (${what})` : ""} – bei Bedarf erneut anfordern]`;
}

/** Split neutral first-message blocks into what is always sent and the tiles (from TILES_MARK on). */
export function splitTiles(blocks) {
  const i = blocks.findIndex((b) => b.type === "text" && String(b.text).startsWith(TILES_MARK));
  return i < 0 ? [blocks, []] : [blocks.slice(0, i), blocks.slice(i)];
}

/** Neutral/Gemini result blocks from an earlier round: images become notes, long texts are cut. */
function compactBlocks(result) {
  if (typeof result === "string") return shortenOld(result);
  if (!Array.isArray(result)) return result;
  const label = result.find((b) => b.type === "text")?.text || "";
  return result.map((b) => (b.type === "image" ? { type: "text", text: oldImageNote(label) } : b.type === "text" ? { ...b, text: shortenOld(b.text) } : b));
}

/** Gemini Interactions history as sent: only the latest round's results in full. */
export function compactGemini(history) {
  if (history.length <= 1) return history;
  let latest = history.length;
  while (latest > 0 && history[latest - 1].type === "function_result") latest--;
  return history.map((item, i) => {
    if (i === 0 && item.type === "user_input" && Array.isArray(item.content)) {
      const [keep, tiles] = splitTiles(item.content);
      return tiles.length ? { ...item, content: [...keep, { type: "text", text: TILES_NOTE }] } : item;
    }
    if (item.type !== "function_result" || i >= latest) return item;
    return { ...item, result: compactBlocks(item.result) };
  });
}

/** OpenAI-style messages as sent (Puter, OpenRouter): everything after the last assistant turn stays whole. */
export function compactOpenAI(messages) {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistant < 0) return messages;
  return messages.map((m, i) => {
    if (i >= lastAssistant) return m;
    if (m.role === "tool") return typeof m.content === "string" ? { ...m, content: shortenOld(m.content) } : m;
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const first = messages.findIndex((x) => x.role === "user") === i;
    if (first) {
      const [keep, tiles] = splitTiles(m.content);
      return tiles.length ? { ...m, content: [...keep, { type: "text", text: TILES_NOTE }] } : m;
    }
    // Images of an earlier round, each announced by a text part before it.
    let label = "";
    return {
      ...m,
      content: m.content.map((p) => {
        if (p.type === "text") {
          label = p.text;
          return { ...p, text: shortenOld(p.text) };
        }
        return p.type === "image_url" ? { type: "text", text: oldImageNote(label) } : p;
      }),
    };
  });
}

/** Ollama messages as sent: images and long texts of earlier rounds dropped, tiles after the first answer. */
export function compactOllama(messages) {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistant < 0) return messages;
  return messages.flatMap((m, i) => {
    if (i >= lastAssistant) return [m];
    if (m.role === "user" && String(m.content).startsWith(TILES_MARK)) return [{ role: "user", content: TILES_NOTE }];
    // The model's own notes carry what it learned across rounds: never cut them.
    if (m.role === "system" || m.role === "assistant" || (m.role === "user" && i === messages.findIndex((x) => x.role === "user"))) return [m];
    const { images, ...rest } = m;
    const note = images?.length ? `\n${oldImageNote(m.content)}` : "";
    return [{ ...rest, content: `${shortenOld(m.content)}${note}` }];
  });
}

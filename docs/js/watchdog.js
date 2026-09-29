// Watchdog for requests to the AI and for tools: a connection that hangs without an error (Puter does
// that now and then) would otherwise stall an analysis for good. After a while without any sign of life
// the request is dropped and the same round is asked again.

/** Time without an answer after which a request counts as stuck (Puter, OpenRouter, Gemini). */
export const STALL_MS = 50000;
/** Retries of one round after a stall; each one waits a little longer. */
export const MAX_STALLS = 3;

export class StallError extends Error {
  constructor(ms) {
    super(`keine Antwort seit ${Math.round(ms / 1000)} s`);
    this.name = "StallError";
    this.ms = ms;
  }
}

/**
 * Run start(signal, alive) and reject with StallError when it shows no sign of life for `ms`: no answer
 * or, for streams, no new data (they call alive() for every piece). On a stall the signal aborts the
 * request where the service supports that; otherwise the late answer is simply ignored. An abort of
 * `outer` (the analysis was cancelled) rejects at once.
 */
export function watch(start, ms, outer = null) {
  const ctrl = new AbortController();
  let timer = null;
  let fail;
  const stopped = new Promise((_, reject) => {
    fail = reject;
  });
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const err = new StallError(ms);
      fail(err); // first, so the stall (not the abort it causes) is what the caller sees
      ctrl.abort(err);
    }, ms);
  };
  const onAbort = () => {
    const reason = outer.reason ?? new DOMException("Abgebrochen", "AbortError");
    fail(reason);
    ctrl.abort(reason);
  };
  if (outer?.aborted) onAbort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  alive();
  const work = Promise.resolve().then(() => start(ctrl.signal, alive));
  work.catch(() => {}); // a dropped request may still fail later; nobody waits for it any more
  return Promise.race([work, stopped]).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  });
}

/**
 * Time allowed for the next answer: the base (50 s), more when earlier answers of this analysis already
 * took long (a slow model is not stuck), and one base more for every retry of the same round.
 */
export function stallLimit(slowestMs, stalls, base = STALL_MS) {
  return Math.max(base, 1.5 * slowestMs) + stalls * base;
}

export const stallNote = (err, stalls, max = MAX_STALLS) =>
  `Die KI gibt seit ${Math.round(err.ms / 1000)} s kein Lebenszeichen – Ortfinder fragt dieselbe Runde neu an (Versuch ${stalls + 1} von ${max + 1}) …`;

export const stallGiveUp = (stalls) =>
  `Die KI hat ${stalls}× nicht geantwortet. Der Dienst hängt gerade – bitte später erneut versuchen oder unter ⚙ einen anderen Anbieter wählen.`;

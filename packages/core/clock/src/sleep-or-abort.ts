import type { Clock, Millis } from "./types.js";

/**
 * Sleep on the clock, but resolve early if `signal` aborts first.
 *
 * Resolves `false` when the sleep completes normally, `true` when the
 * signal aborted before the sleep finished (immediately `true` if the
 * signal is already aborted on entry). Never rejects — the caller decides
 * what an early wake means, this only reports which side won the race.
 *
 * Clock owns time, so this is the one place that pattern lives. It used
 * to be reimplemented per call site; a review flagged the third copy (added in cf814eb) as
 * (`sleepUnlessAborted`, queue consumer) — "three sites to
 * audit if an edge case surfaces" — this consolidates the delay-based
 * copies (retry's inter-attempt wait, the queue's receive backoff) into
 * one. (The scheduler's tick wait races a wall-clock *deadline*, not a
 * relative delay, and leans on `clock.deadline`'s drift telemetry — a
 * different enough primitive that it stays separate rather than being
 * forced through this signature.)
 *
 * No `signal` means no early wake is possible: just sleeps and resolves
 * `false`, without paying for a listener that can never fire.
 */
export function sleepOrAbort(clock: Clock, delay: Millis, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    return clock.sleep(delay).then(() => false);
  }
  if (signal.aborted) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    void clock.sleep(delay).then(() => {
      if (settled) return;
      settled = true;
      // The sleep won the race — drop the listener so it doesn't sit on
      // `signal` for the rest of that signal's life. Same discipline as
      // `raceAttempt` in @phyxiusjs/handler: only the loser needs cleanup,
      // since `{ once: true }` already retires a listener that fires.
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    });
  });
}

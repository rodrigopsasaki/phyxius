/**
 * Temporal utilities for controlling function execution timing.
 * These functions help manage when and how often functions execute.
 *
 * Backed by `Clock.Budget` — at most one pending timer per debouncer/
 * throttler, regardless of input rate. Rapid bursts of calls do not
 * accumulate sleep handles.
 */

import { deadlineFrom, elapsedSince } from "@phyxiusjs/clock";
import type { Budget, Clock, Millis, MonoMs } from "@phyxiusjs/clock";

/**
 * Debounce a function. The wrapped function fires once, after `delayMs` have
 * elapsed with no new calls. Each call replaces the pending fire — the latest
 * arguments win.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: Millis,
  clock: Clock,
): (...args: A) => void {
  // Holds the current pending budget + the args that should fire when it
  // expires. On each new call, the previous budget is released (no fire) and
  // a fresh one is created. At most one pending budget at any time.
  let pending: { budget: Budget; args: A } | null = null;

  return (...args: A) => {
    pending?.budget.release();

    const budget = clock.timeout(delayMs);
    const entry = { budget, args };
    pending = entry;

    budget.signal.addEventListener(
      "abort",
      () => {
        if (pending === entry) {
          pending = null;
          fn(...entry.args);
        }
      },
      { once: true },
    );
  };
}

/**
 * Throttle a function. The wrapped function fires immediately on a call that
 * falls outside the throttle window, and at most once more at the end of the
 * window with the most recent arguments.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: Millis,
  clock: Clock,
): (...args: A) => void {
  let lastCallMono: MonoMs | null = null;
  // At most one trailing budget is in flight at any time. Subsequent calls
  // within the window update the trailing args without rescheduling.
  let trailing: { budget: Budget; args: A } | null = null;

  return (...args: A) => {
    const now = clock.now().monoMs;

    if (lastCallMono === null || elapsedSince(now, lastCallMono) >= delayMs) {
      // Outside the window — execute immediately and reset.
      lastCallMono = now;
      // A previously-scheduled trailing call is now obsolete; release it.
      trailing?.budget.release();
      trailing = null;
      fn(...args);
      return;
    }

    // Inside the window. Update the args we'll fire with at the end.
    if (trailing !== null) {
      trailing.args = args;
      return;
    }

    // Remaining delay: how long until `delayMs` have passed since
    // lastCallMono, from here — the window's own deadline, `elapsedSince`'d
    // against `now`. Same shape as the circuit breaker's `retryInMs`: a
    // FUTURE deadline measured back against the present.
    const remainingDelay = elapsedSince(deadlineFrom(lastCallMono, delayMs), now);
    const budget = clock.timeout(remainingDelay);
    const entry = { budget, args };
    trailing = entry;

    budget.signal.addEventListener(
      "abort",
      () => {
        if (trailing === entry) {
          trailing = null;
          lastCallMono = clock.now().monoMs;
          fn(...entry.args);
        }
      },
      { once: true },
    );
  };
}

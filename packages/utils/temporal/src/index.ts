/**
 * Temporal utilities for controlling function execution timing.
 * These functions help manage when and how often functions execute.
 */

import type { Clock, Millis } from "@phyxiusjs/clock";

/** Debounce a function using Clock abstraction */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: Millis,
  clock: Clock,
): (...args: A) => void {
  let latestCall: { args: A; timestamp: number } | null = null;

  return (...args: A) => {
    const timestamp = clock.now().monoMs;
    latestCall = { args, timestamp };

    clock.timeout(delayMs).then(() => {
      // Only execute if this is still the latest call
      if (latestCall && latestCall.timestamp === timestamp) {
        fn(...latestCall.args);
      }
    });
  };
}

/** Throttle a function using Clock abstraction */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: Millis,
  clock: Clock,
): (...args: A) => void {
  let lastCall: number | null = null;
  let pendingCall: { args: A; timestamp: number } | null = null;

  return (...args: A) => {
    const now = clock.now().monoMs;

    if (lastCall === null || now - lastCall >= delayMs) {
      // Execute immediately
      lastCall = now;
      fn(...args);
    } else {
      // Schedule for later
      const timestamp = now;
      pendingCall = { args, timestamp };

      const remainingDelay = (delayMs - (now - lastCall)) as Millis;
      clock.timeout(remainingDelay).then(() => {
        // Only execute if this is still the latest pending call
        if (pendingCall && pendingCall.timestamp === timestamp) {
          lastCall = clock.now().monoMs;
          fn(...pendingCall.args);
          pendingCall = null;
        }
      });
    }
  };
}

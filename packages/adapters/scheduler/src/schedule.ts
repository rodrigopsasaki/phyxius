import type { Instant, Millis } from "@phyxiusjs/clock";

import type { Schedule } from "./types.js";

// ── Built-in schedules ─────────────────────────────────────────────────────

/**
 * Fire every `intervalMs`, starting from the first `nextTick` call.
 *
 * The first tick lands at `after + intervalMs` — no "fire immediately on
 * start" semantics. If you want that, call the handler once before starting
 * the scheduler. Keeping the schedule pure (no boot-time side effect)
 * matches the rest of Phyxius: schedules are values, not triggers.
 *
 * Passing `intervalMs <= 0` throws at construction time — an interval
 * schedule that fires forever at zero delay would saturate the loop.
 */
export function every(intervalMs: Millis): Schedule {
  if ((intervalMs as number) <= 0) {
    throw new Error(`schedule.every: intervalMs must be > 0 (got ${intervalMs})`);
  }
  return {
    nextTick(after: Instant): Instant {
      return {
        wallMs: after.wallMs + (intervalMs as number),
        monoMs: after.monoMs + (intervalMs as number),
      };
    },
  };
}

/**
 * One-shot schedule. Fires once at `instant` if `instant` is strictly after
 * the current time, otherwise never fires. After the single tick, the
 * schedule is exhausted (`nextTick` returns `null`) and the scheduler
 * drops the job from rotation.
 *
 * Captured in a closure so `at` is stateful — once consumed, it's gone.
 * This matches the semantic: a one-shot doesn't re-arm.
 */
export function at(instant: Instant): Schedule {
  let consumed = false;
  return {
    nextTick(after: Instant): Instant | null {
      if (consumed) return null;
      if (instant.wallMs <= after.wallMs) {
        // Already in the past; one-shot fires once, then exhausts.
        consumed = true;
        return null;
      }
      consumed = true;
      return instant;
    },
  };
}

/**
 * A schedule that never fires. Useful as a default or placeholder in
 * conditional job lists. The scheduler drops jobs with `never()` immediately
 * on start (`scheduler:job-exhausted`).
 */
export function never(): Schedule {
  return {
    nextTick(): Instant | null {
      return null;
    },
  };
}

/**
 * Schedule namespace — ergonomic grouping matching `retry`, `cb`, `resource`.
 */
export const schedule = {
  every,
  at,
  never,
} as const;

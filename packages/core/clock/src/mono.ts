import type { Millis, MonoMs } from "./types.js";

/**
 * How much time has passed since `then`, observed at `now`. THE ONLY
 * subtraction that means anything for a pair of `MonoMs` values.
 *
 * Raw `now - then` compiles — TypeScript's `-` only checks that both sides
 * are number-like, not that they carry the same brand — but the result is
 * a bare `number` with both brands stripped, which no longer satisfies
 * `Millis` at the next assignment. Routing the subtraction through this
 * function instead means the RESULT stays branded all the way to where
 * it's used, and the clamp below lives in one place instead of being
 * re-derived (or forgotten) at every call site.
 *
 * Clamped to 0. `now` and `then` only mean something as two readings of
 * the SAME process's monotonic clock; `now` before `then` isn't a negative
 * duration, it's either a caller passing the pair backwards or a
 * deliberate "how long until" computation (see `deadlineFrom` +
 * `hasPassed`) that hasn't happened yet. Zero is the honest floor for
 * both.
 */
export function elapsedSince(now: MonoMs, then: MonoMs): Millis {
  const delta = now - then;
  return (delta < 0 ? 0 : delta) as Millis;
}

/**
 * The `MonoMs` reading `ms` after `now`. THE ONLY addition that means
 * anything for a `MonoMs` value, for the same reason `elapsedSince` is the
 * only subtraction: `now + ms` compiles and produces a bare `number`,
 * which then fails the moment it's stored back somewhere `MonoMs` is
 * expected (a deadline field, a snapshot, the next `elapsedSince` call).
 *
 * This is the one place outside `now()` itself — in either `Clock`
 * implementation — that mints a `MonoMs` from arithmetic rather than a
 * fresh clock read, which is why the cast lives here and nowhere else a
 * consumer package should need it. It's sound specifically because `now`
 * is never a bare literal: it always traces back to a real `clock.now()`
 * read, and "that reading, plus a known duration" is still a claim about
 * the same clock's timeline, not a fabricated point on it.
 */
export function deadlineFrom(now: MonoMs, ms: Millis): MonoMs {
  return (now + ms) as MonoMs;
}

/**
 * Has `deadline` been reached, observed at `now`?
 *
 * Exists alongside `elapsedSince` because most callers checking a deadline
 * don't want the duration, they want the boolean, and `elapsedSince` can't
 * safely give it to them: its clamp makes "5ms before the deadline" and
 * "exactly at the deadline" both read back as `0`, the same number for two
 * states a caller usually needs to tell apart. `hasPassed(now, deadline)`
 * answers directly instead of asking the caller to reconstruct a boundary
 * the duration already erased. Pair with `deadlineFrom` to check "has `ms`
 * elapsed since `start`": `hasPassed(now, deadlineFrom(start, ms))`.
 */
export function hasPassed(now: MonoMs, deadline: MonoMs): boolean {
  return now >= deadline;
}

import type { Instant } from "./types.js";

/**
 * Format a wall-clock millisecond value as an ISO-8601 string
 * (`1970-01-01T00:00:00.000Z`).
 *
 * This is the ONE place in Phyxius that calls `new Date(...)`. Everywhere
 * else, callers should pass an `Instant` (from `clock.now()`) or a raw `wallMs`
 * number through this helper — never construct a `Date` inline.
 *
 * Why this matters: `new Date()` with no arguments reads ambient system time
 * and bypasses the injected Clock, defeating deterministic tests. By routing
 * all ISO formatting through a single helper, we make that ambient-read
 * impossible by construction.
 *
 * The argument is a number of milliseconds since epoch, or an `Instant`
 * (from which the wallMs component is extracted). Never `undefined` — if you
 * have an `Instant` from `clock.now()`, pass it directly.
 */
export function formatIso(source: number | Instant): string {
  const wallMs = typeof source === "number" ? source : source.wallMs;
  // Deliberate, audited use of `new Date(number)`. Takes a numeric value,
  // wraps it in a Date for formatting. Does NOT read ambient system time.
  return new Date(wallMs).toISOString();
}

/**
 * Branded type for milliseconds to prevent mixing different time units
 */
export type Millis = number & { readonly __brand: "millis" };

/**
 * Branded type for a monotonic clock reading — the `monoMs` face of an
 * `Instant`. A `MonoMs` is a POINT, not a distance: meaningless in
 * isolation, and meaningful only relative to another `MonoMs` from the
 * same process's clock (`SystemClock` anchors it to `performance.now()` at
 * process start; `ControlledClock` anchors it to whatever `initialTime` a
 * test chose). It is never an epoch and never portable across a process —
 * two different processes' `MonoMs` readings share no common origin.
 *
 * Distinct from `Millis` on purpose, and deliberately NOT assignable to it.
 * `Millis` is a duration: safe to add, compare, serialize, and send over a
 * wire. `MonoMs` is an instant: the raw material a duration is measured
 * from, not a duration itself. Before this brand existed, that distinction
 * lived only in a variable name — `CircuitOpenError`'s old `willRetryAfter`
 * field was a monotonic instant with a name that read like a duration, and
 * during the 2026-08-01 vendor outage it was stored and rendered as an
 * epoch, producing 8.6 phantom hours on a customer PR and 1970 dates in ops
 * logs. `MonoMs` makes that specific misreading a compile error instead of
 * an incident.
 *
 * Raw `+`/`-` on two `MonoMs` values still "compiles" — TypeScript's
 * arithmetic operators check that both operands are number-like, not that
 * they share a brand — but the RESULT is a bare `number`, stripped of every
 * brand involved. That plain `number` doesn't satisfy `Millis` or `MonoMs`
 * at the next assignment, so the leak surfaces there instead of silently
 * riding along as a mistyped duration. The only sanctioned operations are
 * the named helpers in `mono.ts` (`elapsedSince`, `deadlineFrom`,
 * `hasPassed`) — each documents which raw operator it replaces and why.
 *
 * A `MonoMs` value is minted in exactly two ways: reading `clock.now()`, or
 * deriving one from an existing reading via `deadlineFrom`. There is no
 * public constructor from a bare number — unlike `ms()` below for `Millis`,
 * where a literal duration (`ms(10_000)`) is a meaningful, freely-writable
 * constant, there is no such thing as a meaningful literal *instant*: "the
 * monotonic clock read 10,000" means nothing without a clock that actually
 * read it.
 */
export type MonoMs = number & { readonly __brand: "monoMs" };

/**
 * Represents a point in time with both wall clock and monotonic time
 */
export interface Instant {
  /** Wall clock time in milliseconds since epoch (can jump due to system changes) */
  readonly wallMs: number;
  /** Monotonic time for measuring intervals (never goes backwards). See `MonoMs`. */
  readonly monoMs: MonoMs;
}

/**
 * Target for deadline operations
 */
export interface DeadlineTarget {
  /** When the deadline should fire (wall clock time) */
  readonly wallMs: number;
}

/**
 * Timer handle that can be cancelled
 */
export interface TimerHandle {
  /** Cancel the timer */
  cancel(): void;
}

/**
 * A time budget — a value that carries a deadline and an AbortSignal that
 * fires when the deadline passes.
 *
 * Semantically distinct from `sleep`:
 *   - `sleep(ms)` is first-person: "I wait."
 *   - `timeout(ms)` is third-person: "here is a ceiling for something else."
 *
 * A Budget is a value you pass down through an operation chain. Operations
 * that care about deadlines accept a Budget (or just its `signal` for
 * AbortSignal-aware APIs like `fetch`); operations that don't, ignore it.
 * Loops can consult `remaining()` or `expired()` to decide whether to continue.
 *
 * The signal is read-only. A Budget whose owner can shorten it is just a sleep.
 * If callers need early cancellation, compose with their own AbortController
 * via `AbortSignal.any([budget.signal, ownController.signal])`.
 */
export interface Budget {
  /** The moment at which this budget expires (wall + mono). */
  readonly deadline: Instant;
  /** Aborts when the budget expires. Pass to fetch, fs, streams, etc. */
  readonly signal: AbortSignal;
  /** Time remaining until expiry, in milliseconds. Clamped at 0. */
  remaining(): Millis;
  /** True once the budget has expired. Equivalent to `signal.aborted`. */
  expired(): boolean;
  /**
   * Proactively clear the underlying timer to prevent leaks when the caller
   * finishes before expiry. Does NOT abort the signal — a released budget is
   * "done with," not "expired."
   */
  release(): void;
}

/**
 * Common interface for all clock implementations
 */
export interface Clock {
  /**
   * Get the current time as an Instant
   */
  now(): Instant;

  /**
   * Sleep for a given duration in milliseconds.
   *
   * Use when the wait IS the intent: backoff, pacing, explicit delay.
   */
  sleep(ms: Millis): Promise<void>;

  /**
   * Create a time budget that expires after `ms` milliseconds.
   *
   * Use when time is a ceiling for some OTHER operation: bounding a
   * downstream call, pairing with fetch/fs/streams via AbortSignal,
   * or propagating a deadline down a call chain.
   *
   * This is NOT a promise — it is a value. Call `sleep` if you want to wait.
   */
  timeout(ms: Millis): Budget;

  /**
   * Set a deadline that resolves at a specific wall time
   */
  deadline(target: DeadlineTarget): Promise<void>;

  /**
   * Create an interval that fires a callback every ms milliseconds
   * Returns a handle that can be used to cancel the interval
   */
  interval(ms: Millis, callback: () => void | Promise<void>): TimerHandle;
}

/**
 * Event emitter function type
 */
export type EmitFn = (event: unknown) => void;

/**
 * Helper to create Millis values without casting noise
 */
export const ms = (n: number): Millis => n as Millis;

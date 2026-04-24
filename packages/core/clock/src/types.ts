/**
 * Branded type for milliseconds to prevent mixing different time units
 */
export type Millis = number & { readonly __brand: "millis" };

/**
 * Represents a point in time with both wall clock and monotonic time
 */
export interface Instant {
  /** Wall clock time in milliseconds since epoch (can jump due to system changes) */
  readonly wallMs: number;
  /** Monotonic time in milliseconds for measuring intervals (never goes backwards) */
  readonly monoMs: number;
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

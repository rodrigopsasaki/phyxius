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
 * Common interface for all clock implementations
 */
export interface Clock {
  /**
   * Get the current time as an Instant
   */
  now(): Instant;

  /**
   * Sleep for a given duration in milliseconds
   */
  sleep(ms: Millis): Promise<void>;

  /**
   * Set a timeout that resolves after ms milliseconds
   */
  timeout(ms: Millis): Promise<void>;

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

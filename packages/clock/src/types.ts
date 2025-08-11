/**
 * Represents a point in time with both wall clock and monotonic time
 */
export interface Instant {
  /** Wall clock time in milliseconds since epoch */
  readonly wallMs: number;
  /** Monotonic time in milliseconds for measuring intervals */
  readonly monoMs: number;
}

/**
 * Timer handle that can be cleared
 */
export interface TimerHandle {
  readonly id: number | NodeJS.Timeout;
  clear(): void;
}

/**
 * Common interface for all clock implementations
 */
export interface Clock {
  /**
   * Get the current time
   */
  now(): Instant;

  /**
   * Sleep for a given duration in milliseconds
   */
  sleep(ms: number): Promise<void>;

  /**
   * Set a deadline that resolves at a specific time
   * @param at - Either milliseconds from now or an absolute wall time
   */
  deadline(at: number): Promise<void>;

  /**
   * Create an interval that fires a callback every ms milliseconds
   */
  interval(ms: number, callback: () => void | Promise<void>): TimerHandle;
}

/**
 * Vision event emitter function type
 */
export type EmitFn = (event: unknown) => void;

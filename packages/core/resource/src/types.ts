import type { Clock, Instant } from "@phyxiusjs/clock";

// ── Acquire / Release ──────────────────────────────────────────────────────

/** A function that produces a resource. May be async. */
export type Acquire<T> = () => T | Promise<T>;

/**
 * A function that releases a resource. May be async. Should be idempotent —
 * the framework guarantees release is called exactly once per successful
 * acquire, but defensive implementations make debugging easier.
 */
export type Release<T> = (value: T) => void | Promise<void>;

/** The body that runs between acquire and release. */
export type UseFn<T, R> = (value: T) => R | Promise<R>;

// ── Resource ───────────────────────────────────────────────────────────────

/**
 * A typed, composable acquire/release pair. The `use(fn)` method guarantees
 * that `release` is called exactly once for every successful `acquire`,
 * regardless of whether `fn`:
 *
 *   - resolves normally
 *   - throws synchronously
 *   - rejects asynchronously
 *   - never runs (because acquire threw)
 *
 * Resources compose via `parallel` and `sequence` (on the `resource`
 * namespace); nested `use()` calls compose trivially through normal
 * `async/await`.
 */
export interface Resource<T> {
  /**
   * Acquire the resource, run `fn(value)`, and guarantee release. Returns
   * the value `fn` produced. If acquire throws, `fn` is never called and
   * no release fires. If `fn` throws, the error is re-thrown AFTER release
   * completes — release errors are emitted as events, not thrown, so they
   * never mask the original failure.
   */
  use<R>(fn: UseFn<T, R>): Promise<R>;

  /**
   * Transform the acquired value without affecting lifecycle. The new
   * resource shares the same acquire / release; only the value exposed
   * to `use()` is mapped.
   */
  map<U>(fn: (value: T) => U): Resource<U>;
}

// ── Options ────────────────────────────────────────────────────────────────

/**
 * Options applied when creating a resource. All optional — a Resource is
 * fully functional with no options, but supplying a `clock` and `emit`
 * unlocks duration tracking and observability events.
 */
export interface ResourceOptions {
  /**
   * Optional name for journal / event identity. If omitted, events carry
   * no name and log lines read "anonymous resource." Real resources should
   * always name themselves.
   */
  readonly name?: string;

  /**
   * Injected clock for duration measurement and event timestamps. Required
   * if `emit` is set; events carry `Instant`s sourced from this clock.
   */
  readonly clock?: Clock;

  /**
   * Structured event sink. Called synchronously on acquire, release, and
   * failure boundaries. Same shape as the rest of Phyxius — `emit` never
   * throws (the framework catches), and sinks shouldn't block.
   */
  readonly emit?: (event: ResourceEvent) => void;
}

// ── Events ─────────────────────────────────────────────────────────────────

/**
 * Lifecycle events. Emitted in-band on the acquire → use → release chain
 * when `emit` is supplied on the resource's options.
 */
export type ResourceEvent =
  | {
      readonly type: "resource:acquired";
      readonly name: string | undefined;
      readonly at: Instant;
      readonly durationMs: number;
    }
  | {
      readonly type: "resource:released";
      readonly name: string | undefined;
      readonly at: Instant;
      readonly durationMs: number;
    }
  | {
      readonly type: "resource:acquire-failed";
      readonly name: string | undefined;
      readonly at: Instant;
      readonly cause: unknown;
    }
  /**
   * Release itself threw. The release error is SWALLOWED — if the original
   * `use()` body threw, that original error propagates unchanged. This
   * event is the only surface that makes the release failure visible, so
   * production systems should always wire `emit` to their journal.
   */
  | {
      readonly type: "resource:release-failed";
      readonly name: string | undefined;
      readonly at: Instant;
      readonly cause: unknown;
      readonly duringUseError: boolean;
    };

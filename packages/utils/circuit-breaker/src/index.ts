import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import { createAtom, type Atom, type Change } from "@phyxiusjs/atom";
import { ok, err, type Result } from "@phyxiusjs/fp";

// ── State machine ───────────────────────────────────────────────────────────

/**
 * Circuit breaker state.
 *
 *  - **closed** — calls pass through. Consecutive failures are counted.
 *  - **open** — calls fail fast with `Err({ type: "CIRCUIT_OPEN" })` until the
 *    reset timeout elapses.
 *  - **half-open** — one probe call is allowed; success closes the circuit,
 *    failure reopens it.
 */
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  /** Monotonic timestamp when the circuit was opened (only meaningful in "open"). */
  readonly openedAt: number;
}

// ── Policy ──────────────────────────────────────────────────────────────────

/**
 * Circuit-breaker configuration. Constructed via `cb.policy(...)` or
 * `cb.none()`. Every field required on the opinionated path — "no decision"
 * is also a decision, and you declare it as `cb.none()` rather than by
 * omission.
 */
export interface CircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly resetTimeout: Millis;
  readonly enabled: boolean;
}

export const cb = {
  /**
   * Explicit "no circuit breaker" policy. All calls pass through directly.
   * Use this to declare "I've thought about it and chose no circuit breaker"
   * rather than leaving the field implicit.
   */
  none(): CircuitBreakerPolicy {
    return {
      failureThreshold: Infinity,
      resetTimeout: 0 as Millis,
      enabled: false,
    };
  },

  /**
   * Standard circuit breaker policy.
   *
   * @param options.failureThreshold - Open the circuit after this many
   *   consecutive failures. Must be ≥ 1.
   * @param options.resetTimeout - After the circuit opens, wait this long
   *   before transitioning to half-open and allowing a probe call.
   */
  policy(options: { failureThreshold: number; resetTimeout: Millis }): CircuitBreakerPolicy {
    if (options.failureThreshold < 1) {
      throw new Error(`cb.policy: failureThreshold must be >= 1 (got ${options.failureThreshold})`);
    }
    return {
      failureThreshold: options.failureThreshold,
      resetTimeout: options.resetTimeout,
      enabled: true,
    };
  },
};

// ── Events ──────────────────────────────────────────────────────────────────

export type CircuitEvent =
  | { readonly type: "circuit:opened"; readonly consecutiveFailures: number; readonly at: Instant }
  | { readonly type: "circuit:half-open"; readonly at: Instant }
  | { readonly type: "circuit:closed"; readonly at: Instant };

// ── Error ───────────────────────────────────────────────────────────────────

export interface CircuitOpenError {
  readonly type: "CIRCUIT_OPEN";
  readonly openedAt: number;
  readonly willRetryAfter: number;
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface CircuitBreaker {
  /**
   * Execute `fn` through the circuit. Short-circuits with `CIRCUIT_OPEN` when
   * the breaker is open; otherwise passes the result through, recording
   * success or failure for state-machine purposes.
   *
   * Errors thrown by `fn` propagate as a rejected promise — we don't swallow
   * them into a Result because the caller likely wants them. The breaker
   * tracks them for its own state transitions only.
   */
  execute<T>(fn: () => Promise<T>): Promise<Result<T, CircuitOpenError>>;

  /** Current snapshot. Useful for metrics and diagnostics. */
  snapshot(): CircuitSnapshot;

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  watch(callback: (event: CircuitEvent) => void): () => void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export interface CircuitBreakerOptions {
  readonly policy: CircuitBreakerPolicy;
  readonly clock: Clock;
}

/**
 * Create a circuit breaker. State is held in an Atom so it's observable and
 * testable. Transitions are Clock-driven — the half-open timeout is evaluated
 * against `clock.now()`, not `Date.now()`.
 */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const { policy, clock } = options;

  const state: Atom<CircuitSnapshot> = createAtom<CircuitSnapshot>(
    {
      state: "closed",
      consecutiveFailures: 0,
      openedAt: 0,
    },
    clock,
  );

  const watchers = new Set<(event: CircuitEvent) => void>();

  // Bridge atom state transitions into CircuitEvents.
  state.watch((change: Change<CircuitSnapshot>) => {
    if (change.from.state === change.to.state) return;

    const event = toCircuitEvent(change);

    for (const watcher of watchers) {
      try {
        watcher(event);
      } catch {
        // A watcher threw — swallow, don't cascade. Consumers route through
        // their own journal if they care.
      }
    }
  });

  return {
    async execute<T>(fn: () => Promise<T>): Promise<Result<T, CircuitOpenError>> {
      if (!policy.enabled) {
        // Policy is `cb.none()` — pass through. The function's errors still
        // throw out of execute(); we just don't track them.
        const value = await fn();
        return ok(value);
      }

      // Before calling: check if we should transition open → half-open.
      const current = state.deref();
      if (current.state === "open") {
        const elapsed = clock.now().monoMs - current.openedAt;
        if (elapsed < policy.resetTimeout) {
          return err({
            type: "CIRCUIT_OPEN",
            openedAt: current.openedAt,
            willRetryAfter: current.openedAt + policy.resetTimeout,
          });
        }
        // Timeout elapsed — allow a probe call.
        state.swap((s) => ({ ...s, state: "half-open" }));
      }

      try {
        const value = await fn();
        // Success closes the circuit from any state.
        state.swap(() => ({ state: "closed", consecutiveFailures: 0, openedAt: 0 }));
        return ok(value);
      } catch (error) {
        state.swap((s) => {
          // In half-open, ANY failure reopens the circuit immediately.
          if (s.state === "half-open") {
            return {
              state: "open",
              consecutiveFailures: s.consecutiveFailures + 1,
              openedAt: clock.now().monoMs,
            };
          }

          // In closed, count the failure and open when threshold is hit.
          const next = s.consecutiveFailures + 1;
          if (next >= policy.failureThreshold) {
            return {
              state: "open",
              consecutiveFailures: next,
              openedAt: clock.now().monoMs,
            };
          }
          return { ...s, consecutiveFailures: next };
        });

        // Propagate the underlying error — callers decide what to do.
        throw error;
      }
    },

    snapshot(): CircuitSnapshot {
      return state.deref();
    },

    watch(callback: (event: CircuitEvent) => void): () => void {
      watchers.add(callback);
      return () => {
        watchers.delete(callback);
      };
    },
  };
}

/**
 * Map an atom state transition to its corresponding CircuitEvent.
 * Pulled out as a named function so the reader doesn't parse a nested
 * ternary to understand it — it's a flat switch over the target state.
 */
function toCircuitEvent(change: Change<CircuitSnapshot>): CircuitEvent {
  switch (change.to.state) {
    case "open":
      return {
        type: "circuit:opened",
        consecutiveFailures: change.to.consecutiveFailures,
        at: change.at,
      };
    case "half-open":
      return { type: "circuit:half-open", at: change.at };
    case "closed":
      return { type: "circuit:closed", at: change.at };
  }
}

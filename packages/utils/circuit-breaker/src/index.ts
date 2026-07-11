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

// ── Admission ─────────────────────────────────────────────────────────────────

/**
 * What `execute` should do given the current snapshot, computed before any
 * state mutation. Classification is kept separate from action so the
 * deref→act→swap sequence can't smuggle in an implicit transition: we decide
 * here, then act once.
 *
 *  - **pass** — closed; run `fn` directly.
 *  - **short-circuit** — fail fast. Either open within the reset window, or
 *    half-open with a probe already in flight (the contract admits exactly
 *    one probe, so a second concurrent caller must not run).
 *  - **claim-probe** — open and the reset window elapsed. Admission is granted
 *    by atomically claiming the half-open slot (`open` → `half-open`) via CAS.
 *    The winner runs `fn`; losers fall back to short-circuit.
 */
type Admission =
  | { readonly kind: "pass" }
  | { readonly kind: "short-circuit"; readonly openedAt: number }
  | { readonly kind: "claim-probe"; readonly from: CircuitSnapshot };

/**
 * Pure classification: map a snapshot + current time to an admission decision.
 * No mutation, no side effects — the caller acts on the result. Total over the
 * three named states so a new state can't silently fall through to `pass`.
 */
function classify(current: CircuitSnapshot, nowMs: number, resetTimeout: number): Admission {
  switch (current.state) {
    case "closed":
      return { kind: "pass" };
    case "half-open":
      // A probe is already in flight (some caller claimed the slot). Until it
      // resolves to closed or open, additional callers fail fast — one probe.
      return { kind: "short-circuit", openedAt: current.openedAt };
    case "open": {
      const elapsed = nowMs - current.openedAt;
      if (elapsed < resetTimeout) {
        return { kind: "short-circuit", openedAt: current.openedAt };
      }
      return { kind: "claim-probe", from: current };
    }
  }
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

      // Classify first (pure), then act once. When the reset window has
      // elapsed we must admit exactly one probe: claim the half-open slot with
      // a single CAS (open → half-open). Concurrent callers race the CAS — the
      // loser sees `false` and short-circuits, so only one trial runs.
      const admission = classify(state.deref(), clock.now().monoMs, policy.resetTimeout);

      if (admission.kind === "short-circuit") {
        return err({
          type: "CIRCUIT_OPEN",
          openedAt: admission.openedAt,
          willRetryAfter: admission.openedAt + policy.resetTimeout,
        });
      }

      if (admission.kind === "claim-probe") {
        const claimed = state.compareAndSet(admission.from, { ...admission.from, state: "half-open" });
        if (!claimed) {
          // Another caller already took the probe slot (or the state moved on);
          // re-derive and short-circuit rather than running a second trial.
          const now = state.deref();
          const openedAt = now.state === "open" ? now.openedAt : admission.from.openedAt;
          return err({
            type: "CIRCUIT_OPEN",
            openedAt,
            willRetryAfter: openedAt + policy.resetTimeout,
          });
        }
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

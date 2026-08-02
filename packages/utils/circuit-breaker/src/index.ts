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
 *  - **half-open** — one probe call is allowed AT A TIME, under a LEASE
 *    (`probeTimeout`); success closes the circuit, failure reopens it, and a
 *    probe that outlives its lease loses the slot to the next caller.
 */
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  /** Monotonic timestamp when the circuit was opened (only meaningful in "open"/"half-open"). */
  readonly openedAt: number;
  /**
   * Monotonic timestamp when the current probe claimed the half-open slot
   * (only meaningful in "half-open"). THE LEASE's epoch: `classify` compares
   * it against `probeTimeout` so a hung probe can be dethroned — before this
   * field existed, one never-settling probe held the slot forever and the
   * breaker reported a healthy vendor as an outage for hours (the 2026-08-02
   * DeepSeek incident: eternal half-open was representable, so it happened).
   */
  readonly probeStartedAt: number;
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
  /**
   * THE PROBE'S LEASE. How long one probe may hold the half-open slot before
   * the slot becomes claimable again. Defaults to `resetTimeout` — the
   * patience you grant before retrying a vendor is the patience you grant the
   * trial itself. The expired probe is never cancelled (the breaker owns no
   * cancellation); it is dethroned: its late settlement still lands as
   * ordinary evidence, it just stops being the only call allowed to exist.
   */
  readonly probeTimeout: Millis;
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
      probeTimeout: 0 as Millis,
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
   * @param options.probeTimeout - The probe's lease on the half-open slot;
   *   after this long a hung probe loses the slot to the next caller.
   *   Defaults to `resetTimeout`. Must be ≥ 1 when given.
   */
  policy(options: { failureThreshold: number; resetTimeout: Millis; probeTimeout?: Millis }): CircuitBreakerPolicy {
    if (options.failureThreshold < 1) {
      throw new Error(`cb.policy: failureThreshold must be >= 1 (got ${options.failureThreshold})`);
    }
    if (options.probeTimeout !== undefined && options.probeTimeout < 1) {
      throw new Error(`cb.policy: probeTimeout must be >= 1ms (got ${options.probeTimeout})`);
    }
    return {
      failureThreshold: options.failureThreshold,
      resetTimeout: options.resetTimeout,
      probeTimeout: options.probeTimeout ?? options.resetTimeout,
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

/**
 * The refusal a short-circuited call receives. Both fields are DURATIONS
 * relative to the refusal's own moment — never instants.
 *
 * The previous shape (`openedAt` / `willRetryAfter`) leaked instants from the
 * breaker's clock, which is monotonic and process-local. An instant from that
 * clock means nothing outside the process that minted it, and the name
 * `willRetryAfter` read as a duration anyway — during the 2026-08-01 vendor
 * outage a monotonic `willRetryAfter` rendered as an epoch produced a phantom
 * multi-hour penalty in the middle of a real incident. Durations carry their
 * own frame: there is nothing to misread and nothing to convert.
 */
export interface CircuitOpenError {
  readonly type: "CIRCUIT_OPEN";
  /** How long the circuit had been open when this call was refused. */
  readonly openForMs: number;
  /**
   * How long until a probe will be admitted, from the refusal's moment.
   * Clamped to 0 when the window has already elapsed but another caller
   * holds the half-open probe slot — retry immediately and race the CAS.
   */
  readonly retryInMs: number;
}

/** The one place refusal durations are derived from monotonic instants. */
function circuitOpenError(openedAtMono: number, nowMono: number, resetTimeout: number): CircuitOpenError {
  return {
    type: "CIRCUIT_OPEN",
    openForMs: Math.max(0, nowMono - openedAtMono),
    retryInMs: Math.max(0, openedAtMono + resetTimeout - nowMono),
  };
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
 *    half-open with a probe whose lease is still live (the contract admits
 *    exactly one probe AT A TIME, so a second concurrent caller must not run).
 *  - **claim-probe** — the slot is claimable: open with the reset window
 *    elapsed, or half-open with the incumbent probe's lease expired. Admission
 *    is granted by atomically claiming the slot via CAS (stamping a fresh
 *    `probeStartedAt`). The winner runs `fn`; losers fall back to
 *    short-circuit.
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
function classify(current: CircuitSnapshot, nowMs: number, policy: CircuitBreakerPolicy): Admission {
  switch (current.state) {
    case "closed":
      return { kind: "pass" };
    case "half-open": {
      // THE LEASE. A probe holds the half-open slot for `probeTimeout`, not
      // forever. Before this check, one never-settling probe (a hung socket,
      // no deadline of its own) held the slot eternally and every caller
      // short-circuited "circuit open" while the vendor sat provably healthy
      // — the 2026-08-02 DeepSeek incident, hours of a private outage that
      // existed only inside this state machine. An expired lease makes the
      // slot claimable again; the incumbent is dethroned, not cancelled, and
      // its late settlement still lands as ordinary evidence.
      const probeAge = nowMs - current.probeStartedAt;
      if (probeAge >= policy.probeTimeout) {
        return { kind: "claim-probe", from: current };
      }
      return { kind: "short-circuit", openedAt: current.openedAt };
    }
    case "open": {
      const elapsed = nowMs - current.openedAt;
      if (elapsed < policy.resetTimeout) {
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
      probeStartedAt: 0,
    },
    clock,
  );

  const watchers = new Set<(event: CircuitEvent) => void>();

  // Bridge atom state transitions into CircuitEvents. A half-open→half-open
  // change with a moved probeStartedAt is a REAL transition — an expired
  // lease was reclaimed by a fresh probe — so it emits `circuit:half-open`
  // again rather than being swallowed as a no-op; an operator watching
  // events can see every probe the breaker admitted, hung ones included.
  state.watch((change: Change<CircuitSnapshot>) => {
    const leaseReclaimed =
      change.to.state === "half-open" &&
      change.from.state === "half-open" &&
      change.from.probeStartedAt !== change.to.probeStartedAt;
    if (change.from.state === change.to.state && !leaseReclaimed) return;

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
      const nowMs = clock.now().monoMs;
      const admission = classify(state.deref(), nowMs, policy);

      if (admission.kind === "short-circuit") {
        return err(circuitOpenError(admission.openedAt, nowMs, policy.resetTimeout));
      }

      if (admission.kind === "claim-probe") {
        // One CAS covers both claims: open → half-open (window elapsed) and
        // half-open → half-open (incumbent's lease expired). Stamping
        // probeStartedAt is what makes the second shape a real transition —
        // the CAS fails for racers because the incumbent snapshot they read
        // carried the OLD stamp.
        const claimed = state.compareAndSet(admission.from, {
          ...admission.from,
          state: "half-open",
          probeStartedAt: nowMs,
        });
        if (!claimed) {
          // Another caller already took the probe slot (or the state moved on);
          // re-derive and short-circuit rather than running a second trial.
          // Fresh clock read: the CAS race took real time, and the durations
          // are relative to THIS refusal, not the classification above.
          const now = state.deref();
          const openedAt = now.state === "open" ? now.openedAt : admission.from.openedAt;
          return err(circuitOpenError(openedAt, clock.now().monoMs, policy.resetTimeout));
        }
      }

      try {
        const value = await fn();
        // Success closes the circuit from any state — including a DETHRONED
        // probe settling late: a response that arrived is live evidence the
        // vendor answers, no matter how long the socket sat.
        state.swap(() => ({ state: "closed", consecutiveFailures: 0, openedAt: 0, probeStartedAt: 0 }));
        return ok(value);
      } catch (error) {
        state.swap((s) => {
          // In half-open, ANY failure reopens the circuit immediately.
          if (s.state === "half-open") {
            return {
              state: "open",
              consecutiveFailures: s.consecutiveFailures + 1,
              openedAt: clock.now().monoMs,
              probeStartedAt: 0,
            };
          }

          // In closed, count the failure and open when threshold is hit.
          // (A dethroned probe failing late lands here once a successor has
          // closed the circuit — it counts as one ordinary failure, aged
          // evidence diluted rather than amplified.)
          const next = s.consecutiveFailures + 1;
          if (next >= policy.failureThreshold) {
            return {
              state: "open",
              consecutiveFailures: next,
              openedAt: clock.now().monoMs,
              probeStartedAt: 0,
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

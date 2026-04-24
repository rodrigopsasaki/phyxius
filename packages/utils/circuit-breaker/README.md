# Circuit Breaker

Fail fast when a downstream keeps failing. Recover automatically when it comes back.

---

## What this really is

An Atom-backed state machine with three states — `closed`, `open`, `half-open` — driven by the injected Clock. You call `execute(fn)` and the breaker decides whether to run `fn` or short-circuit with `CIRCUIT_OPEN`.

```
        failures reach threshold
closed ─────────────────────────▶ open
  ▲                                │
  │ probe succeeds                 │ resetTimeout elapses
  │                                ▼
  └─────────────── half-open ◀─────
         ▲              │
         │ probe fails  │
         └──────────────┘
                open
```

---

## Installation

```bash
npm install @phyxiusjs/circuit-breaker @phyxiusjs/atom @phyxiusjs/clock @phyxiusjs/fp
```

---

## Quick start

```ts
import { cb, createCircuitBreaker } from "@phyxiusjs/circuit-breaker";
import { createSystemClock, ms } from "@phyxiusjs/clock";

const clock = createSystemClock();

const breaker = createCircuitBreaker({
  policy: cb.policy({
    failureThreshold: 5, // open after 5 consecutive failures
    resetTimeout: ms(30_000), // try again after 30s
  }),
  clock,
});

const result = await breaker.execute(async () => {
  return await fetch("https://downstream.example.com/api");
});

if (isErr(result) && result.error.type === "CIRCUIT_OPEN") {
  // The circuit is open — skip downstream, return cached / degraded response
}
```

---

## Policies

### `cb.policy({ failureThreshold, resetTimeout })`

Standard circuit-breaker configuration. Both fields required:

- **`failureThreshold`** — consecutive failures before the circuit opens. Must be ≥ 1.
- **`resetTimeout`** — how long to wait (Clock-measured) before allowing a probe call.

### `cb.none()`

Explicit "no circuit breaker." The breaker lets everything through, never opens. Use this to declare "I've decided not to use a circuit breaker here" rather than leaving the decision implicit.

```ts
const breaker = createCircuitBreaker({
  policy: cb.none(),
  clock,
});
```

---

## State semantics

- **closed**: `execute(fn)` runs `fn`. Consecutive failures are counted. A single success resets the counter. Hitting `failureThreshold` transitions to `open`.
- **open**: `execute(fn)` short-circuits with `Err({ type: "CIRCUIT_OPEN", openedAt, willRetryAfter })`. `fn` is NOT called. When `resetTimeout` has elapsed since `openedAt`, the next `execute` transitions to `half-open`.
- **half-open**: `execute(fn)` runs `fn` as a probe. Success closes the circuit. Failure immediately reopens it with a fresh `openedAt`.

Timestamps use the Clock's monotonic time (`monoMs`) so NTP jumps and DST shifts don't affect recovery windows.

---

## `execute` semantics

```ts
interface CircuitBreaker {
  execute<T>(fn: () => Promise<T>): Promise<Result<T, CircuitOpenError>>;
  snapshot(): CircuitSnapshot;
  watch(callback: (event: CircuitEvent) => void): () => void;
}
```

**Return value:**

- `Ok(T)` on success (circuit closed or half-open probe succeeded)
- `Err({ type: "CIRCUIT_OPEN", ... })` when the circuit is open and the reset hasn't elapsed

**Error propagation:** If `fn` itself throws, `execute` rethrows — the caller gets the original error. The breaker tracks the failure for its own state machine but doesn't swallow it. Callers that want a Result for the underlying operation should pair with `fp.tryCatch` or their own try/catch.

This is deliberate. The breaker's job is _circuit state_, not error wrapping.

---

## Observability

Subscribe to state transitions:

```ts
breaker.watch((event) => {
  // event.type: "circuit:opened" | "circuit:half-open" | "circuit:closed"
  metrics.record(event);
});
```

The snapshot is a value you can query at any time:

```ts
const snap = breaker.snapshot();
// { state: "open", consecutiveFailures: 7, openedAt: 12345 }
```

---

## Deterministic testing

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";

const clock = createControlledClock({ initialTime: 0 });
const breaker = createCircuitBreaker({
  policy: cb.policy({ failureThreshold: 1, resetTimeout: ms(500) }),
  clock,
});

// Open it.
await breaker
  .execute(async () => {
    throw new Error("fail");
  })
  .catch(() => {});
expect(breaker.snapshot().state).toBe("open");

// Advance past the reset timeout — next execute will transition to half-open.
clock.advanceBy(ms(500));

// Success closes it.
await breaker.execute(async () => "ok");
expect(breaker.snapshot().state).toBe("closed");
```

No real time passes. No flaky reset-timeout tests.

---

## Pairing with retry

Use them together when you want "retry a few times with backoff, then fail fast if the downstream stays down":

```ts
import { retry, runWithRetry } from "@phyxiusjs/retry";
import { cb, createCircuitBreaker } from "@phyxiusjs/circuit-breaker";

const breaker = createCircuitBreaker({
  policy: cb.policy({ failureThreshold: 5, resetTimeout: ms(60_000) }),
  clock,
});

const policy = retry.exponential({
  maxAttempts: 3,
  initialDelay: ms(100),
});

// Retry a few times; if the breaker is open, skip entirely.
const result = await runWithRetry(
  async () => {
    const r = await breaker.execute(async () => callDownstream());
    if (isErr(r)) throw new Error("circuit open");
    return r.value;
  },
  policy,
  clock,
);
```

The retry loop handles transient flakes; the breaker handles persistent failure. Different responsibilities, composed at the call site.

---

## API

```ts
type CircuitState = "closed" | "open" | "half-open";

interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
}

interface CircuitBreakerPolicy {
  failureThreshold: number;
  resetTimeout: Millis;
  enabled: boolean;
}

const cb: {
  policy(options: { failureThreshold; resetTimeout }): CircuitBreakerPolicy;
  none(): CircuitBreakerPolicy;
};

type CircuitEvent =
  | { type: "circuit:opened"; consecutiveFailures: number; at: Instant }
  | { type: "circuit:half-open"; at: Instant }
  | { type: "circuit:closed"; at: Instant };

interface CircuitOpenError {
  type: "CIRCUIT_OPEN";
  openedAt: number;
  willRetryAfter: number;
}

function createCircuitBreaker(options: { policy; clock }): CircuitBreaker;
```

---

## What this does NOT do

- **No failure rate windows.** The threshold is consecutive failures, not "10 failures in the last minute." If you need sliding-window rate breakers, wrap the breaker with your own counter.
- **No half-open budget.** Exactly one probe is allowed in half-open. Some implementations allow N probes with a partial-success threshold; this one doesn't.
- **No error-type awareness.** Every thrown error counts as a failure. If you want to ignore certain errors (e.g. 4xx HTTP responses that shouldn't open the breaker), catch them in `fn` and return a success value.

---

## What you get

- **Clock-driven state transitions** — deterministic under `ControlledClock`.
- **Atom-backed state** — observable, composable with other Phyxius primitives.
- **Structured outcomes** — `CIRCUIT_OPEN` is a typed value with `openedAt` / `willRetryAfter` for diagnostics.
- **Zero implicit behavior** — `cb.none()` is the way to declare "no breaker," not omission.

Small primitive. Does one thing. Composes cleanly.

# Phyxius

> _"Phyxius is an epithet of Zeus. It means 'the god who gives escape'. To flee from flaky systems, to take refuge from opaque ones. You, running full steam ahead on that maze — I think there may be another way."_

Phyxius is a set of small, composable primitives for building Node.js systems where **every failure mode is a typed value, every timing decision goes through an injected Clock, and every stability policy is a required part of the type**. Silence is not a valid answer.

It is not a framework. There is no global registry, no lifecycle hook, no "new Phyxius().use(...)" moment. Each package does one thing, and composes with the others through plain values and contracts.

---

## The idea

Most Node codebases get the same things wrong in the same order:

1. **Time is ambient.** `Date.now()`, `setTimeout`, `Date.now() again` — spread through the code until no test is reproducible.
2. **Failures are implicit.** A `Promise` either resolves or rejects with `any`. The failure surface isn't visible anywhere in the type.
3. **Stability is a to-do item.** Timeouts, retries, circuit breakers, concurrency limits — every project adds them "later," which means selectively.
4. **Observability is assembled per-endpoint.** HTTP logs here, queue logs there, cron logs in a third format. No shared shape.

Phyxius flips each one:

1. **Time is a value.** `Clock` is a dependency. A `ControlledClock` in tests makes every timing concern deterministic.
2. **Failures are values.** `Result<T, E>` with a discriminated `E` — no throws cross primitive boundaries. Every failure mode has a name.
3. **Stability is required.** `defineHandler` won't compile without a `timeout`, a `retry` policy, a `circuitBreaker`, and a `concurrency` shape. "No retry" is a value — `retry.none()` — not an absence.
4. **One journal entry per invocation, same shape across transports.** HTTP, queue, cron, internal — all produce the same `HandlerEvent`.

The payoff: the same handler runs behind HTTP today and behind a queue tomorrow, with the same timeouts, the same retries, the same observability. You stop rebuilding those concerns per transport.

---

## Installation

All packages are published under the `@phyxiusjs/` scope. Install the ones you need:

```bash
# The handler and its transport adapter
npm install @phyxiusjs/handler @phyxiusjs/http

# Dependencies the handler expects at runtime
npm install @phyxiusjs/clock @phyxiusjs/journal @phyxiusjs/observe @phyxiusjs/validate @phyxiusjs/fp
```

The handler re-exports `retry` and `cb` from `@phyxiusjs/retry` and `@phyxiusjs/circuit-breaker`, so you don't need to install those directly.

---

## Quick start — a handler behind HTTP

```ts
import { createServer } from "node:http";
import { z } from "zod";

import { createSystemClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { defineHandler, spawn, retry, cb } from "@phyxiusjs/handler";
import { createHttpAdapter } from "@phyxiusjs/http";

// 1. Declare what the handler observes (typed sidecar, one entry per invocation).
const orderFields = observe.fields({
  customerId: observe.field<string>(),
  amount: observe.number(),
});

// 2. Define the handler. Every stability field is required.
const orderSpec = defineHandler({
  name: "order.process",
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ chargeId: z.string(), amount: z.number() }),
  fields: orderFields,

  timeout: ms(5_000),
  concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
  retry: retry.exponential({ maxAttempts: 3, initialDelay: ms(200) }),
  circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),

  run: async ({ customerId, amount }) => {
    orderFields.customerId.set(customerId);
    orderFields.amount.set(amount);
    return { chargeId: `charge_${customerId}`, amount };
  },
});

// 3. Materialize a supervised, running instance.
const clock = createSystemClock();
const journal = new Journal({ clock });
const orderHandler = await spawn(orderSpec, { clock, journal });

// 4. Wire the HTTP adapter. It knows nothing about stability — that lives on the handler.
const adapter = createHttpAdapter({
  routes: [
    {
      method: "POST",
      path: "/orders",
      handler: orderHandler,
      decode: (req) => req.body as { customerId: string; amount: number },
    },
  ],
});

createServer(adapter.listener).listen(3000);
```

That's a supervised, timeout-bounded, retry-aware, circuit-broken, backpressure-shaped endpoint. The adapter is ~300 lines. The handler's guarantees are the same whether you put an HTTP adapter, a queue consumer, or a cron scheduler in front of it.

---

## Packages

### Core — the primitive layer

| Package                                       | What it is                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`@phyxiusjs/clock`](packages/core/clock)     | Injected time. Wall + monotonic. `ControlledClock` for tests. `Budget` — deadline + AbortSignal as a value. |
| [`@phyxiusjs/atom`](packages/core/atom)       | Versioned observable state with CAS. Transactional, linearizable, never unbounded.                          |
| [`@phyxiusjs/journal`](packages/core/journal) | Bounded, ordered, append-only event log. Same shape for every transport.                                    |
| [`@phyxiusjs/process`](packages/core/process) | Single-owner supervision. Start / stop / crash is structural, not convention.                               |

### Components — composed primitives

| Package                                             | What it is                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@phyxiusjs/context`](packages/components/context) | Typed `AsyncLocalStorage`. A scope is a value; data flows without prop-drilling.                                                             |
| [`@phyxiusjs/observe`](packages/components/observe) | Typed field handles (`observe.fields({...})`) that snapshot into each journal entry.                                                         |
| [`@phyxiusjs/handle`](packages/components/handle)   | Scoped observable handle — the low-level building block behind `handler`.                                                                    |
| [`@phyxiusjs/drain`](packages/components/drain)     | Bounded batching pump from journal to sink (stdout / file / OTLP-shaped).                                                                    |
| [`@phyxiusjs/handler`](packages/components/handler) | **The universal work-unit.** Validated, supervised, timing-bounded, retry-aware, breaker-guarded, backpressure-shaped. Every field required. |

### Utilities — value-level building blocks

| Package                                                        | What it is                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`@phyxiusjs/fp`](packages/utils/fp)                           | `Result<T, E>`, `Option<T>`, pattern-match, pipe. No throws as a value language.                        |
| [`@phyxiusjs/validate`](packages/utils/validate)               | `Validator<T>` contract. Zod-compatible, framework-free — so the handler doesn't couple to a validator. |
| [`@phyxiusjs/retry`](packages/utils/retry)                     | Retry policies as values. `retry.none()`, `retry.fixed(...)`, `retry.exponential(...)`.                 |
| [`@phyxiusjs/circuit-breaker`](packages/utils/circuit-breaker) | Closed / open / half-open state machine with injected clock. `cb.none()` is a first-class decision.     |
| [`@phyxiusjs/temporal`](packages/utils/temporal)               | Clock-driven debounce / throttle — deterministic in tests.                                              |
| [`@phyxiusjs/config`](packages/utils/config)                   | Layered config with typed schema, file-watching, and first-wins precedence. No YAML, no surprises.      |

### Adapters — transports

| Package                                     | What it is                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@phyxiusjs/http`](packages/adapters/http) | Thin Node `http` adapter. Pure `handle(HttpRequest): Promise<HttpResponse>` core — testable without sockets. Maps every `HandlerError` variant to a standard HTTP status. |

Queue / scheduler adapters will follow the same shape: decode transport event → invoke handler → encode result. The handler owns stability and observability; each adapter is a small translator.

---

## The "no non-decision" rule

This is the load-bearing invariant.

```ts
interface HandlerSpec<TInput, TOutput, TFields> {
  name: string;
  input: Validator<TInput>;
  output: Validator<TOutput>;
  fields: TFields;
  timeout: Millis;
  concurrency: { max: number; queueSize: number; backpressure: "reject" | "drop-oldest" };
  retry: RetryPolicy; // retry.none() is a value
  circuitBreaker: CircuitBreakerPolicy; // cb.none() is a value
  run: (input: TInput, tools: HandlerTools) => Promise<TOutput>;
}
```

Every field is **required at the type level**. `defineHandler` won't compile with any of them missing. "No retry" is explicit (`retry.none()`). "No breaker" is explicit (`cb.none()`). You cannot ship a handler that silently defaulted a stability decision, because silence isn't an accepted input.

This is the "every failure mode must be directly assertable" invariant, expressed structurally.

---

## Failure modes are typed values

```ts
type HandlerError =
  | { type: "VALIDATION_ERROR"; target: "input" | "output"; error: ValidationError }
  | { type: "TIMEOUT"; timeoutMs: number }
  | { type: "HANDLER_ERROR"; cause: unknown }
  | { type: "RETRY_EXHAUSTED"; attempts: number; lastCause: unknown }
  | { type: "CIRCUIT_OPEN"; openedAt: number; willRetryAfter: number }
  | { type: "BACKPRESSURE_REJECT" }
  | { type: "DROPPED" }
  | { type: "HANDLER_NOT_RUNNING" };
```

Eight named outcomes. Every one is pattern-matchable. No generic `catch`. The HTTP adapter's default encoder maps each to a sensible status (`TIMEOUT` → 504, `CIRCUIT_OPEN` → 503 + `Retry-After`, `BACKPRESSURE_REJECT` → 503, validation → 400/500, etc.), and the same map applies regardless of transport.

---

## One journal entry per invocation, same shape across transports

```ts
interface HandlerEvent {
  name: string;
  invocationId: string;
  correlationId?: string;
  source: string; // "http" | "queue" | "cron" | "internal" | ...
  startedAt: Instant;
  completedAt: Instant;
  durationMs: number;
  attempts: number;
  outcome: "success" | "failure";
  observed: Readonly<Record<string, unknown>>;
  error?: { type: HandlerError["type"]; message: string; stack?: string };
  meta?: Record<string, unknown>;
}
```

HTTP requests produce this shape. Queue messages produce this shape. Cron ticks produce this shape. One dashboard, one query layer, one alerting surface — regardless of transport.

Pair with [`@phyxiusjs/drain`](packages/components/drain) to ship the journal to any sink.

---

## Testing

Every timing decision goes through the `Clock`. A `ControlledClock` makes time a value you can advance deterministically — no flaky backoff, no real timers, no race-condition flakes.

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { spawn } from "@phyxiusjs/handler";

const clock = createControlledClock({ initialTime: 0 });
const journal = new Journal({ clock });
const running = await spawn(spec, { clock, journal });

const result = await running.invoke({ ... });

// Advance time past the retry delay — deterministically.
clock.advanceBy(ms(500));
await clock.flush();

const entries = journal.getSnapshot().entries;
expect(entries[0].data.outcome).toBe("success");
```

The HTTP adapter exposes a pure `handle(HttpRequest): Promise<HttpResponse>` so every route, encoding, and error path is exercised without sockets.

---

## Principles

- **Every failure mode must be directly assertable.** No generic errors, no catch-all. The type tells you the full outcome space.
- **No unboundedness.** Queues have sizes. Backpressure has a policy. History has a ring. Silence is not a valid decision.
- **No non-decision.** Timeouts, retries, breakers, concurrency — all required. "None" is a value, never an absence.
- **Time is injected.** `Date.now()` lives in exactly one place: `@phyxiusjs/clock/system-clock`. Everywhere else uses the injected Clock.
- **Composition over configuration.** Small primitives you assemble. No framework lifecycle, no global state, no surprise behavior.
- **Transport-stable observability.** One journal event per invocation. Same shape across transports.

---

## Repository layout

```
packages/
├── core/           # clock, atom, journal, process
├── components/     # context, observe, handle, drain, handler
├── utils/          # fp, validate, retry, circuit-breaker, temporal, config
└── adapters/       # http (queue/scheduler to follow)
```

Each package has its own README. Read [`@phyxiusjs/handler`](packages/components/handler) first — it's the primitive everything else composes around.

---

## Status

Alpha. APIs may still shift. The philosophy — typed failures, required stability, injected time, one event shape — is settled; the surface around it is still being polished. Issues and PRs welcome; we're opinionated about keeping things small.

---

## License

MIT.

---

_Built because we needed it. Shared because you might too._

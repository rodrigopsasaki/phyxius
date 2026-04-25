# Phyxius

> _"Phyxius is an epithet of Zeus. It means 'the god who gives escape'. To flee from flaky systems, to take refuge from opaque ones. You, running full steam ahead on that maze — I think there may be another way."_

Phyxius is a TypeScript framework for Node.js systems. It's opinionated about one thing: **you shouldn't be able to ship a handler that silently defaulted a stability decision**. Timeouts, retries, circuit breakers, concurrency limits, failure modes — all declared as values, all visible in the type, all carried on the same journal shape regardless of whether work enters your system through HTTP, a queue, a cron tick, or a 3rd-party API call.

It's a framework for people who've operated what they've built and want the production-ready shape from day one — without thinking about it more than once per invariant.

---

## The 60-second version

```ts
import { createApp } from "@phyxiusjs/framework";
import { defineHandler, retry, cb } from "@phyxiusjs/handler";
import { observe } from "@phyxiusjs/observe";
import { ms } from "@phyxiusjs/clock";
import { z } from "zod";

const app = await createApp({ config: "./phyxius.yaml" });

const orderFields = observe.fields({
  customerId: observe.field<string>(),
  amount: observe.number(),
});

const processOrder = await app.use(
  defineHandler({
    name: "order.process",
    input: z.object({ customerId: z.string(), amount: z.number().positive() }),
    output: z.object({ chargeId: z.string(), amount: z.number() }),
    fields: orderFields,

    // You cannot ship this without these four decisions. No defaults. No silence.
    timeout: ms(5_000),
    concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
    retry: retry.exponential({ maxAttempts: 3, initialDelay: ms(200) }),
    circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),

    run: async ({ customerId, amount }) => {
      orderFields.customerId.set(customerId);
      orderFields.amount.set(amount);
      return { chargeId: `ch_${customerId}`, amount };
    },
  }),
);

app.route({ method: "POST", path: "/orders", handler: processOrder });

await app.start();
```

That's a supervised, budget-bounded, retry-aware, circuit-broken, backpressure-shaped HTTP endpoint — with deterministic sampling, rolling percentile stats, hot-reloadable config, and one structured journal entry per invocation. **Every one of those guarantees is the same value type you'd read in your logs next Tuesday at 3am**, because they all came from the same spec.

Put the same `processOrder` behind `app.schedule(...)` or `app.consume(...)` instead, and you'd get the exact same guarantees with the exact same journal shape. The transport is a small translator; the spec is where the work lives.

---

## Why this exists

Every real Node service gets the same things wrong in the same order:

- **Time is ambient.** `Date.now()`, `setTimeout`, retry windows measured in "however long the test felt like running." Nothing is reproducible.
- **Failures are implicit.** A promise rejects with `any`. The failure surface isn't visible anywhere in the type, so retry predicates are regex on `.message` and pagers fire on the wrong errors.
- **Stability is a to-do item.** Timeouts, retries, breakers, concurrency — every service adds them "later," which means selectively, which means the one endpoint that didn't get them is the one that takes the service down.
- **Observability is assembled per-endpoint.** HTTP logs in one format, queue logs in another, cron logs in a third. You rebuild the dashboard every quarter.

Phyxius flips all four:

- **Time is a value.** `Clock` is a dependency. A `ControlledClock` in tests makes every timing concern deterministic.
- **Failures are values.** Eight typed variants. Pattern-matchable. No throws cross primitive boundaries.
- **Stability is required.** `defineHandler` won't compile without a timeout, a retry, a breaker, and a concurrency shape. "No retry" is a value — `retry.none()` — not an absence.
- **One journal entry per invocation, same shape across transports.** HTTP, queue, cron, connector — all produce a `HandlerEvent`. One dashboard, one query layer, one alerting surface.

The payoff compounds: the same handler runs behind HTTP today and a queue tomorrow with the same timeouts, the same retries, the same observability. You stop rebuilding those concerns per transport.

---

## What `createApp` actually does

```ts
const app = await createApp({ config: "./phyxius.yaml" });
```

That single line wires up five primitives:

1. A `Clock` — the one place `Date.now()` and `setTimeout` live.
2. A `Journal` — a bounded, ordered, append-only event log. The ring buffer is a feature, not a bug: memory growth is impossible by construction.
3. A `Drain` — the journal-to-sink pump. Ships structured JSON to stdout by default; swap it for a file, OTLP, or anything else without touching the handler.
4. A `Stats` engine — poor-man's APM. Rolling p50/p95/p99 + error rate per handler, with edge-triggered threshold alerts declared in YAML.
5. A `Config` watcher — typed, layered, hot-reloadable. Flip a sampling ratio or an alert threshold in production, save the file, and the next invocation sees the change.

Then it hands you `.route` / `.schedule` / `.consume` / `.use`, each of which is a **documented composition** — the framework source reads as "here's how you'd have written it by hand." Nothing is hidden; you can drop beneath any of it at any time.

When you're ready to look deeper: [**framework/README**](packages/framework/README.md).

---

## The spec is the whole story

Everything useful in Phyxius starts with `HandlerSpec`:

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

Every stability field is required at the type level. `defineHandler` won't compile with any of them missing. "No retry" is a value. "No breaker" is a value. **Silence isn't an accepted input.**

This is the load-bearing invariant. "Every failure mode must be directly assertable" isn't a principle we wrote in a doc — it's structural. You can't accidentally ship code that skipped a stability decision, because the type won't let the file typecheck.

The same spec shape carries into the other work-unit primitives. A `ConnectorSpec` (a wrapper around a 3rd-party API call) `extends HandlerSpec` plus two fields: `provider` and `mapError`. When the specialization extends cleanly, that's the design test passing — the substrate is right.

→ [handler/README](packages/components/handler/README.md), [connector/README](packages/components/connector/README.md)

---

## Eight failure modes, each one named

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

Eight named outcomes. Every one is pattern-matchable. No generic `catch`.

The HTTP adapter's default encoder maps each variant to a sensible HTTP status (`TIMEOUT` → 504, `CIRCUIT_OPEN` → 503 + `Retry-After`, `BACKPRESSURE_REJECT` → 503, validation → 400 / 500, etc.). The queue adapter maps each to an ack / nack decision. The scheduler logs and moves on. Different transports, same union — because the failure space is a property of the work, not of how the work was triggered.

When a connector wraps a 3rd-party API, its errors land in `HandlerError.cause` as a typed `ConnectorError` (`UNAUTHORIZED` / `RATE_LIMITED` / `NOT_FOUND` / ...), so retry predicates can narrow without looking at stack traces or status strings.

---

## One journal entry per invocation, same shape across transports

```ts
interface HandlerEvent {
  name: string;
  invocationId: string;
  correlationId?: string;
  source: string; // "http" | "queue" | "cron" | "internal" | "connector"
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

Everything produces this shape. HTTP requests produce this shape. Queue messages produce this shape. Cron ticks produce this shape. Connector calls produce this shape. **One dashboard, one query layer, one alerting surface** — regardless of transport.

The `observed` bag is where the per-invocation narrative lives. You declare field handles alongside the spec (`observe.fields({ customerId: observe.field<string>() })`), set them during `run`, and they snapshot into the journal entry at completion. Fields come in two tiers — `core` (always shipped) and `extra` (debug breadcrumbs, filtered in production by default). Flip a config key during an incident and the very next journal entry carries the extras. No restart.

The goal: when someone asks "what happened at 3am?", the answer is a readable narrative — _one customer tried to place an order, Stripe was rate-limiting us, we retried three times with exponential backoff, the fourth attempt succeeded, here's the charge ID_ — because the fields were a curated product, not a `console.log` someone forgot to remove.

→ [observe/README](packages/components/observe/README.md), [journal/README](packages/core/journal/README.md), [drain/README](packages/components/drain/README.md)

---

## Time is injected. Tests are deterministic.

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";

const clock = createControlledClock({ initialTime: 0 });
const handler = await spawn(spec, { clock, journal });

const promise = handler.invoke(input);
clock.advanceBy(ms(500));
await clock.flush();
const result = await promise;
```

No real timers. No race-condition flakes. No "oh this test only fails in CI, must be an infrastructure problem." Every `setTimeout`, every retry delay, every circuit-breaker reset, every schedule tick — goes through the injected `Clock`. A `ControlledClock` makes time a value you can advance deterministically.

→ [clock/README](packages/core/clock/README.md)

---

## Schema evolution, as a typed value

Every system accumulates half-finished migrations. Column renames waiting on the drop. Dual-writes that never got switched over. "We'll finish this next sprint" turning into fossils in the schema. The reason isn't that people don't know expand-and-contract — everyone knows it. It's that **the verification step between phases is trust-based**: you checked the dual-write was matching once, three weeks ago, and never looked again.

`@phyxiusjs/migration` turns that pattern into a value. Phases are declared; each transition names the **evidence** it requires; `advance()` runs the evidence queries against live substrate and refuses to transition if the proof isn't there. Wrong-until-proven-otherwise by construction:

```ts
const quoteToSalesDocument = defineMigration({
  name: "quote-to-sales-document",
  phases: {
    expand: { evidence: { schemaReady: schemaApplied({ check: checkAlembicHead }) } },
    dualWrite: { evidence: { parityVerified: attestation({ check: readSignoffStore }) } },
    flip: {
      evidence: {
        zeroLegacyReads: journalWindow({
          query: { name: "quote.read" },
          windowMs: ms(14 * 24 * 60 * 60 * 1000),
          predicate: (events) => (events.length === 0 ? ok({ count: 0 }) : err({ reason: "saw legacy reads" })),
        }),
      },
    },
    contract: {
      evidence: {
        zeroLegacyWrites: journalWindow({
          /* ... */
        }),
      },
    },
  },
});

// Handlers read the live phase at dispatch time.
if ((await migration.currentPhase()) === "flip") {
  /* new path */
}

// `advance()` consults the evidence — no shortcut produces a valid transition.
await migration.advance();
```

Same structural invariant as required-stability fields, one layer up: the halfway-state that used to be a memorized checklist stops being expressible because the type system and the runtime both demand proof.

→ [migration/README](packages/components/migration/README.md)

---

## The packages, if you want to look

The framework is one composition of the primitives. Nothing stops you from dropping to the primitive layer and composing differently — each package is a standalone value, each has its own README, each does one thing.

### Framework

| Package                                      | What it is                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@phyxiusjs/framework`](packages/framework) | `createApp()` — the packaged composition. Transports are optional peer deps. |

### Adapters — how work enters the system

| Package                                               | What it is                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`@phyxiusjs/http`](packages/adapters/http)           | Thin Node `http` adapter. Pure `handle(HttpRequest): Promise<HttpResponse>` core — testable without sockets. |
| [`@phyxiusjs/queue`](packages/adapters/queue)         | Broker-agnostic pull-based consumer. Drop-in for SQS / Redis / Kafka. In-memory source for tests.            |
| [`@phyxiusjs/scheduler`](packages/adapters/scheduler) | Time-driven invocations. Pluggable schedules, explicit overlap / catchup / drift policies.                   |
| [`@phyxiusjs/db-pg`](packages/adapters/db-pg)         | Postgres driver for `@phyxiusjs/db`. Curated SQLSTATE → `DbError` mapping.                                   |

### Components — composed primitives

| Package                                                 | What it is                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`@phyxiusjs/handler`](packages/components/handler)     | **The universal work-unit.** Validated, supervised, budget-bounded, retry-aware, breaker-guarded, backpressure-shaped. |
| [`@phyxiusjs/connector`](packages/components/connector) | 3rd-party integration primitive. `ConnectorSpec extends HandlerSpec` + typed `ConnectorError` + HTTP deepdive.         |
| [`@phyxiusjs/migration`](packages/components/migration) | Evidence-gated expand-and-contract. Phases require proof to advance; wrong-until-proven-otherwise by construction.     |
| [`@phyxiusjs/db`](packages/components/db)               | Database boundary. Transaction-as-context, typed errors, driver-agnostic.                                              |
| [`@phyxiusjs/observe`](packages/components/observe)     | Typed field handles. `core` vs `extra` tiers. Snapshots into every journal entry.                                      |
| [`@phyxiusjs/context`](packages/components/context)     | Typed `AsyncLocalStorage`. A scope is a value.                                                                         |
| [`@phyxiusjs/drain`](packages/components/drain)         | Journal-to-sink pump with declarative filtering.                                                                       |
| [`@phyxiusjs/stats`](packages/components/stats)         | Poor-man's APM. Rolling percentiles, error rates, edge-triggered alerts.                                               |
| [`@phyxiusjs/handle`](packages/components/handle)       | Scoped observable handle — the low-level building block behind `handler`.                                              |

### Core — the primitive layer

| Package                                         | What it is                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| [`@phyxiusjs/clock`](packages/core/clock)       | Injected time. Wall + monotonic. `Budget` — deadline + AbortSignal as a value.   |
| [`@phyxiusjs/atom`](packages/core/atom)         | Versioned observable state with CAS. Transactional, linearizable, bounded.       |
| [`@phyxiusjs/journal`](packages/core/journal)   | Bounded, ordered, append-only event log.                                         |
| [`@phyxiusjs/process`](packages/core/process)   | Single-owner supervision. Start / stop / crash is structural, not convention.    |
| [`@phyxiusjs/resource`](packages/core/resource) | Acquire / use / release with guaranteed cleanup. Release errors never mask body. |

### Utilities — value-level building blocks

| Package                                                        | What it is                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`@phyxiusjs/fp`](packages/utils/fp)                           | `Result<T, E>`, `Option<T>`, pattern-match, pipe.                                                              |
| [`@phyxiusjs/validate`](packages/utils/validate)               | `Validator<T>` contract. Zod-compatible, framework-free.                                                       |
| [`@phyxiusjs/retry`](packages/utils/retry)                     | Retry policies as values. `retry.none()`, `retry.fixed(...)`, `retry.exponential(...)`.                        |
| [`@phyxiusjs/circuit-breaker`](packages/utils/circuit-breaker) | Closed / open / half-open state machine. `cb.none()` is a first-class decision.                                |
| [`@phyxiusjs/temporal`](packages/utils/temporal)               | Clock-driven debounce / throttle. Deterministic in tests.                                                      |
| [`@phyxiusjs/config`](packages/utils/config)                   | Layered typed config with file-watching and first-wins precedence.                                             |
| [`@phyxiusjs/strategy`](packages/utils/strategy)               | Pure named computation with shadow deployment. Primary + shadows for versioned rollouts.                       |
| [`@phyxiusjs/state-machine`](packages/utils/state-machine)     | Typed state machines. States are discriminated unions, transitions are strategies, the graph is the primitive. |

---

## Principles

- **Every failure mode must be directly assertable.** No generic errors, no catch-all. The type tells you the full outcome space.
- **No unboundedness.** Queues have sizes. Backpressure has a policy. Event history has a ring. Silence is not a valid answer.
- **No non-decision.** Timeouts, retries, breakers, concurrency — all required. "None" is a value, never an absence.
- **Time is injected.** `Date.now()` lives in exactly one place: `@phyxiusjs/clock/system-clock`. Everywhere else uses the injected Clock.
- **Composition over configuration.** Small primitives you assemble. No framework lifecycle, no global state, no surprise behavior.
- **Transport-stable observability.** One journal event per invocation. Same shape across every way work enters the system.
- **If a new primitive extends an existing one's shape naturally, the existing shape is right.** If it doesn't, either the new primitive is wrong or the substrate is missing something. The test is generative either way.

---

## Status

Alpha. APIs may still shift. The philosophy — typed failures, required stability, injected time, one event shape — is settled; the surface around it is still being polished. Issues and PRs welcome; we're opinionated about keeping things small.

---

## License

MIT.

---

_Built because we needed it. Shared because you might too._

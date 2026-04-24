# Handler

The universal work-unit primitive. Every API call, every message consumer, every scheduled job is the same shape underneath: a typed piece of work with declared stability and observability. Handler is that shape.

---

## What this really is

One primitive, many transports. HTTP adapters, queue consumers, cron schedulers, internal invocations — they all call `handler.invoke(input)`. The work itself, the retry policy, the circuit breaker, the timeout, the observability fields — all declared once, on the handler.

The discipline: **no stability decision can be defaulted**. A handler that doesn't declare its timeout, its retry policy, its circuit breaker, its concurrency shape — doesn't compile. "No retry" is an explicit value (`retry.none()`), not an absence. "No circuit breaker" is `cb.none()`. Silence is not a valid answer.

This is the "every failure mode must be directly assertable" invariant, expressed at the type level.

---

## Installation

```bash
npm install @phyxiusjs/handler @phyxiusjs/clock @phyxiusjs/journal @phyxiusjs/observe @phyxiusjs/validate @phyxiusjs/fp
```

The handler re-exports `retry` and `cb` helpers, so you don't need to install `@phyxiusjs/retry` and `@phyxiusjs/circuit-breaker` separately.

---

## Quick start

```ts
import { defineHandler, spawn, retry, cb } from "@phyxiusjs/handler";
import { createSystemClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { z } from "zod";

// 1. Declare what this handler observes (the sidecar schema).
const orderFields = observe.fields({
  customerId: observe.field<string>(),
  chargedAmount: observe.number(),
  idempotencyKey: observe.field<string>(),
});

// 2. Define the handler. Every stability field is required.
const orderHandler = defineHandler({
  name: "order.process",

  input: z.object({
    customerId: z.string(),
    amount: z.number().positive(),
  }),
  output: z.object({
    chargeId: z.string(),
    amount: z.number(),
  }),
  fields: orderFields,

  // Stability decisions — all required, no defaults.
  timeout: ms(5_000),
  concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
  retry: retry.exponential({ maxAttempts: 3, initialDelay: ms(200) }),
  circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),

  // The work.
  run: async (input, { budget, signal }) => {
    orderFields.customerId.set(input.customerId);
    const charge = await chargeCard(input, { signal });
    orderFields.chargedAmount.set(charge.amount);
    return { chargeId: charge.id, amount: charge.amount };
  },
});

// 3. Materialize a running, supervised instance.
const clock = createSystemClock();
const journal = new Journal({ clock });
const running = await spawn(orderHandler, { clock, journal });

// 4. Invoke. Returns Result<TOutput, HandlerError> — never throws.
const result = await running.invoke(
  { customerId: "alice", amount: 99.99 },
  { correlationId: "req-abc", source: "http" },
);

if (isOk(result)) console.log("charged:", result.value);
// else result.error is a typed HandlerError — inspect .type for the failure mode.
```

---

## The "no non-decision" rule

Every `HandlerSpec` field below is **required** at the type level. Leave any of them off and `defineHandler` is a compile error:

```ts
interface HandlerSpec<TInput, TOutput, TFields> {
  name: string;
  input: Validator<TInput>;
  output: Validator<TOutput>;
  fields: TFields; // observe.fields(...) bag
  timeout: Millis;
  concurrency: {
    max: number;
    queueSize: number;
    backpressure: "reject" | "drop-oldest";
  };
  retry: RetryPolicy; // retry.none() to declare no retry
  circuitBreaker: CircuitBreakerPolicy; // cb.none() to declare no breaker
  run: (input: TInput, tools: HandlerTools) => Promise<TOutput>;
}
```

This is the opposite of frameworks that hide decisions in defaults. You can't forget a timeout. You can't "add retries later." The primitive demands an answer, and the answer can be "none" — but you have to _say_ it.

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

Every possible outcome is a named, inspectable, assertable value. Pattern-match on `error.type` to handle them. No generic `Error` catch-all.

---

## The composition underneath

```
invoke(input)
  → queue check (concurrency + backpressure)
  → dispatch (activeCount < max)
  → context.scope open
    → validate input
    → clock.timeout(spec.timeout) → Budget
    → runWithRetry(
        breaker.execute(
          spec.run(input, { budget, signal })
        ),
        policy,
        { signal: budget.signal }
      )
    → validate output
    → snapshot observe fields
  → context.scope close
  → journal.append(HandlerEvent)
  → resolve invoke() promise with Result
```

Every layer is an injected, composable primitive. Clock drives timeouts and retry waits. The breaker is an Atom-backed state machine. Retry is a policy value. Validation is a `{ parse }` contract. The journal gets exactly one entry per invocation — same shape regardless of transport.

---

## Observability: one entry per invocation, transport-stable

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
  observed: Readonly<Record<string, unknown>>; // your typed fields snapshot
  error?: { type: HandlerError["type"]; message: string; stack?: string };
  meta?: Record<string, unknown>;
}
```

HTTP invocations produce this shape. Queue consumers produce this shape. Scheduled jobs produce this shape. Same dashboards, same queries, same alerts — regardless of transport. That's the framework-replacement payoff.

Pair with `@phyxiusjs/drain` to ship the journal to any sink (stdout, file, OTLP, custom).

---

## Testing

Handlers are fully testable without any transport. Inject a `ControlledClock` and time-travel through timeouts, retries, and circuit resets deterministically.

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";

const clock = createControlledClock({ initialTime: 0 });
const journal = new Journal({ clock });

const running = await spawn(myHandler, { clock, journal });

// Invoke
const result = await running.invoke({ ... });

// Check journal
const entries = journal.getSnapshot().entries;
expect(entries[0].data.outcome).toBe("success");
expect(entries[0].data.observed).toMatchObject({ customerId: "alice" });

// Time-travel past retry delays
clock.advanceBy(ms(500));
await clock.flush();
```

Every test is deterministic. No real timers, no flaky backoff.

---

## The running handler

```ts
interface RunningHandler<TInput, TOutput> {
  id: ProcessId;
  name: string;

  invoke(input: TInput, meta?: InvocationMeta): Promise<Result<TOutput, HandlerError>>;

  getMetrics(): HandlerMetrics;
  getStatus(): HandlerStatus;

  stop(options?: { drainTimeoutMs?: Millis }): Promise<void>;
}
```

`invoke` never throws. `stop` is graceful — active invocations drain up to `drainTimeoutMs` (default 10s); queued work that hasn't started is rejected with `HANDLER_NOT_RUNNING`.

Metrics are a snapshot of current state:

```ts
interface HandlerMetrics {
  status: "idle" | "running" | "stopping" | "stopped" | "failed";
  activeCount: number;
  queuedCount: number;
  totalInvocations: number;
  totalSuccesses: number;
  totalFailures: number;
  circuitState: "closed" | "open" | "half-open" | "disabled";
}
```

---

## Where adapters fit

Adapters are small translators. Each one turns a transport's native event into a handler invocation and its result back into a transport response. They know nothing about stability or observability — the handler owns those.

```ts
// HTTP (future @phyxiusjs/http)
createHttpAdapter({
  routes: [
    {
      method: "POST",
      path: "/orders",
      handler: orderHandler,
      decode: (req) => parseOrder(req.body),
      encode: (res, result) => res.json(result),
    },
  ],
});

// Queue (future @phyxiusjs/queue)
createConsumer({
  topic: "orders.created",
  handler: orderHandler,
  decode: (msg) => JSON.parse(msg.body),
  onResult: (msg, r) => (r._tag === "Ok" ? msg.ack() : msg.nack()),
});

// Scheduler (future @phyxiusjs/scheduler)
createScheduler({ clock, jobs: [{ cron: "*/5 * * * *", handler: cleanupHandler, input: () => ({}) }] });
```

Every adapter is ~100 lines. The hard parts — queueing, retries, observability, validation — live in the handler, once.

---

## What this does NOT do

- **No transport-specific behavior.** Handler doesn't know about HTTP, queues, or cron. Adapters handle that layer.
- **No distributed coordination.** A running handler is single-process. Scaling across nodes is a transport concern.
- **No auto-instrumentation.** The `observe` schema is declarative — you decide what gets captured. Nothing is implicit.
- **No shared state between invocations.** Each invocation gets its own context scope. Persistent state belongs in an `Atom` or external store that the `run` function references.

---

## What you get

- **Every failure mode typed and assertable.** No generic errors, no magic catch-alls.
- **Every timing deterministic.** Clock drives it all — ControlledClock makes tests reproducible.
- **Every invocation one journal entry.** Same shape across transports. Unified observability surface.
- **Every stability decision required.** You can't ship a handler without deciding how it handles load, failure, and overload. "None" is a valid answer — but an explicit one.

Handler is the invariant unit. Everything above — adapters, schedulers, consumers — composes around it.

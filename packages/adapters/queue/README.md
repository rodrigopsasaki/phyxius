# Queue

The queue adapter for `@phyxiusjs/handler`. Broker-agnostic — one consumer, one handler, one journal event per message. Every stability concern (timeout, retry, circuit breaker, concurrency) already lives on the handler. The adapter is the translator.

---

## What this really is

A `createQueueConsumer({ source, handler, decode })` that pulls messages from a `MessageSource`, invokes the handler, and translates the Result into ack / nack. That's the whole surface.

`MessageSource` is the contract broker adapters implement — SQS, Kafka, Redis Streams, RabbitMQ, BullMQ, wherever. Your code is coupled to the contract, not to the broker.

The payoff is the claim the handler made months ago, now concrete: **the same handler runs behind HTTP and behind a queue with identical stability guarantees and identical journal events.** A `TIMEOUT` is a 504 on HTTP and a retry-nack on queue. A `BACKPRESSURE_REJECT` is a 503 on HTTP and a requeue-now on queue. One source of truth for "what went wrong" — different transport translations.

---

## Installation

```bash
npm install @phyxiusjs/queue @phyxiusjs/handler @phyxiusjs/clock
```

---

## Quick start

```ts
import { createSystemClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { cb, defineHandler, retry, spawn } from "@phyxiusjs/handler";
import { createQueueConsumer } from "@phyxiusjs/queue";

// Wire your broker adapter here (SQS, Redis, etc.) — it implements MessageSource.
import { createSqsSource } from "@phyxiusjs/queue-sqs";

const orderFields = observe.fields({
  customerId: observe.field<string>(),
  amount: observe.number(),
});

const orderSpec = defineHandler({
  name: "order.process",
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ chargeId: z.string() }),
  fields: orderFields,

  timeout: ms(5_000),
  concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
  retry: retry.exponential({ maxAttempts: 3, initialDelay: ms(200) }),
  circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),

  run: async ({ customerId, amount }) => {
    orderFields.customerId.set(customerId);
    orderFields.amount.set(amount);
    return { chargeId: await charge(customerId, amount) };
  },
});

const clock = createSystemClock();
const journal = new Journal({ clock });
const handler = await spawn(orderSpec, { clock, journal });

const source = createSqsSource({
  queueUrl: "https://sqs.us-east-1.amazonaws.com/.../orders",
  waitTimeSeconds: 20,
});

const consumer = createQueueConsumer({
  source,
  handler,
  decode: (msg) => msg.body as { customerId: string; amount: number },
  maxConcurrent: 4,
  clock,
});

await consumer.start();

// Graceful shutdown on SIGTERM:
process.on("SIGTERM", async () => {
  await consumer.stop();
  await handler.stop();
});
```

Same handler spec, same observability, same stability. Swap `createSqsSource` for a Redis or Kafka source; nothing else changes.

---

## The `QueueConsumer` surface

```ts
interface QueueConsumer {
  start(): Promise<void>; // begin the consume loop
  stop(): Promise<void>; // drain in-flight, close source
  getStatus(): QueueConsumerStatus; // "idle" | "running" | "stopping" | "stopped"
  getInFlight(): number; // how many messages are being processed now
}
```

`start` resolves once the loop is running; the loop itself runs until `stop`. `stop` is idempotent — safe to call from multiple SIGTERM handlers, `unhandledRejection` cleanup, or a final `afterAll` in tests.

---

## The `MessageSource` contract

```ts
interface MessageSource {
  receive(signal?: AbortSignal): Promise<QueueMessage | null>;
  ack(message: QueueMessage): Promise<void>;
  nack(message: QueueMessage, reason: NackReason): Promise<void>;
  close?(): Promise<void>;
}

interface QueueMessage {
  id: string;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
  receivedAt: Instant;
  deliveryCount?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

type NackReason =
  | { type: "retry"; delayMs?: Millis; cause?: string }
  | { type: "dead-letter"; cause: string }
  | { type: "requeue-now"; cause?: string };
```

**Pull-based by design.** Any push-based broker can be wrapped in a pull interface (see `createMemorySource` for the reference implementation); the reverse coupling is much harder to undo. `receive` should long-poll until a message arrives or return `null` on idle timeout / abort so the consumer loop can re-check its `running` flag.

**Nack reasons are intent, not implementation.** Sources translate them to broker-native operations (SQS `ChangeMessageVisibility`, Kafka commit-offset skip, Redis `XCLAIM`, etc.). A broker that doesn't support delayed retry can treat `{ type: "retry", delayMs: 1000 }` the same as `{ type: "retry" }` — no data is lost, the consumer just doesn't get the back-pressure it asked for.

---

## Default `onResult` mapping

Every `HandlerError` variant maps to a sensible default outcome. Override per-route with `onResult` for domain-specific policy.

| Result                       | Action | Reason                                       |
| ---------------------------- | ------ | -------------------------------------------- |
| `Ok(T)`                      | `ack`  |                                              |
| `VALIDATION_ERROR("input")`  | `nack` | `dead-letter` (`cause: "validation:input"`)  |
| `VALIDATION_ERROR("output")` | `nack` | `dead-letter` (`cause: "validation:output"`) |
| `TIMEOUT`                    | `nack` | `retry` (`cause: "timeout:Nms"`)             |
| `HANDLER_ERROR`              | `nack` | `retry` (`cause: "handler_error"`)           |
| `RETRY_EXHAUSTED`            | `nack` | `dead-letter` (`cause: "retry_exhausted:N"`) |
| `CIRCUIT_OPEN`               | `nack` | `retry` (`delayMs` = time-until-close)       |
| `BACKPRESSURE_REJECT`        | `nack` | `requeue-now` (`cause: "queue_full"`)        |
| `DROPPED`                    | `nack` | `requeue-now` (`cause: "dropped"`)           |
| `HANDLER_NOT_RUNNING`        | `nack` | `requeue-now` (`cause: "shutting_down"`)     |

**Why these choices:**

- **Input validation → DLQ.** A malformed message will never succeed; retrying is a guaranteed loop. Route it to a DLQ so an operator can inspect.
- **Output validation → DLQ.** The server is buggy for this message shape; retrying won't help until the code changes.
- **Timeout → retry.** Probably transient (slow downstream); the broker's visibility window picks it up.
- **Handler error → retry.** Unknown cause — one more attempt might succeed. If it won't, the handler's _own_ retry policy will surface `RETRY_EXHAUSTED` instead.
- **Retry exhausted → DLQ.** The handler already retried internally. Don't retry again at the broker layer; that's how duplicate work happens.
- **Circuit open → retry with delay.** The breaker's `willRetryAfter - openedAt` becomes the broker delay. Sources that can't honor it just retry normally — the breaker will re-open until it closes, so the nack path repeats until the downstream recovers.
- **Backpressure / dropped / shutting down → requeue-now.** We can't take this message, but another worker (or this worker later) probably can. Put it back immediately.

Override any of this per-consumer with a custom `onResult`:

```ts
createQueueConsumer({
  source,
  handler,
  decode,
  clock,
  onResult: (result, message) => {
    if (result._tag === "Err" && result.error.type === "TIMEOUT") {
      // We log timeouts upstream; don't retry at the broker.
      return { action: "ack" };
    }
    return defaultOnResult(result, message);
  },
});
```

---

## Concurrency

`maxConcurrent` (default `1`) is the consumer's own in-flight cap. Tune it based on broker semantics:

- **SQS / single-partition brokers:** match your `Visibility Timeout` budget. Higher parallelism means more work in flight, but each message still has the same visibility window.
- **Kafka / partitioned brokers:** one consumer per partition is the norm; leave `maxConcurrent: 1` and run multiple consumers.
- **Redis Streams with XGROUP:** pick a value based on worker CPU, not broker capacity.

The handler's `concurrency.max` is the _real_ ceiling — messages beyond it will be rejected with `BACKPRESSURE_REJECT` and nacked with `requeue-now`. If you see this in your journal, lower the consumer's `maxConcurrent` rather than raising the handler's `concurrency.max`, so load-shedding stays visible.

---

## Correlation IDs

The consumer extracts a correlation ID from message headers in this order:

1. `x-correlation-id`
2. `correlation-id`
3. The message's own `id` (always present)

That ID flows into the handler invocation and onto every `HandlerEvent` in the journal. An HTTP-to-queue hop keeps a single trace — set `x-correlation-id` on the enqueued message's headers upstream and the downstream consumer inherits it automatically.

---

## Testing

`createMemorySource` is the reference `MessageSource` — deterministic, in-memory, Clock-driven. Use it to drive consumer tests without a real broker:

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { createMemorySource, createQueueConsumer } from "@phyxiusjs/queue";

const clock = createControlledClock({ initialTime: 0 });
const source = createMemorySource({ clock });

const consumer = createQueueConsumer({ source, handler, decode, clock });

await consumer.start();
source.enqueue({ body: { customerId: "alice", amount: 42 } });

// Poll for observable effects.
await vi.waitFor(() => {
  expect(source.getAckHistory()).toHaveLength(1);
});

expect(journal.getSnapshot().entries[0].data.source).toBe("queue");
```

The memory source also exposes `getDeadLettered()`, `getNackHistory()`, `getPending()`, and `getInFlight()` — use them for precise assertions.

---

## What this does NOT do

- **No broker implementation.** This package is the consumer shape; broker adapters (`@phyxiusjs/queue-sqs`, `@phyxiusjs/queue-redis`, etc.) live in their own packages with their own SDK dependencies.
- **No transactional outbox / dedupe.** Idempotency is a handler concern (the handler sees `deliveryCount` in the invocation meta). The adapter's job is just ack / nack.
- **No batch consumption.** One message = one handler invocation = one journal event. Batching breaks the "same shape as HTTP" invariant.
- **No scheduler / cron.** Time-driven work is a different adapter.

---

## What you get

- **Transport-stable observability.** Every queue message produces the same `HandlerEvent` shape as an HTTP request or a cron tick. Single dashboard, single query layer.
- **Every failure mode mapped.** No generic retries, no silent swallows. `RETRY_EXHAUSTED` goes to DLQ automatically so you don't retry at two layers. `CIRCUIT_OPEN` carries the expected recovery delay.
- **Broker portable.** Swap SQS for Redis Streams without touching the handler, the observability schema, the retry policy, or the stability guarantees. The consumer's `onResult` table is the full translation layer.
- **Deterministic tests.** `createMemorySource` + `ControlledClock` = no real brokers, no flaky backoff, no race-condition flakes.

The queue adapter is deliberately small. The handler is where the work lives.

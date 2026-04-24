# Drain

The bridge from an in-memory Journal to a real sink. Bounded, Clock-driven, with re-queue on failure and visible backpressure.

---

## What this really is

`@phyxiusjs/journal` is in-memory and bounded — that's the whole design. Durability is a separate concern, and Drain is the primitive that bridges it: subscribe to a journal, buffer entries, flush batches to a `Sink` (stdout, file, OTLP HTTP, or a composite).

The pitch is simple. The guarantees are load-bearing:

- **Bounded buffer.** Like every primitive in Phyxius, there is no unbounded mode. A stuck sink can't eat your heap — overflow is a configurable policy, not a production crash.
- **Re-queue on failure.** If a sink throws (network blip, transient auth failure, 500 from the OTLP backend), the batch goes back to the head of the buffer and the next flush tries again. Transient errors recover without data loss.
- **Clock-driven scheduling.** No `setTimeout` inside the primitive. Flush timing is paced by the injected Clock, so ControlledClock works deterministically in tests.
- **Visible backpressure.** When the sink persistently can't keep up, new entries overflow the bounded buffer — and the operator sees `drain:overflow` events. Failure modes are observable, not silent.

---

## Installation

```bash
npm install @phyxiusjs/drain @phyxiusjs/journal @phyxiusjs/clock
```

---

## Quick start

```ts
import { createDrain, stdoutSink } from "@phyxiusjs/drain";
import { Journal } from "@phyxiusjs/journal";
import { createSystemClock } from "@phyxiusjs/clock";

const clock = createSystemClock();
const journal = new Journal<MyEvent>({ clock });

const drain = createDrain({
  journal,
  sink: stdoutSink(),
  clock,
});

// Journal writes now flow to stdout, batched every 5 seconds or every 100 entries.
journal.append({ type: "user.login", userId: "alice" });

// On shutdown: flush remaining, stop the timer, unsubscribe.
await drain.stop();
```

---

## Sinks

All sinks are small. They do one thing: take a batch, write it somewhere.

### `stdoutSink()`

Writes each entry as a JSON line to stdout. Ideal for local dev, Docker log collection, or piping to `jq`.

### `fileSink({ path })`

Appends JSON lines to a file. Uses async `fs.promises.appendFile` — ordering is guaranteed by Drain's in-flight flag, no need to block the event loop with sync writes.

### `otlpHttpSink({ endpoint, headers?, resourceAttributes? })`

POSTs entries as OTLP log records via native `fetch`. Compatible with any OTLP backend: Grafana Cloud, Axiom, SigNoz, an OpenTelemetry Collector. Objects and arrays in entry data are JSON-stringified into attribute values so they survive the wire intact.

```ts
createDrain({
  journal,
  clock,
  sink: otlpHttpSink({
    endpoint: "https://otel.axiom.co/v1/logs",
    headers: { Authorization: `Bearer ${process.env.AXIOM_TOKEN}` },
    resourceAttributes: { "service.name": "my-api", env: "prod" },
  }),
});
```

### `compositeSink([...])`

Fan out to multiple sinks in parallel. All sinks receive every batch; if any throws, the error propagates (Drain catches and re-queues).

```ts
createDrain({
  journal,
  clock,
  sink: compositeSink([stdoutSink(), otlpHttpSink({ endpoint: "..." })]),
});
```

### Writing your own

```ts
interface Sink<T> {
  write(entries: readonly DrainEntry<T>[]): Promise<void>;
}
```

Throw on failure — Drain will re-queue. Don't swallow errors; visibility is the point.

---

## Boundedness and overflow

```ts
createDrain({
  journal,
  sink,
  clock,
  batchSize: 100, // auto-flush when buffer hits this size (default 100)
  maxBufferSize: 10_000, // cap on the buffer (default 10_000)
  overflow: "drop_oldest", // or "error" — default "drop_oldest"
  flushIntervalMs: ms(5000), // periodic flush (default 5s, 0 to disable)
});
```

Overflow is a sink-failure phenomenon. When the sink keeps up with ingestion, Drain flushes before the buffer ever approaches `maxBufferSize`. Overflow means something is wrong — a persistent sink failure, a traffic spike outpacing your backend, etc. You want that to be loud, not silent.

Two honest choices:

- **`"drop_oldest"`** — evict the oldest entries to make room for new ones. Best effort: you lose history, not live data. Good for monitoring workloads where recent state matters more than historical events.
- **`"error"`** — reject new entries from the journal ingress path. Use when losing data is unacceptable and the operator must intervene before the system resumes normal behavior.

Both fire `drain:overflow` events so failures are observable.

---

## Re-queue on sink failure

Drain treats sink errors as **transient by default**. When `sink.write(batch)` throws:

1. The batch is unshifted back to the head of the buffer.
2. `drain:error` fires with `{ error, requeued: batch.length }`.
3. The next flush tick (or manual `flush()`) retries.

If failures persist, the buffer fills. Overflow kicks in per policy. New failures ride on top of old re-queued batches. The operator sees both `drain:error` and `drain:overflow` — the pattern is diagnostic: transient errors show `drain:error` spikes; permanent errors show the pair.

If you need per-sink retry/backoff/DLQ logic, build it into your `Sink` implementation. Drain provides the minimum guarantee — "don't lose data on one throw" — and stays out of your way.

---

## Clock-driven flush loop

The periodic flush is paced by `clock.sleep(flushIntervalMs)`, not `setTimeout`. In tests with a ControlledClock, you advance the clock and the flush fires deterministically:

```ts
const clock = createControlledClock({ initialTime: 0 });
const drain = createDrain({ journal, sink, clock, flushIntervalMs: ms(1_000) });

journal.append({ msg: "tick" });

clock.advanceBy(ms(1_000));
await clock.flush();
await new Promise((r) => setImmediate(r));

// Entry has been flushed to the sink.
```

Set `flushIntervalMs: 0` to disable the periodic loop — flushes happen only on batch-full or manual `flush()`.

---

## API

```ts
interface DrainOptions<T> {
  journal: Journal<T>;
  sink: Sink<T>;
  clock: Clock;
  batchSize?: number; // default 100
  maxBufferSize?: number; // default 10_000
  overflow?: "drop_oldest" | "error"; // default "drop_oldest"
  flushIntervalMs?: Millis; // default 5000, 0 disables
  emit?: (event: DrainEvent) => void;
}

interface Drain {
  flush(): Promise<void>; // drain all currently buffered entries
  stop(): Promise<void>; // flush remaining, cancel timer, unsubscribe
}

type DrainEvent =
  | { type: "drain:flush"; count: number; durationMs: number; at: Instant }
  | { type: "drain:error"; error: unknown; requeued: number; at: Instant }
  | { type: "drain:overflow"; policy: DrainOverflowPolicy; maxBufferSize: number; droppedCount: number; at: Instant }
  | { type: "drain:stop"; remaining: number; at: Instant };
```

Construction-time validation: `batchSize` and `maxBufferSize` must both be `> 0`, and `batchSize <= maxBufferSize`. Misconfiguration throws, not silently drops entries.

---

## What Drain does NOT do

- **No durability guarantees beyond re-queue.** If Node crashes between flushes, buffered entries are lost. For hard durability, sink to durable storage (disk, SQS, Kafka) and accept the batched-loss window.
- **No per-sink retry logic.** If you need exponential backoff, DLQ, or circuit breakers specific to a sink, implement them in the sink itself.
- **No transformation.** Entries flow from Journal to Sink as-is. If you need shape changes (redaction, enrichment), compose a wrapper `Sink<T>`.
- **No distributed coordination.** Drain is a single-process bridge. Cross-service pipelines are downstream of the sink.

---

## What you get

- **A visible bridge.** Journal stays ephemeral and bounded; Drain makes durability a separate, testable, observable layer.
- **Sane defaults.** 100-entry batches, 5s flush, 10k buffer, drop_oldest overflow. Production-viable out of the box.
- **Failure modes that don't hide.** Every error, every overflow, every stop produces a structured event. If something goes wrong, you see it — not just missing entries in your log backend.

Drain is small because it should be. The hard parts live in the sink (OTLP, Kafka, etc.) or in the journal (ordering, bounds). Drain just moves batches.

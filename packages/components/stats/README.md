# Stats

Poor-man's APM, composed from primitives you already have. Subscribes to a journal of `HandlerEvent`s, keeps per-handler rolling percentiles and error rates, emits threshold-breach events when a handler starts misbehaving.

Bounded memory. Zero dependencies beyond Clock / Journal / Handler. No vendor, no SaaS, no sampling loss, no "what did I ask Datadog to collect again?" Just typed stats, running in your process.

---

## Why this exists

Most production teams pay for an APM to answer three questions:

1. What's my p95 latency for this endpoint right now?
2. What's my error rate, and is it trending?
3. Which handlers are the outliers?

The _math_ to answer those questions is college statistics. What APMs actually sell you is:

- A place to store the samples
- A way to compute the percentiles
- A way to see them

Once your observability data is already a journal of typed events with durations attached, you already have (1). The math is (2). A health endpoint or a log line is (3). **You don't need to pay anyone for this.** You might want a dashboard, sure — but the metrics themselves are a composition of primitives you own.

Stats is that composition. Mount it, point it at your handler's journal, done.

---

## Installation

```bash
npm install @phyxiusjs/stats @phyxiusjs/clock @phyxiusjs/journal @phyxiusjs/handler
```

---

## Quick start

```ts
import { createSystemClock } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { spawn, type HandlerEvent } from "@phyxiusjs/handler";
import { createStats } from "@phyxiusjs/stats";

const clock = createSystemClock();
const journal = new Journal<HandlerEvent>({ clock });

const orderHandler = await spawn(orderSpec, { clock, journal });
// ... more handlers, all sharing the same journal

const stats = createStats({
  journal,
  clock,
  windowSize: 1000, // last 1000 invocations per handler
  thresholds: {
    "order.process": { p95Ms: 500, errorRate: 0.05 },
    "user.lookup": { p99Ms: 100 },
  },
  emit: (event) => journal.append(event), // wire alerts back into the stream
});

// Read current stats anywhere:
console.log(stats.snapshot("order.process"));
// {
//   name: "order.process",
//   lifetimeCount: 8473,
//   lifetimeFailures: 12,
//   windowSize: 1000,
//   errorRate: 0.002,
//   p50Ms: 12, p95Ms: 98, p99Ms: 312,
//   minMs: 3, maxMs: 1204, meanMs: 24.3,
// }
```

No sampling loss — every event counts. No vendor SDK. No config file in a foreign format. Just numbers you can read.

---

## The surface

```ts
interface Stats {
  snapshot(handlerName: string): HandlerSnapshot | null;
  snapshotAll(): ReadonlyArray<HandlerSnapshot>;
  stop(): void;
}

interface HandlerSnapshot {
  name: string;
  lifetimeCount: number; // ever-observed invocations (for rate derivation)
  lifetimeFailures: number;
  windowSize: number; // current samples in the ring buffer
  errorRate: number; // window failures / window size
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
}
```

Two read paths (`snapshot`, `snapshotAll`) and a lifecycle method (`stop`). That's the whole API.

---

## Sample-windowed, not time-windowed

The window is **the last N invocations**, not **the last N seconds**. This is a deliberate choice:

- **Time-windowed stats need a wall clock**, which introduces bugs around clock skew, idle gaps, and "what's the rate when nothing happened?"
- **Sample-windowed stats are deterministic.** The p95 of your last 1000 invocations is a well-defined number regardless of whether they took 5 seconds or 5 hours.
- **Time rates are trivially derivable** from `lifetimeCount` + wall-clock deltas if a caller needs them. Stats provides the raw material; rate is a view.

The default `windowSize: 1000` is a good starting point for most services — large enough for stable percentiles, small enough that `O(N log N)` sort per update is microseconds.

---

## Edge-triggered thresholds

Thresholds are checked on every event. When a value _crosses_ its limit for the first time, `stats:threshold-breached` fires. When it drops back below, `stats:threshold-recovered` fires. **One event per state change, not one per update.**

```ts
type StatsEvent =
  | { type: "stats:threshold-breached"; handler; field; value; limit; at }
  | { type: "stats:threshold-recovered"; handler; field; value; limit; at };
```

That means you can wire these events straight into an alerting pipeline (or PagerDuty, or a Slack webhook, or your journal) and get exactly the signal you want: "this handler started misbehaving," not "this handler is still misbehaving for the 400th check in a row."

Supported threshold fields: `errorRate`, `p50Ms`, `p95Ms`, `p99Ms`. Any field you omit isn't checked. Handlers without a threshold entry are observed but never alert.

---

## Memory bounds

Per-handler storage:

- `windowSize` durations (8 bytes each)
- `windowSize` outcome flags (1 byte each)
- Small fixed overhead for breach-state and lifetime counters

For `windowSize: 1000` × 50 handlers, that's ~450KB total. You could run this on a Raspberry Pi and not notice.

There is no unbounded mode. You can't accidentally OOM this. That's the "no unboundedness" invariant, expressed structurally.

---

## Composition

Stats is built entirely on primitives you already have:

- **`@phyxiusjs/journal`** — the event stream to subscribe to
- **`@phyxiusjs/clock`** — for event timestamps on threshold alerts
- **`@phyxiusjs/atom`** — the ring buffers are atoms in spirit (the package uses plain mutable state for perf; the bounded-ness is the invariant)

No new primitives were needed. The pattern "subscribe to a journal, derive something, emit events" recurs everywhere — drain, stats, and future projections will all look like this. That's what "compounding composition" means in practice: the same shape, applied to a new output.

---

## What this does NOT do

- **No time-windowed stats.** Sample windows only. Derive time rates from `lifetimeCount` if needed.
- **No storage.** Stats live in memory; a snapshot is a value. Persist it yourself if you want history.
- **No dashboards, no UI, no query language.** The snapshot is JSON. Render it however.
- **No distributed aggregation.** Each process tracks its own stats. For fleet-wide percentiles, ship snapshots to an aggregator — that's a different primitive.
- **No HDR histograms / sketch structures.** Simple arrays + sorts. Accurate for reasonable window sizes; consider a proper histogram library if you need billion-event-per-second throughput.

---

## What you get

- **P50 / p95 / p99 / error rate / min / max / mean per handler, for free.**
- **Edge-triggered alerts** on any of those fields, wired through the same event stream as everything else.
- **Bounded memory, zero dependencies beyond Phyxius primitives**, deterministic tests, runs anywhere Node runs.
- **No vendor lock-in for basic observability math.**

Stats is the package that lets you stop paying for questions you already have the data to answer.

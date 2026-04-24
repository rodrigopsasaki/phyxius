# Journal

A typed, bounded, sequence-ordered event log. Live subscription, replayable history, deterministic in tests.

---

## What this really is

In database parlance a "journal" is a durable write-ahead log. This isn't that — Journal is in-memory and ephemeral. Durability is `@phyxiusjs/drain`'s job: subscribe to a Journal and stream entries to a sink.

What Journal actually gives you in Node:

- **Monotonic sequence ordering.** Every append gets a strictly increasing `sequence`. That's the source of truth for order — not timestamps. You can never ambiguate "what came first," even when wall clocks jump.
- **Typed, structured events.** `T` flows through from `append` to `getSnapshot` to `subscribe`. No string parsing, no text-log diffing.
- **Synchronous live subscription.** Subscribers fire inside `append`, before it returns. Fast, ordered, reentrancy-protected.
- **O(1) indexed lookup by sequence.** `getEntry(n)` is constant time. Critical for replay and range scans.
- **A bounded cap with an explicit overflow policy.** Every journal is bounded. No unbounded mode exists.
- **Clock-bound timestamps.** Paired with `createControlledClock`, your event ordering is deterministic in tests.
- **Serialization hook.** `toJSON` / `fromJSON` for snapshot/restore, with a custom `Serializer` for non-plain data.

---

## Boundedness is not optional

There is no unbounded mode.

A journal that can grow without limit is an OOM waiting to happen. "We'll decide later what to drop" almost always becomes "production decided by crashing." The primitive forces the question on you up front:

```ts
type OverflowPolicy = "drop_oldest" | "error";

interface JournalOptions<T> {
  maxEntries?: number; // default 10_000
  overflow?: OverflowPolicy; // default "drop_oldest"
}
```

Two honest choices:

- **`"drop_oldest"`** — evict the oldest entry to make room. Good for monitoring/debugging workloads where recent events matter more. An overflow event fires so subscribers can see the drop; losing data isn't silent.
- **`"error"`** — throw `JournalOverflowError` on append when full. Good for producers you want to back-pressure when consumers fall behind.

Defaults exist so getting started is easy; the structure guarantees you've made the choice even when you didn't.

---

## The ordering insight

Node's event loop is single-threaded but not strictly ordered across async boundaries. Two microtask chains, two I/O callbacks, two timers — the order they land in your callbacks depends on the runtime, the OS scheduler, and any `await` points along the way.

Journal gives you a channel where the order is **yours, not the runtime's**:

```ts
const events = new Journal<{ type: string }>({ clock });

Promise.resolve().then(() => events.append({ type: "A" }));
Promise.resolve().then(() => events.append({ type: "B" }));
setTimeout(() => events.append({ type: "C" }), 0);

// Later, in a debugger or test:
events.getSnapshot().entries.forEach((e) => {
  console.log(e.sequence, e.data.type);
  // 0 A, 1 B, 2 C — whichever order they were appended in, sequence is the truth
});
```

The point isn't that Node's event loop is broken. It's that `sequence` is the only ordering you can trust without reasoning about microtask queues, phases, and kernel buffering. For debugging, replay, and audit, that's exactly what you want.

---

## Examples

### Example 1 — Typed event sourcing

```ts
import { Journal } from "@phyxiusjs/journal";
import { createSystemClock } from "@phyxiusjs/clock";

type OrderEvent =
  | { type: "order.created"; orderId: string; userId: string }
  | { type: "payment.processed"; orderId: string; amount: number }
  | { type: "order.shipped"; orderId: string; trackingId: string };

const clock = createSystemClock();
const log = new Journal<OrderEvent>({ clock, maxEntries: 100_000 });

log.append({ type: "order.created", orderId: "ord-123", userId: "alice" });
log.append({ type: "payment.processed", orderId: "ord-123", amount: 1299 });

// Query by discriminant — fully typed
const snapshot = log.getSnapshot();
const payments = snapshot.entries.filter((e) => e.data.type === "payment.processed");
```

### Example 2 — Live subscription composed with Drain

```ts
import { createDrain } from "@phyxiusjs/drain";

const journal = new Journal<AppEvent>({ clock });

// Durability lives in Drain, not Journal
const drain = createDrain({
  journal,
  clock,
  sink: s3Sink,
  batchSize: 500,
  flushIntervalMs: 5_000,
});

// Your code just appends — drain streams to S3 in batches
journal.append({ type: "user.login", userId: "alice" });
```

### Example 3 — Back-pressure via `"error"` policy

```ts
const ingress = new Journal<Request>({
  clock,
  maxEntries: 1_000,
  overflow: "error",
});

try {
  ingress.append(req);
} catch (err) {
  if (err instanceof JournalOverflowError) {
    // Shed load explicitly — 503 the producer, scale the consumer, etc.
    return { status: 503, retryAfter: 5 };
  }
  throw err;
}
```

### Example 4 — Snapshot and restore

```ts
const log = new Journal<AuditEntry>({ clock });
log.append({ action: "login", user: "alice" });
log.append({ action: "export", user: "alice", rows: 10_000 });

// Serialize
const serialized = log.toJSON();
// → { entries: [...], nextSequence: 2, createdAt: Instant }

// Later — sequence numbers and createdAt survive the roundtrip
const restored = Journal.fromJSON(serialized, { clock });
restored.append({ action: "logout", user: "alice" }); // gets sequence 2
```

### Example 5 — Deterministic ordering in tests

```ts
import { createControlledClock } from "@phyxiusjs/clock";

const clock = createControlledClock({ initialTime: 0 });
const journal = new Journal<string>({ clock });

journal.append("A");
clock.advanceBy(100);
journal.append("B");

const [a, b] = journal.getSnapshot().entries;
expect(a.sequence).toBe(0);
expect(a.timestamp.wallMs).toBe(0);
expect(b.sequence).toBe(1);
expect(b.timestamp.wallMs).toBe(100);
```

---

## Journal does NOT help you with

- **Durability.** Journal is in-memory. For persistence, subscribe a Drain to a sink (S3, disk, Postgres, Kafka, etc.).
- **Distributed ordering.** Sequence is per-journal. Cross-process ordering needs a different tool.
- **Log shipping and aggregation.** Not a replacement for Winston, Pino, or a logging pipeline.
- **Time-series metrics.** Events are discrete records, not aggregated counters.

---

## API at a glance

```ts
class Journal<T> {
  constructor(options: JournalOptions<T>);

  append(data: T): JournalEntry<T>;
  clear(): void;

  getEntry(sequence: number): JournalEntry<T> | undefined;
  getFirst(): JournalEntry<T> | undefined;
  getLast(): JournalEntry<T> | undefined;
  size(): number;
  isEmpty(): boolean;

  subscribe(fn: (entry: JournalEntry<T>) => void): () => void;
  getSnapshot(): JournalSnapshot<T>;

  toJSON(): SerializedJournal;
  static fromJSON<T>(json: SerializedJournal, options: JournalOptions<T>): Journal<T>;
}
```

### Options

```ts
interface JournalOptions<T> {
  clock: Clock;
  maxEntries?: number; // default 10_000, must be > 0
  overflow?: "drop_oldest" | "error"; // default "drop_oldest"
  idGenerator?: () => string; // default Math.random().toString(36).slice(2)
  emit?: (event: JournalEvent) => void;
  serializer?: {
    // for toJSON/fromJSON with non-plain data
    serialize(data: T): unknown;
    deserialize(data: unknown): T;
  };
}
```

### Snapshot semantics

`getSnapshot()` returns a **point-in-time view** whose top-level envelope and entry array are frozen. Later appends do not mutate the snapshot.

Individual entries are frozen at creation (the id/sequence/timestamp/data binding can't be mutated). User-provided `data` is **not** defensively cloned or deep-frozen. If you hand in mutable objects and mutate them afterward, that's on you — supply a `Serializer` for defensive copies.

### Reentrancy

Calling `append` from inside a subscriber throws `JournalReentrancyError`. Subscribers that want to append should defer (`queueMicrotask` or `setTimeout(0)`).

---

## Installation

```bash
npm install @phyxiusjs/journal @phyxiusjs/clock
```

---

## What you get

- **Trustworthy ordering.** Sequence numbers are monotonic, timestamps come from an injected Clock, and the truth survives async scheduling chaos.
- **Bounded by construction.** You cannot accidentally build an unbounded log. The overflow decision is in the primitive, not deferred to production.
- **Composable observability.** Subscribe for live fan-out, snapshot for point-in-time queries, drain for durability. The primitive stays small; behavior composes.
- **Deterministic in tests.** Pair with a controlled Clock and you get reproducible event timelines.

Journal is a small primitive. It holds a bounded sequence of typed events you can inspect, subscribe to, and replay. Everything else — durability, aggregation, distribution — composes on top.

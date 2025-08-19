# Journal

Events that never disappear. History you can trust. Debugging that actually works.

Every bug you've struggled to reproduce starts with the same problem: "I don't know what happened." Events vanish into the void. State changes without explanation. Systems fail and leave no trace.

Journal fixes this. Append-only log, perfect ordering, complete history.

Two implementations, one interface:

- In-memory journal for single-process event storage with guaranteed ordering.
- Serializable journal for persistence, with complete state snapshots and recovery.

---

## Why logs are broken

### Scattered evidence and lost context

```js
// This is broken. The evidence is already gone.
console.log("User logged in");
console.log("Processing payment...");
console.log("ERROR: Payment failed!");

// What happened? When? In what order? You'll never know.
```

### Race conditions in event ordering

```js
// Multiple async operations logging concurrently
Promise.resolve().then(() => console.log("Event A"));
Promise.resolve().then(() => console.log("Event B"));
setTimeout(() => console.log("Event C"), 0);

// Which happened first? The logs won't tell you.
```

Logs are scattered across files, timestamps don't align, events are lost, causality is destroyed. When production breaks, you're debugging with a blindfold.

---

## The Problem

Traditional logging gives you text lines scattered across files and systems. No guaranteed ordering, no structured data, no queryable history. When you need to understand what happened, the evidence is gone.

```ts
// Debugging nightmare: scattered logs across multiple places
class OrderService {
  async processOrder(order: Order) {
    console.log(`Processing order ${order.id}`);

    try {
      await this.validateOrder(order);
      console.log(`Order ${order.id} validated`);

      await this.chargePayment(order);
      console.log(`Payment charged for order ${order.id}`);
    } catch (error) {
      // Where did this error come from? What was the sequence?
      console.error(`Order processing failed: ${error}`);
    }
  }
}

// Logs are scattered, no guaranteed ordering, no structured data
```

---

## Journal helps you with this

### Example 1 — Perfect event ordering with structured data

```ts
import { Journal } from "@phyxius/journal";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();
const events = new Journal({ clock });

// Every event is preserved forever with perfect ordering
events.append({ type: "user.login", userId: "alice", ip: "1.2.3.4" });
events.append({ type: "payment.start", orderId: "ord-123", amount: 1000 });
events.append({ type: "payment.error", orderId: "ord-123", error: "CARD_DECLINED" });

// Get complete history
const history = events.getSnapshot();
history.entries.forEach((entry) => {
  console.log(`[${entry.sequence}] ${entry.data.type} at ${entry.timestamp.wallMs}`);
});
```

### Example 2 — Type-safe event sourcing

```ts
type OrderEvent =
  | { type: "order.created"; orderId: string; userId: string; items: string[] }
  | { type: "payment.processed"; orderId: string; amount: number }
  | { type: "order.shipped"; orderId: string; trackingId: string }
  | { type: "order.cancelled"; orderId: string; reason: string };

const orderLog = new Journal<OrderEvent>({ clock });

// Type-safe structured events
orderLog.append({
  type: "order.created",
  orderId: "ord-123",
  userId: "alice",
  items: ["laptop", "mouse"],
});

orderLog.append({
  type: "payment.processed",
  orderId: "ord-123",
  amount: 1299,
});

// Query by event type
const snapshot = orderLog.getSnapshot();
const payments = snapshot.entries.filter((e) => e.data.type === "payment.processed");
```

### Example 3 — Real-time event streaming

```ts
const userEvents = new Journal<{ type: string; userId: string; data: unknown }>({ clock });

// Subscribe to all new events
const unsubscribe = userEvents.subscribe((entry) => {
  console.log(`Event: ${entry.data.type} for user ${entry.data.userId}`);

  // Trigger real-time notifications, update dashboards, etc.
  if (entry.data.type === "purchase") {
    notifyRecommendationEngine(entry.data);
  }
});

// Every append triggers subscribers immediately
userEvents.append({ type: "purchase", userId: "alice", data: { amount: 99 } });
userEvents.append({ type: "logout", userId: "alice", data: { duration: 3600 } });
```

### Example 4 — Complete serialization and recovery

```ts
const log = new Journal<{ action: string; result: string }>({ clock });

log.append({ action: "backup_started", result: "success" });
log.append({ action: "data_validated", result: "success" });
log.append({ action: "backup_completed", result: "partial_failure" });

// Serialize complete state
const serialized = log.toJSON();
console.log(`Captured ${serialized.entries.length} events`);

// Later, restore from serialized state
const restored = Journal.fromJSON(serialized, { clock });
console.log(`Restored ${restored.size()} events`);
console.log(`First event: ${restored.getFirst()?.data.action}`);
```

---

## Journal does NOT help you with this

### Example 1 — Real-time log analysis

```ts
// Not Journal's job - use stream processing:
const pipeline = kafka
  .stream("events")
  .filter((event) => event.type === "error")
  .aggregate(countByType);
```

### Example 2 — Log shipping and aggregation

```ts
// Not Journal's job - use log infrastructure:
const logger = winston.createLogger({
  transports: [new winston.transports.File({ filename: "app.log" })],
});
```

### Example 3 — Time-series metrics

```ts
// Not Journal's job - use metrics systems:
metrics.increment("requests.count", { method: "GET", status: "200" });
```

---

## Why not just use console.log?

Traditional logging gives you unstructured text with no guarantees:

- **No ordering**: Concurrent operations can interleave log lines unpredictably.
- **No structure**: Text parsing is brittle and error-prone.
- **No persistence**: Logs rotate, get truncated, or are lost entirely.
- **No reactivity**: You can't subscribe to log events or build reactive systems.

Journal provides structured events with guaranteed ordering, complete persistence, and reactive subscriptions.

---

## What this is not

Journal is not a logging framework, not a database, not a message queue. It does not replace Winston, Pino, or application logs. It does not handle log rotation, shipping, or aggregation.

Journal is focused on preserving event history with perfect ordering and complete recovery. It provides the foundation for event sourcing, audit trails, and debugging systems.

If you want application logging, use a logging library. If you want metrics, use a metrics system. If you want perfect event history that never disappears, use Journal.

---

## Installation

```bash
npm install @phyxius/journal @phyxius/clock
```

---

## What you get

- Events that never disappear: append-only log with guaranteed preservation.
- History you can trust: every event is timestamped, ordered, and immutable.
- Debugging that actually works: complete event history enables time travel debugging.

Journal does not fix logging. It gives you structured events and perfect ordering to make system behavior observable and reproducible. Everything else builds on that foundation.

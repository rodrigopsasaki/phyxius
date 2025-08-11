# Phyxius

**Deterministic building blocks for reliable, observable Node.js applications**

Phyxius provides five fundamental primitives that, when combined, create systems that are not just functional, but truly **deterministic**, **observable**, and **reliable** in production.

## The Five Building Blocks

### 🕒 [Clock](./packages/clock/README.md) - Deterministic Time Control

Control time progression for reliable, testable applications.

```typescript
import { createSystemClock, createControlledClock } from "@phyxius/clock";

// Production: real time
const clock = createSystemClock();

// Testing: controlled time
const testClock = createControlledClock(1000);
testClock.advance(500); // Instant time travel
```

**Why it matters**: Time-dependent code becomes deterministic and testable. No more flaky tests or timing-dependent bugs.

### 💎 [Atom](./packages/atom/README.md) - Versioned Mutable References

Thread-safe state management with complete audit trails.

```typescript
import { createAtom } from "@phyxius/atom";

const counter = createAtom(0);

counter.update((n) => n + 1);
console.log(counter.get()); // 1

// Complete history available
console.log(counter.getHistory()); // Every change recorded
```

**Why it matters**: Eliminates race conditions while providing complete auditability. Perfect for building Software Transactional Memory systems.

### 📜 [Journal](./packages/journal/README.md) - Append-Only Event Logs

Capture every important event for replay, debugging, and audit trails.

```typescript
import { createJournal } from "@phyxius/journal";

const journal = createJournal();

await journal.append({
  type: "user.login",
  userId: "user123",
  timestamp: Date.now(),
});

// Powerful querying
const userEvents = await journal.filter((e) => e.userId === "user123");
```

**Why it matters**: Complete system observability and the ability to replay any scenario. The foundation of event sourcing architectures.

### ⚡ [Effect](./packages/effect/README.md) - Structured Concurrency

Context propagation and resource management for reliable async operations.

```typescript
import { runEffect } from "@phyxius/effect";

const result = await runEffect(async (context) => {
  context.set("userId", "user123");
  context.set("requestId", "req456");

  // Context flows through all operations
  return await performComplexOperation(context);
});
```

**Why it matters**: Eliminates resource leaks and provides distributed tracing. Context flows through operation chains automatically.

### 🏭 [Process](./packages/process/README.md) - Actor-Like Units with Supervision

Fault-tolerant distributed systems with automatic recovery.

```typescript
import { createSupervisor } from "@phyxius/process";

const supervisor = createSupervisor();

const worker = await supervisor.spawn({
  async handle(message) {
    // Process messages independently
    return processOrder(message.order);
  }
});

// Automatic restart on failure
await worker.send({ type: "process_order", order: {...} });
```

**Why it matters**: Build resilient systems that automatically recover from failures. Each process is isolated and supervised.

## The Power of Combination

While each primitive is powerful alone, they become **transformative** when used together. Here are real-world examples:

### 🏢 [Distributed Cache System](./examples/distributed-cache.md)

See how all five primitives combine to create a production-ready distributed cache with:

- **Atomic state management** preventing race conditions
- **Complete audit trails** for every cache operation
- **Deterministic testing** of TTL and cleanup logic
- **Context-aware operations** with distributed tracing
- **Fault-tolerant architecture** with automatic process recovery

### 💼 [Event-Sourced SaaS Platform](./examples/event-sourced-saas.md)

A complete multi-tenant SaaS platform showcasing:

- **Event sourcing** with complete audit compliance
- **Real-time features** with atomic state updates
- **Deterministic billing** based on usage events
- **Context propagation** across service boundaries
- **Resilient background processing** with supervision

### 👥 [Real-Time Collaboration System](./examples/real-time-collaboration.md)

A collaborative editor (like Google Docs) demonstrating:

- **Conflict-free collaboration** with operational transform
- **Atomic document state** preventing inconsistencies
- **Deterministic conflict resolution** with precise timing
- **Distributed context tracking** for user sessions
- **Fault-tolerant real-time updates** with process supervision

## Why Phyxius?

### Before: Traditional Approaches

```typescript
// Fragile, untestable, unobservable
let counter = 0;
const cache = new Map();

async function processOrder(order) {
  // Race conditions
  counter++;

  // Silent failures
  try {
    await updateDatabase(order);
  } catch (error) {
    console.log("Database update failed");
    // Lost forever, no recovery
  }

  // Time-dependent logic - impossible to test
  cache.set(order.id, order, Date.now() + 300000);
}
```

### After: Phyxius-Powered

```typescript
// Reliable, testable, observable
const counter = createAtom(0);
const orderJournal = createJournal();

async function processOrder(order, clock) {
  return runEffect(async (context) => {
    context.set("orderId", order.id);

    // Atomic update - no race conditions
    counter.update((n) => n + 1);

    // Complete audit trail
    await orderJournal.append({
      type: "order.processing_started",
      orderId: order.id,
      timestamp: clock.now(),
    });

    // Context flows through operation
    await updateDatabase(order, context);

    // Deterministic timing - fully testable
    await scheduleExpiry(order.id, clock.now() + 300000);
  });
}
```

## Design Philosophy

### **Boring on the Outside, Brilliant Under the Hood**

Phyxius primitives have simple, obvious APIs that hide sophisticated implementations. You write straightforward code that happens to be deterministic, observable, and reliable.

### **Composable by Design**

Each primitive solves one problem excellently and combines naturally with others. No forced architectures or complex frameworks - just building blocks.

### **Production-Ready from Day One**

Built for real systems with real requirements: performance, observability, fault tolerance, and compliance.

### **Test-Driven Development Made Easy**

Deterministic primitives make complex scenarios easily testable. No mocks, no sleeps, no flaky tests.

## Quick Start

```bash
npm install @phyxius/clock @phyxius/atom @phyxius/journal @phyxius/effect @phyxius/process
```

```typescript
import { createSystemClock } from "@phyxius/clock";
import { createAtom } from "@phyxius/atom";
import { createJournal } from "@phyxius/journal";
import { runEffect } from "@phyxius/effect";
import { createSupervisor } from "@phyxius/process";

// Your first deterministic, observable, reliable system
async function buildReliableSystem() {
  const clock = createSystemClock();
  const state = createAtom({ users: 0, orders: 0 });
  const events = createJournal();
  const supervisor = createSupervisor();

  const orderProcessor = await supervisor.spawn({
    async handle(message) {
      return runEffect(async (context) => {
        context.set("operation", "process_order");
        context.set("orderId", message.orderId);

        // Atomic state update
        state.update((s) => ({ ...s, orders: s.orders + 1 }));

        // Complete audit trail
        await events.append({
          type: "order.processed",
          orderId: message.orderId,
          timestamp: clock.now(),
        });

        return "Order processed successfully";
      });
    },
  });

  // Process an order
  await orderProcessor.send({
    type: "process_order",
    orderId: "order-123",
  });

  console.log("Current state:", state.get());
  console.log("Event history:", await events.getAll());
}

buildReliableSystem();
```

## Architecture Patterns

### Event Sourcing

Journal provides the foundation for event sourcing architectures:

```typescript
class EventSourcedAggregate {
  constructor(private journal = createJournal()) {}

  async applyCommand(command) {
    const events = this.validateCommand(command);
    for (const event of events) {
      await this.journal.append(event);
    }
    return this.rebuildStateFromEvents();
  }

  async rebuildStateFromEvents() {
    const events = await this.journal.getAll();
    return events.reduce(this.applyEvent, this.initialState);
  }
}
```

### CQRS with Process Supervision

Separate command and query responsibilities with fault tolerance:

```typescript
const supervisor = createSupervisor();

// Command side
const commandProcessor = await supervisor.spawn({
  async handle(command) {
    await journal.append({ type: "command.received", ...command });
    return await processCommand(command);
  },
});

// Query side
const queryProcessor = await supervisor.spawn({
  async handle(query) {
    return await buildProjection(query);
  },
});
```

### Saga Pattern with Context

Coordinate distributed transactions:

```typescript
async function orderSaga(orderId) {
  return runEffect(async (context) => {
    context.set("sagaId", generateId());
    context.set("orderId", orderId);

    try {
      await reserveInventory(orderId, context);
      await chargePayment(orderId, context);
      await fulfillOrder(orderId, context);
    } catch (error) {
      await compensate(orderId, context);
      throw error;
    }
  });
}
```

## Technical Specifications

### **Requirements**

- Node.js 22+ (ESM only)
- TypeScript 5.0+ (strict mode)
- Modern JavaScript environment

### **Performance**

- **Clock**: Sub-microsecond precision, zero allocation overhead
- **Atom**: Lock-free atomic updates, O(1) access time
- **Journal**: Append-optimized, configurable retention policies
- **Effect**: Minimal context overhead, efficient cleanup
- **Process**: Message passing optimized, low-latency supervision

### **Size**

Each primitive is ≤300 lines of code. Total bundle size <50KB minified.

### **Dependencies**

Zero external dependencies. Self-contained, auditable implementations.

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build all packages
pnpm build

# Type checking
pnpm typecheck

# Linting & formatting
pnpm lint
pnpm format
```

## Requirements

- Node.js ≥ 22.0.0
- pnpm ≥ 9.0.0
- ESM-only (`"type": "module"`)

## License

MIT

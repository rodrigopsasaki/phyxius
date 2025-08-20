# Phyxius

**Foundational primitives for Node.js systems.**

## What This Is

Phyxius provides small, focused primitives that handle common concurrency patterns in Node.js. Each primitive does one thing and can be used independently or combined with others.

## Current Primitives

### **Clock** - Controllable Time

Two time sources: wall time and monotonic time. Controllable in tests, consistent in production.

### **Atom** - Atomic State Updates

Versioned state with atomic updates. Prevents race conditions on shared data.

### **Journal** - Append-Only Events

Event log with ordering guarantees. Preserves history for replay and debugging.

### **Effect** - Structured Concurrency

Resource management with automatic cleanup. Operations can be cancelled cleanly.

### **Process** - Supervised Units

Isolated processes with restart strategies. Failures are contained and handled.

### **Context** - Thread-Local Storage

Typed AsyncLocalStorage for data that flows through async operations.

## Installation

Install individual primitives:

```bash
npm install @phyxiusjs/clock
npm install @phyxiusjs/atom
npm install @phyxiusjs/journal
npm install @phyxiusjs/effect
npm install @phyxiusjs/process
npm install @phyxiusjs/context
```

## Usage

Each primitive works independently:

```typescript
import { createSystemClock } from "@phyxiusjs/clock";
import { createAtom } from "@phyxiusjs/atom";
import { context } from "@phyxiusjs/context";

// Controllable time
const clock = createSystemClock();
await clock.sleep(1000); // Real time in production, controllable in tests

// Atomic state
const users = createAtom(new Map(), clock);
users.swap((map) => new Map(map).set("alice", { online: true }));

// Thread-local data
await context.scope(
  async () => {
    const ctx = context.get();
    // Data available throughout async call tree
  },
  { initial: { requestId: "req-123" } },
);
```

## Design Principles

- **Small scope**: Each primitive does one thing
- **Independent**: Primitives work alone or together
- **Testable**: Deterministic behavior in tests
- **Production-ready**: Handle edge cases and failures

## Package Structure

- **Core primitives**: Clock, Atom, Journal, Effect, Process
- **Components**: Context, Handler (work in progress)
- **Framework**: Integration utilities (planned)

Each package includes comprehensive tests and documentation.

---

_Node.js primitives that work reliably._

# Atom

**State that can't race. State with time. State you can trust.**

Every bug you've debugged that starts with "it works on my machine" traces back to race conditions in shared state. Two updates happening at the same time. Lost writes. Inconsistent reads.

Atom fixes this. One value, atomic updates, complete history.

## The Problem

```typescript
// This is broken. You just don't see it yet.
let counter = 0;

// Two async operations
Promise.resolve().then(() => counter++);
Promise.resolve().then(() => counter++);

// What's the final value? 1? 2? You don't know.
setTimeout(() => console.log(counter), 0); // Mystery
```

Shared mutable state is the source of all evil. Multiple writers, inconsistent reads, lost updates, race conditions that only happen in production when Jupiter aligns with Mars.

Most solutions add locks, mutexes, channels - complexity to manage complexity. Atom takes a different approach: make the operation atomic, not the access.

## The Solution

```typescript
import { createAtom } from "@phyxius/atom";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();
const counter = createAtom(0, clock);

// Two atomic updates
counter.swap((n) => n + 1);
counter.swap((n) => n + 1);

console.log(counter.deref()); // Always 2, never 1, never mystery
```

Every update is a pure function applied atomically. No race conditions. No lost writes. No mystery.

## Start Simple: Basic State

```typescript
import { createAtom } from "@phyxius/atom";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();

// Create atom with initial value
const name = createAtom("Alice", clock);

// Read current value
console.log(name.deref()); // "Alice"

// Update atomically
name.reset("Bob");
console.log(name.deref()); // "Bob"
```

`deref()` reads the current value. `reset()` replaces it entirely. Both operations are thread-safe and atomic.

## Add Transformations: Pure Updates

```typescript
const counter = createAtom(0, clock);

// Increment by applying a pure function
const newValue = counter.swap((n) => n + 1);
console.log(newValue); // 1
console.log(counter.deref()); // 1

// Multiple operations in sequence
counter.swap((n) => n * 2); // 2
counter.swap((n) => n + 10); // 12
counter.swap((n) => n / 3); // 4
```

`swap()` applies a pure function to transform the value atomically. The function receives the current value and returns the new value. No side effects, no mutations, no surprises.

## Add Safety: Compare-And-Set

```typescript
const balance = createAtom(100, clock);

// Only withdraw if balance is sufficient
function withdraw(amount: number): boolean {
  const current = balance.deref();

  if (current >= amount) {
    // Atomic compare-and-set prevents race conditions
    return balance.compareAndSet(current, current - amount);
  }

  return false; // Insufficient funds
}

// Two concurrent withdrawals of $60
const success1 = withdraw(60); // true (balance now 40)
const success2 = withdraw(60); // false (balance still 40)

console.log(balance.deref()); // 40 (not -20!)
```

`compareAndSet()` only updates if the current value equals the expected value. This prevents the classic "check-then-act" race condition that causes overdrafts, double-charges, and other financial disasters.

## Add History: Time Travel

```typescript
const user = createAtom(
  { name: "Alice", status: "offline" },
  clock,
  { historySize: 5 }, // Keep last 5 snapshots
);

user.swap((u) => ({ ...u, status: "online" }));
user.swap((u) => ({ ...u, name: "Alice Smith" }));
user.swap((u) => ({ ...u, status: "away" }));

// Get complete history
const history = user.history();
console.log(
  history.map((snap) => ({
    value: snap.value,
    version: snap.version,
    timestamp: snap.at.wallMs,
  })),
);

// Output:
// [
//   { value: { name: "Alice", status: "offline" }, version: 0, timestamp: 1000 },
//   { value: { name: "Alice", status: "online" }, version: 1, timestamp: 1010 },
//   { value: { name: "Alice Smith", status: "online" }, version: 2, timestamp: 1020 },
//   { value: { name: "Alice Smith", status: "away" }, version: 3, timestamp: 1030 }
// ]
```

Every state change is versioned and timestamped. Perfect for debugging ("what was the value at version 2?"), undo/redo, and audit trails.

## Add Reactivity: Automatic Updates

```typescript
const temperature = createAtom(20, clock);

// Subscribe to changes
const unsubscribe = temperature.watch((change) => {
  console.log(`Temperature changed from ${change.from}°C to ${change.to}°C`);
  console.log(`Version: ${change.versionFrom} → ${change.versionTo}`);
  console.log(`At: ${change.at.wallMs}`);

  if (change.to > 30) {
    console.log("🔥 Too hot! Turn on AC");
  }
});

temperature.reset(25); // Temperature changed from 20°C to 25°C
temperature.swap((t) => t + 10); // Temperature changed from 25°C to 35°C
// 🔥 Too hot! Turn on AC

// Clean up
unsubscribe();
```

Subscribers receive synchronous notifications with complete change details. Build reactive UIs, trigger side effects, maintain derived state - all with perfect ordering guarantees.

## Add Intelligence: Optimized Updates

```typescript
const config = createAtom({ theme: "dark", language: "en" }, clock, {
  // Custom equality to avoid no-op updates
  equals: (a, b) => a.theme === b.theme && a.language === b.language,
});

let changeCount = 0;
config.watch(() => changeCount++);

// This triggers a change notification
config.swap((c) => ({ ...c, theme: "light" }));
console.log(changeCount); // 1

// This does NOT trigger a change (same values)
config.swap((c) => ({ theme: "light", language: "en" }));
console.log(changeCount); // Still 1 (no-op detected)
```

Custom equality functions prevent spurious updates. Especially powerful for complex objects where deep equality or specific field comparisons matter more than reference equality.

## Add Metadata: Causality Tracking

```typescript
const score = createAtom(0, clock);

score.watch((change) => {
  console.log(`Score: ${change.from} → ${change.to}`);
  console.log(`Cause: ${change.cause}`);
});

// Track why changes happened
score.swap((s) => s + 10, { cause: "level_completed" });
// Score: 0 → 10, Cause: level_completed

score.swap((s) => s + 5, { cause: "bonus_collected" });
// Score: 10 → 15, Cause: bonus_collected

score.reset(0, { cause: "game_reset" });
// Score: 15 → 0, Cause: game_reset
```

The `cause` metadata flows through to change notifications. Perfect for event sourcing, debugging, analytics, and understanding the "why" behind every state change.

## Advanced: Coordinated State

```typescript
// Multiple atoms working together
const firstName = createAtom("Alice", clock);
const lastName = createAtom("Smith", clock);
const email = createAtom("alice@example.com", clock);

// Coordinated update using versions for consistency
function updateUser(first: string, last: string, newEmail: string) {
  const v1 = firstName.version();
  const v2 = lastName.version();
  const v3 = email.version();

  // Update all three
  firstName.reset(first, { cause: "user_update" });
  lastName.reset(last, { cause: "user_update" });
  email.reset(newEmail, { cause: "user_update" });

  return {
    firstName: { from: v1, to: firstName.version() },
    lastName: { from: v2, to: lastName.version() },
    email: { from: v3, to: email.version() },
  };
}

const changes = updateUser("Bob", "Jones", "bob.jones@example.com");
// All atoms updated atomically, versions tracked
```

Version numbers provide coordination points. Multiple atoms can be updated in sequence with full traceability of what changed when.

## Advanced: State Machines

```typescript
type ConnectionState =
  | { status: "disconnected" }
  | { status: "connecting"; attempt: number }
  | { status: "connected"; connectedAt: number }
  | { status: "error"; error: string; lastAttempt: number };

const connection = createAtom<ConnectionState>({ status: "disconnected" }, clock);

// State machine transitions
function connect() {
  const current = connection.deref();

  if (current.status === "disconnected") {
    connection.reset(
      {
        status: "connecting",
        attempt: 1,
      },
      { cause: "user_connect" },
    );

    // Simulate async connection
    setTimeout(() => {
      const state = connection.deref();
      if (state.status === "connecting") {
        connection.reset(
          {
            status: "connected",
            connectedAt: Date.now(),
          },
          { cause: "connection_success" },
        );
      }
    }, 1000);
  } else if (current.status === "error") {
    connection.reset(
      {
        status: "connecting",
        attempt: current.lastAttempt + 1,
      },
      { cause: "reconnect_attempt" },
    );
  }
}

// Type-safe state machine with atomic transitions
connection.watch((change) => {
  if (change.to.status === "connected") {
    console.log("🎉 Connected!");
  } else if (change.to.status === "error") {
    console.log(`❌ Connection failed: ${change.to.error}`);
  }
});
```

Atoms + TypeScript discriminated unions = type-safe state machines with atomic transitions and complete audit trails.

## Advanced: Derived State

```typescript
// Source of truth
const cart = createAtom<Array<{ id: string; price: number; qty: number }>>([], clock);

// Derived state that updates automatically
const cartTotal = createAtom(0, clock);

cart.watch((change) => {
  const total = change.to.reduce((sum, item) => sum + item.price * item.qty, 0);
  cartTotal.reset(total, { cause: "cart_changed" });
});

// Add items to cart
cart.swap((items) => [...items, { id: "book", price: 10, qty: 2 }]);
console.log(cartTotal.deref()); // 20

cart.swap((items) => [...items, { id: "pen", price: 5, qty: 1 }]);
console.log(cartTotal.deref()); // 25

// Remove item
cart.swap((items) => items.filter((item) => item.id !== "pen"));
console.log(cartTotal.deref()); // 20
```

Reactive derived state with automatic consistency. Change the source, derived state updates immediately with full causality tracking.

## The Full Power: Conflict-Free State Synchronization

```typescript
// Simulate distributed state across multiple nodes
class NodeState {
  private node: string;
  private data: Atom<Map<string, { value: number; version: number; node: string }>>;

  constructor(nodeId: string, clock: Clock) {
    this.node = nodeId;
    this.data = createAtom(new Map(), clock);
  }

  // Local update with node identifier
  set(key: string, value: number) {
    this.data.swap(
      (map) => {
        const current = map.get(key);
        const newVersion = (current?.version ?? 0) + 1;

        return new Map(map).set(key, {
          value,
          version: newVersion,
          node: this.node,
        });
      },
      { cause: `${this.node}_update` },
    );
  }

  // Merge state from another node (last-writer-wins with version vectors)
  mergeFrom(other: NodeState) {
    const otherData = other.data.deref();

    this.data.swap(
      (localMap) => {
        const merged = new Map(localMap);

        for (const [key, remoteEntry] of otherData) {
          const localEntry = merged.get(key);

          if (!localEntry || remoteEntry.version > localEntry.version) {
            // Remote is newer, accept it
            merged.set(key, remoteEntry);
          } else if (remoteEntry.version === localEntry.version && remoteEntry.node > localEntry.node) {
            // Same version, use node ID as tiebreaker
            merged.set(key, remoteEntry);
          }
          // Otherwise keep local version
        }

        return merged;
      },
      { cause: `merge_from_${other.node}` },
    );
  }

  get(key: string): number | undefined {
    return this.data.deref().get(key)?.value;
  }

  snapshot() {
    return this.data.snapshot();
  }
}

// Three nodes in a distributed system
const nodeA = new NodeState("A", clock);
const nodeB = new NodeState("B", clock);
const nodeC = new NodeState("C", clock);

// Concurrent updates
nodeA.set("counter", 1);
nodeB.set("counter", 2);
nodeC.set("counter", 3);

console.log("Before sync:");
console.log("A:", nodeA.get("counter")); // 1
console.log("B:", nodeB.get("counter")); // 2
console.log("C:", nodeC.get("counter")); // 3

// Synchronize state (gossip protocol)
nodeA.mergeFrom(nodeB);
nodeA.mergeFrom(nodeC);
nodeB.mergeFrom(nodeA);
nodeC.mergeFrom(nodeA);

console.log("After sync:");
console.log("A:", nodeA.get("counter")); // 3 (highest version wins)
console.log("B:", nodeB.get("counter")); // 3
console.log("C:", nodeC.get("counter")); // 3

// Complete convergence with full audit trail
const finalState = nodeA.snapshot();
console.log("Final version:", finalState.version);
console.log("Final timestamp:", finalState.at.wallMs);
```

This is the full power of Atom. Version vectors, conflict resolution, eventual consistency, complete audit trails. The building blocks for distributed systems that actually work.

## Interface

```typescript
interface Atom<T> {
  deref(): T;
  version(): number;
  swap(updater: (current: T) => T, opts?: { cause?: unknown }): T;
  reset(next: T, opts?: { cause?: unknown }): T;
  compareAndSet(expected: T, next: T, opts?: { cause?: unknown }): boolean;
  snapshot(): AtomSnapshot<T>;
  watch(fn: (change: Change<T>) => void): () => void;
  history(): readonly AtomSnapshot<T>[];
  clearHistory(): void;
}

interface AtomSnapshot<T> {
  readonly value: T;
  readonly version: number;
  readonly at: Instant;
}

interface Change<T> {
  readonly from: T;
  readonly to: T;
  readonly versionFrom: number;
  readonly versionTo: number;
  readonly at: Instant;
  readonly cause?: unknown;
}

interface AtomOptions<T> {
  equals?: (a: T, b: T) => boolean;
  baseVersion?: number;
  historySize?: number;
}
```

## Installation

```bash
npm install @phyxius/atom @phyxius/clock
```

## What You Get

**State that can't race.** Every update is atomic. No lost writes, no race conditions, no mystery states.

**State with time.** Every change is versioned and timestamped. Perfect for debugging, undo/redo, and audit trails.

**State you can trust.** Compare-and-set prevents conflicts. Custom equality avoids no-ops. Reentrant-safe notifications prevent cascades.

**State that scales.** From simple counters to distributed CRDTs. From reactive UIs to event-sourced systems.

Atom solves state. Everything else builds on that foundation.

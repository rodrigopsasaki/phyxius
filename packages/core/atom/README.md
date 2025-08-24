# Atom

State that can't race. State with time. State you can trust.

Every bug you've debugged that starts with "it works on my machine" traces back to race conditions in shared state. Two updates happening at the same time. Lost writes. Inconsistent reads.

Atom fixes this. One value, atomic updates, complete history.

Two implementations, one interface:

- In-memory atom for single-process state management with atomic operations.
- Controlled atom for tests, with deterministic timing and observable changes.

---

## Why shared state is broken

### Race conditions in async operations

```js
// This is broken. You just don't see it yet.
let counter = 0;

// Two async operations
Promise.resolve().then(() => counter++);
Promise.resolve().then(() => counter++);

// What's the final value? 1? 2? You don't know.
setTimeout(() => console.log(counter), 0); // Mystery
```

### Lost updates during concurrent access

```js
// Classic check-then-act race condition
let balance = 100;

function withdraw(amount) {
  if (balance >= amount) {
    // Another withdrawal can happen here!
    balance -= amount;
    return true;
  }
  return false;
}

// Two concurrent withdrawals of $60
withdraw(60); // true (balance now 40)
withdraw(60); // true (balance now -20!)
```

Most solutions add locks, mutexes, channels - complexity to manage complexity. Atom takes a different approach: make the operation atomic, not the access.

---

## The Problem

Shared mutable state is the source of all evil. Multiple writers, inconsistent reads, lost updates, race conditions that only happen in production when Jupiter aligns with Mars.

```ts
// Business logic mixed with concurrency concerns
class UserService {
  private cache = new Map();

  async getUser(id: string) {
    // Check cache
    if (this.cache.has(id)) {
      return this.cache.get(id);
    }

    // Race condition: two requests for same user might both fetch
    const user = await this.database.getUser(id);
    this.cache.set(id, user); // Lost update if cache was cleared

    return user;
  }
}
```

---

## Atom helps you with this

### Example 1 — Atomic updates without race conditions

```ts
import { createAtom } from "@phyxiusjs/atom";
import { createSystemClock } from "@phyxiusjs/clock";

const clock = createSystemClock();
const counter = createAtom(0, clock);

// Two atomic updates
counter.swap((n) => n + 1);
counter.swap((n) => n + 1);

console.log(counter.deref()); // Always 2, never 1, never mystery
```

### Example 2 — Safe concurrent withdrawals

```ts
const balance = createAtom(100, clock);

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
```

### Example 3 — Reactive state with change notifications

```ts
const temperature = createAtom(20, clock);

// Subscribe to changes
const unsubscribe = temperature.watch((change) => {
  console.log(`Temperature: ${change.from}°C → ${change.to}°C`);

  if (change.to > 30) {
    console.log("🔥 Too hot! Turn on AC");
  }
});

temperature.swap((t) => t + 15); // Temperature: 20°C → 35°C
// 🔥 Too hot! Turn on AC
```

### Example 4 — Complete audit trail with history

```ts
const user = createAtom(
  { name: "Alice", status: "offline" },
  clock,
  { historySize: 5 }, // Keep last 5 snapshots
);

user.swap((u) => ({ ...u, status: "online" }));
user.swap((u) => ({ ...u, name: "Alice Smith" }));

// Get complete history
const history = user.history();
history.forEach((snap) => {
  console.log(`v${snap.version}: ${snap.value.name} - ${snap.value.status}`);
});
// v0: Alice - offline
// v1: Alice - online
// v2: Alice Smith - online
```

---

## Atom does NOT help you with this

### Example 1 — Complex business logic

```ts
// Not Atom's job - use domain objects:
class BankAccount {
  constructor(private balance: Atom<number>) {}

  withdraw(amount: number): boolean {
    // Complex business rules go here
    if (this.isOverdraftAllowed(amount)) {
      return this.balance.compareAndSet(/* ... */);
    }
    return false;
  }
}
```

### Example 2 — Network synchronization

```ts
// Not Atom's job - use distributed systems tools:
const replica = createCRDT();
replica.merge(otherReplica);
```

### Example 3 — UI framework integration

```ts
// Not Atom's job - use framework adapters:
const [state, setState] = useAtom(myAtom); // React integration
```

---

## Why not just use locks?

Traditional locks solve race conditions but create new problems:

- **Deadlock**: Process A waits for Process B, Process B waits for Process A.
- **Starvation**: High-priority operations block low-priority ones indefinitely.
- **Performance**: Lock contention becomes a bottleneck under high load.
- **Complexity**: Correct lock ordering is hard to get right and maintain.

Atoms use lock-free atomic operations that never block. Compare-and-swap provides consistency without the traditional problems of mutual exclusion.

---

## What this is not

Atom is not a database, not a distributed system, not a UI state manager. It does not replace Redux, MobX, or Zustand. It does not handle network synchronization or persistence.

Atom is focused on making single-process shared state safe and observable. It provides the foundation that other systems can build on.

If you want distributed state, use a CRDT library. If you want UI reactivity, use a framework adapter. If you want atomic guarantees for your local state, use Atom.

---

## Installation

```bash
npm install @phyxiusjs/atom @phyxiusjs/clock
```

---

## What you get

- State that can't race: atomic operations prevent lost updates and inconsistent reads.
- State with time: every change is versioned and timestamped for perfect audit trails.
- State you can trust: compare-and-set operations and configurable equality prevent bugs.

Atom does not fix concurrency. It gives you atomic operations and observable changes to make concurrency explicit and safe. Everything else builds on that foundation.

# Journal

**Events that never disappear. History you can trust. Debugging that actually works.**

Every bug you've struggled to reproduce starts with the same problem: "I don't know what happened." Events vanish into the void. State changes without explanation. Systems fail and leave no trace.

Journal fixes this. Append-only log, perfect ordering, complete history.

## The Problem

```typescript
// This is broken. The evidence is already gone.
console.log("User logged in");
console.log("Processing payment...");
console.log("ERROR: Payment failed!");

// What happened? When? In what order? You'll never know.
```

Logs are scattered across files, timestamps don't align, events are lost, causality is destroyed. When production breaks, you're debugging with a blindfold.

Most logging libraries give you text lines in files. That's not enough. You need structured events with guaranteed ordering, complete context, and queryable history.

## The Solution

```typescript
import { Journal } from "@phyxius/journal";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();
const events = new Journal({ clock });

// Every event is preserved forever
events.append({ type: "user.login", userId: "alice", ip: "1.2.3.4" });
events.append({ type: "payment.start", amount: 1000, currency: "USD" });
events.append({ type: "payment.error", error: "CARD_DECLINED", code: 4001 });

// Perfect ordering, complete context, never lost
```

Every event gets a unique ID, sequence number, timestamp, and preserved forever. No more mystery bugs.

## Start Simple: Basic Events

```typescript
import { Journal } from "@phyxius/journal";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();
const log = new Journal({ clock });

// Append events
const entry1 = log.append("User clicked button");
const entry2 = log.append("Button action completed");

console.log(entry1);
// {
//   id: "abc123",
//   sequence: 0,
//   timestamp: { wallMs: 1640995200000, monoMs: 1000 },
//   data: "User clicked button"
// }
```

Every entry has:

- **ID**: Unique identifier for cross-system references
- **Sequence**: Gapless ordering within this journal
- **Timestamp**: Exact moment when appended
- **Data**: Your event payload

## Add Structure: Rich Events

```typescript
type UserEvent =
  | { type: "login"; userId: string; source: "web" | "mobile" }
  | { type: "logout"; userId: string; duration: number }
  | { type: "purchase"; userId: string; amount: number; items: string[] };

const userLog = new Journal<UserEvent>({ clock });

// Type-safe structured events
userLog.append({
  type: "login",
  userId: "alice",
  source: "web",
});

userLog.append({
  type: "purchase",
  userId: "alice",
  amount: 2499,
  items: ["laptop", "mouse"],
});

userLog.append({
  type: "logout",
  userId: "alice",
  duration: 3600000, // 1 hour session
});
```

TypeScript discriminated unions give you type-safe events with exhaustive checking. No more missing fields or wrong types.

## Add Queries: Find Anything

```typescript
const log = new Journal<UserEvent>({ clock });

// Add multiple events
log.append({ type: "login", userId: "alice", source: "web" });
log.append({ type: "login", userId: "bob", source: "mobile" });
log.append({ type: "purchase", userId: "alice", amount: 1000, items: ["book"] });
log.append({ type: "logout", userId: "bob", duration: 300000 });

// Get specific entry by sequence
const firstEvent = log.getEntry(0);
console.log(firstEvent?.data); // { type: "login", userId: "alice", ... }

// Get range
const snapshot = log.getSnapshot();
console.log(snapshot.entries.length); // 4
console.log(snapshot.firstSequence); // 0
console.log(snapshot.lastSequence); // 3

// Filter by type
const purchases = snapshot.entries.filter((e) => e.data.type === "purchase");
console.log(purchases.length); // 1
```

O(1) lookup by sequence number. Snapshots are immutable and deep-frozen - safe to pass around without fear of mutations.

## Add Reactivity: Real-Time Processing

```typescript
const events = new Journal<UserEvent>({ clock });

// Subscribe to all new events
const unsubscribe = events.subscribe((entry) => {
  console.log(`New event: ${entry.data.type} at sequence ${entry.sequence}`);

  if (entry.data.type === "purchase") {
    console.log(`💰 Purchase: $${entry.data.amount / 100}`);
  } else if (entry.data.type === "login") {
    console.log(`👋 User ${entry.data.userId} logged in via ${entry.data.source}`);
  }
});

// Every append triggers subscribers immediately
events.append({ type: "login", userId: "alice", source: "web" });
// Output: New event: login at sequence 0
//         👋 User alice logged in via web

events.append({ type: "purchase", userId: "alice", amount: 2500, items: ["game"] });
// Output: New event: purchase at sequence 1
//         💰 Purchase: $25.00

// Clean up
unsubscribe();
```

Subscribers fire synchronously for every new entry. Build real-time dashboards, trigger side effects, maintain projections - all with guaranteed ordering.

## Add Persistence: Durable Events

```typescript
const events = new Journal<UserEvent>({ clock });

// Add some events
events.append({ type: "login", userId: "alice", source: "web" });
events.append({ type: "purchase", userId: "alice", amount: 1000, items: ["book"] });

// Serialize to JSON
const serialized = events.toJSON();
console.log(serialized);
// {
//   entries: [
//     { id: "abc", sequence: 0, timestamp: {...}, data: {...} },
//     { id: "def", sequence: 1, timestamp: {...}, data: {...} }
//   ],
//   nextSequence: 2,
//   createdAt: {...}
// }

// Later, restore from JSON
const restored = Journal.fromJSON(serialized, { clock });
console.log(restored.size()); // 2
console.log(restored.getEntry(0)?.data.type); // "login"
```

Perfect serialization round-trip. Save to files, databases, or send over the network. Full state restoration with complete fidelity.

## Add Boundaries: Overflow Control

```typescript
// Bounded journal with drop-oldest policy
const boundedLog = new Journal<string>({
  clock,
  maxEntries: 3,
  overflow: "bounded:drop_oldest",
});

boundedLog.append("Event 1");
boundedLog.append("Event 2");
boundedLog.append("Event 3");
console.log(boundedLog.size()); // 3

// Adding a 4th event drops the oldest
boundedLog.append("Event 4");
console.log(boundedLog.size()); // 3
console.log(boundedLog.getFirst()?.data); // "Event 2" (Event 1 was dropped)

// Error policy instead
const errorLog = new Journal<string>({
  clock,
  maxEntries: 2,
  overflow: "bounded:error",
});

errorLog.append("Event 1");
errorLog.append("Event 2");

try {
  errorLog.append("Event 3"); // Throws JournalOverflowError
} catch (error) {
  console.log(error.message); // "Journal overflow: maximum entries (2) reached"
}
```

Different overflow policies for different use cases. `drop_oldest` for sliding windows, `error` for strict bounds, `none` for unlimited growth.

## Add Observability: Complete Transparency

```typescript
const events = new Journal<UserEvent>({
  clock,
  emit: (event) => {
    console.log("Journal event:", event);
  },
});

// Every operation emits structured events
events.append({ type: "login", userId: "alice", source: "web" });
// Journal event: { type: "journal:append", id: "abc", seq: 0, size: 1, at: {...} }

events.clear();
// Journal event: { type: "journal:clear", previousSize: 1, at: {...} }

// Subscriber errors are captured
events.subscribe(() => {
  throw new Error("Oops");
});

events.append({ type: "logout", userId: "alice", duration: 1000 });
// Journal event: { type: "journal:append", ... }
// Journal event: { type: "journal:subscriber:error", seq: 1, error: Error("Oops"), at: {...} }
```

Every operation emits telemetry events. Monitor performance, track errors, understand system behavior. No operation is invisible.

## Add Custom IDs: Deterministic References

```typescript
// Custom ID generator for deterministic tests
let idCounter = 0;
const testLog = new Journal<string>({
  clock,
  idGenerator: () => `test-${++idCounter}`,
});

const entry = testLog.append("Test event");
console.log(entry.id); // "test-1"

// UUIDs for production
import { v4 as uuid } from "uuid";

const prodLog = new Journal<UserEvent>({
  clock,
  idGenerator: uuid,
});

const prodEntry = prodLog.append({ type: "login", userId: "alice", source: "web" });
console.log(prodEntry.id); // "550e8400-e29b-41d4-a716-446655440000"
```

Control ID generation for your use case. Deterministic for tests, UUIDs for production, content hashes for deduplication.

## Add Complex Types: Serialization Support

```typescript
// Custom serializer for complex objects
class UserSession {
  constructor(
    public userId: string,
    public startTime: Date,
    public metadata: Map<string, unknown>,
  ) {}
}

const sessionLog = new Journal<UserSession>({
  clock,
  serializer: {
    serialize: (session) => ({
      userId: session.userId,
      startTime: session.startTime.toISOString(),
      metadata: Array.from(session.metadata.entries()),
    }),
    deserialize: (data: any) => new UserSession(data.userId, new Date(data.startTime), new Map(data.metadata)),
  },
});

const session = new UserSession(
  "alice",
  new Date(),
  new Map([
    ["source", "web"],
    ["userAgent", "Chrome"],
  ]),
);

sessionLog.append(session);

// Serialization preserves complex types
const serialized = sessionLog.toJSON();
const restored = Journal.fromJSON(serialized, sessionLog.options);
const restoredSession = restored.getFirst()?.data;

console.log(restoredSession instanceof UserSession); // true
console.log(restoredSession?.metadata.get("source")); // "web"
```

Custom serializers handle any data type. Classes, Maps, Sets, Dates, BigInts - anything you need.

## Advanced: Event Sourcing

```typescript
// Events define all state changes
type AccountEvent =
  | { type: "account.created"; accountId: string; ownerId: string }
  | { type: "deposit"; accountId: string; amount: number; source: string }
  | { type: "withdrawal"; accountId: string; amount: number; target: string }
  | { type: "transfer.out"; accountId: string; amount: number; targetAccount: string }
  | { type: "transfer.in"; accountId: string; amount: number; sourceAccount: string };

// Account state derived entirely from events
class Account {
  public readonly id: string;
  public readonly ownerId: string;
  public balance = 0;
  public transactions: string[] = [];

  constructor(id: string, ownerId: string) {
    this.id = id;
    this.ownerId = ownerId;
  }

  // Apply an event to update state
  apply(event: AccountEvent): void {
    switch (event.type) {
      case "account.created":
        // Already handled in constructor
        break;
      case "deposit":
        this.balance += event.amount;
        this.transactions.push(`+${event.amount} from ${event.source}`);
        break;
      case "withdrawal":
        this.balance -= event.amount;
        this.transactions.push(`-${event.amount} to ${event.target}`);
        break;
      case "transfer.out":
        this.balance -= event.amount;
        this.transactions.push(`-${event.amount} to account ${event.targetAccount}`);
        break;
      case "transfer.in":
        this.balance += event.amount;
        this.transactions.push(`+${event.amount} from account ${event.sourceAccount}`);
        break;
    }
  }
}

// Event store manages all account events
class AccountStore {
  private eventLog = new Journal<AccountEvent>({ clock });
  private accounts = new Map<string, Account>();

  constructor() {
    // Rebuild state from events on startup
    this.eventLog.subscribe((entry) => {
      this.applyEvent(entry.data);
    });
  }

  createAccount(accountId: string, ownerId: string): Account {
    const event: AccountEvent = {
      type: "account.created",
      accountId,
      ownerId,
    };

    this.eventLog.append(event);
    return this.accounts.get(accountId)!;
  }

  deposit(accountId: string, amount: number, source: string): void {
    this.eventLog.append({
      type: "deposit",
      accountId,
      amount,
      source,
    });
  }

  withdraw(accountId: string, amount: number, target: string): boolean {
    const account = this.accounts.get(accountId);
    if (!account || account.balance < amount) {
      return false;
    }

    this.eventLog.append({
      type: "withdrawal",
      accountId,
      amount,
      target,
    });

    return true;
  }

  transfer(fromAccountId: string, toAccountId: string, amount: number): boolean {
    const fromAccount = this.accounts.get(fromAccountId);
    if (!fromAccount || fromAccount.balance < amount) {
      return false;
    }

    // Two events for atomic transfer
    this.eventLog.append({
      type: "transfer.out",
      accountId: fromAccountId,
      amount,
      targetAccount: toAccountId,
    });

    this.eventLog.append({
      type: "transfer.in",
      accountId: toAccountId,
      amount,
      sourceAccount: fromAccountId,
    });

    return true;
  }

  getAccount(accountId: string): Account | undefined {
    return this.accounts.get(accountId);
  }

  // Replay events to build current state
  private applyEvent(event: AccountEvent): void {
    let account = this.accounts.get(event.accountId);

    if (!account && event.type === "account.created") {
      account = new Account(event.accountId, event.ownerId);
      this.accounts.set(event.accountId, account);
    }

    account?.apply(event);
  }

  // Time travel - rebuild state up to specific point
  getAccountAtSequence(accountId: string, maxSequence: number): Account | undefined {
    const snapshot = this.eventLog.getSnapshot();
    const relevantEvents = snapshot.entries
      .filter((entry) => entry.sequence <= maxSequence)
      .filter((entry) => entry.data.accountId === accountId)
      .map((entry) => entry.data);

    if (relevantEvents.length === 0) return undefined;

    const account = new Account(
      accountId,
      relevantEvents[0].type === "account.created" ? relevantEvents[0].ownerId : "unknown",
    );

    for (const event of relevantEvents) {
      account.apply(event);
    }

    return account;
  }
}

// Usage
const store = new AccountStore();

const alice = store.createAccount("alice", "user-123");
const bob = store.createAccount("bob", "user-456");

store.deposit("alice", 1000, "initial_deposit");
store.deposit("bob", 500, "initial_deposit");
store.transfer("alice", "bob", 250);

console.log("Current state:");
console.log("Alice balance:", store.getAccount("alice")?.balance); // 750
console.log("Bob balance:", store.getAccount("bob")?.balance); // 750

// Time travel - what was Alice's balance after the deposit but before the transfer?
const aliceAtSequence2 = store.getAccountAtSequence("alice", 2);
console.log("Alice at sequence 2:", aliceAtSequence2?.balance); // 1000
```

This is event sourcing in its purest form. All state changes are events. Current state is derived by replaying events. Time travel comes for free. Audit trails are automatic. Bugs become reproducible.

## The Full Power: Distributed Event Log

```typescript
// Multi-node event replication with conflict resolution
class DistributedJournal<T> {
  private localLog: Journal<T & { nodeId: string; localSequence: number }>;
  private nodeId: string;
  private vectorClock = new Map<string, number>();

  constructor(nodeId: string, clock: Clock) {
    this.nodeId = nodeId;
    this.localLog = new Journal({ clock });
  }

  // Append event with node metadata
  append(data: T): void {
    const localSequence = this.vectorClock.get(this.nodeId) ?? 0;
    this.vectorClock.set(this.nodeId, localSequence + 1);

    this.localLog.append({
      ...data,
      nodeId: this.nodeId,
      localSequence: localSequence + 1,
    });
  }

  // Merge events from another node
  mergeFrom(otherJournal: DistributedJournal<T>): void {
    const otherSnapshot = otherJournal.localLog.getSnapshot();

    for (const entry of otherSnapshot.entries) {
      const event = entry.data;
      const lastKnown = this.vectorClock.get(event.nodeId) ?? 0;

      // Only accept events we haven't seen
      if (event.localSequence > lastKnown) {
        this.localLog.append(event);
        this.vectorClock.set(event.nodeId, event.localSequence);
      }
    }
  }

  // Get globally ordered view (deterministic total order)
  getGlobalView(): Array<T & { nodeId: string; localSequence: number }> {
    const snapshot = this.localLog.getSnapshot();

    // Sort by (localSequence, nodeId) for deterministic ordering
    return snapshot.entries
      .map((e) => e.data)
      .sort((a, b) => {
        if (a.localSequence !== b.localSequence) {
          return a.localSequence - b.localSequence;
        }
        return a.nodeId.localeCompare(b.nodeId);
      });
  }
}

// Three nodes in a distributed system
const nodeA = new DistributedJournal<{ type: string; value: number }>("node-A", clock);
const nodeB = new DistributedJournal<{ type: string; value: number }>("node-B", clock);
const nodeC = new DistributedJournal<{ type: string; value: number }>("node-C", clock);

// Concurrent events on different nodes
nodeA.append({ type: "increment", value: 1 });
nodeB.append({ type: "increment", value: 2 });
nodeC.append({ type: "increment", value: 3 });

nodeA.append({ type: "increment", value: 4 });
nodeB.append({ type: "increment", value: 5 });

// Gossip protocol - nodes share their logs
nodeA.mergeFrom(nodeB);
nodeA.mergeFrom(nodeC);
nodeB.mergeFrom(nodeA);
nodeC.mergeFrom(nodeA);

// All nodes converge to the same global ordering
const globalOrder = nodeA.getGlobalView();
console.log("Global event order:");
globalOrder.forEach((event) => {
  console.log(`${event.nodeId}: ${event.type} ${event.value} (seq: ${event.localSequence})`);
});

// Output (deterministic total order):
// node-A: increment 1 (seq: 1)
// node-B: increment 2 (seq: 1)
// node-C: increment 3 (seq: 1)
// node-A: increment 4 (seq: 2)
// node-B: increment 5 (seq: 2)
```

This is the full power of Journal. Vector clocks, conflict-free replication, deterministic total ordering, perfect consistency across any number of nodes.

## Interface

```typescript
interface Journal<T> {
  append(data: T): JournalEntry<T>;
  getEntry(sequence: number): JournalEntry<T> | undefined;
  getFirst(): JournalEntry<T> | undefined;
  getLast(): JournalEntry<T> | undefined;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  subscribe(fn: (entry: JournalEntry<T>) => void): () => void;
  getSnapshot(): JournalSnapshot<T>;
  toJSON(): SerializedJournal;
}

interface JournalEntry<T> {
  id: string;
  sequence: number;
  timestamp: Instant;
  data: T;
}

interface JournalOptions<T> {
  clock: Clock;
  idGenerator?: () => string;
  emit?: (event: JournalEvent) => void;
  maxEntries?: number;
  overflow?: "none" | "bounded:drop_oldest" | "bounded:error";
  serializer?: Serializer<T>;
}
```

## Installation

```bash
npm install @phyxius/journal @phyxius/clock
```

## What You Get

**Events that never disappear.** Perfect ordering, guaranteed delivery, complete preservation. No more lost evidence.

**History you can trust.** Every event is timestamped, versioned, and immutable. Audit trails come for free.

**Debugging that actually works.** Time travel to any point, replay any scenario, understand any failure.

**Systems that scale.** From simple logs to distributed event stores to full event sourcing. One foundation, infinite possibilities.

Journal solves history. Everything else builds on that foundation.

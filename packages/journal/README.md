# @phyxius/journal

**Append-only log for replay and debugging in Node.js applications.**

A production-ready journal implementation with deterministic time, O(1) operations, and configurable backpressure policies.

## Hard Truths

- **This is not a database.** It's an in-memory append-only log. Data is lost when the process exits unless you serialize it.
- **Time is deterministic.** All timestamps come from the injected Clock interface. No `Date.now()` anywhere.
- **Backpressure matters.** Configure overflow policies or your memory will grow unbounded.
- **Re-entrancy is forbidden.** You cannot append during subscriber notification. This prevents infinite loops.
- **Snapshots are expensive.** They perform deep cloning and freezing. Use sparingly.
- **Serialization is opt-in.** Provide a custom serializer or accept the default JSON behavior.

## Installation

```bash
npm install @phyxius/journal @phyxius/clock
```

## Quick Start

```typescript
import { Journal } from "@phyxius/journal";
import { SystemClock } from "@phyxius/clock";

const journal = new Journal({
  clock: new SystemClock(),
});

// Append entries
const entry1 = journal.append({ action: "user_login", userId: "123" });
const entry2 = journal.append({ action: "page_view", path: "/dashboard" });

// O(1) access
const entry = journal.getEntry(0);
console.log(entry?.data); // { action: "user_login", userId: "123" }

// Subscribe to new entries
const unsubscribe = journal.subscribe((entry) => {
  console.log("New entry:", entry.data);
});

journal.append({ action: "user_logout", userId: "123" });
unsubscribe();
```

## API Reference

### Constructor Options

```typescript
interface JournalOptions<T> {
  clock: Clock; // Required: time source
  idGenerator?: IdGenerator; // Optional: ID generation function
  emit?: EmitFn; // Optional: event emission
  maxEntries?: number; // Optional: maximum entries
  overflow?: OverflowPolicy; // Optional: "none" | "bounded:drop_oldest" | "bounded:error"
  serializer?: Serializer<T>; // Optional: custom serialization
}
```

### Core Operations

```typescript
// O(1) append
const entry = journal.append(data);

// O(1) access by sequence number
const entry = journal.getEntry(42);

// Get first/last entries
const first = journal.getFirst();
const last = journal.getLast();

// Size and emptiness
const size = journal.size();
const empty = journal.isEmpty();

// Clear all entries
journal.clear();
```

### Subscribers

```typescript
// Subscribe to new entries
const unsubscribe = journal.subscribe((entry) => {
  console.log("New:", entry.data);
});

// Unsubscribe
unsubscribe();
```

### Snapshots

```typescript
// Create immutable snapshot
const snapshot = journal.getSnapshot();

console.log({
  totalCount: snapshot.totalCount,
  firstSequence: snapshot.firstSequence,
  lastSequence: snapshot.lastSequence,
  timestamp: snapshot.timestamp,
  entries: snapshot.entries, // ReadonlyArray<Readonly<JournalEntry<T>>>
});
```

### Serialization

```typescript
// Serialize
const serialized = journal.toJSON();

// Restore
const restored = Journal.fromJSON(serialized, { clock });
```

## Backpressure Policies

### No Limits (`"none"`)

```typescript
const journal = new Journal({
  clock,
  overflow: "none", // Default
});

// Journal grows unbounded
for (let i = 0; i < 1_000_000; i++) {
  journal.append(i);
}
```

### Drop Oldest (`"bounded:drop_oldest"`)

```typescript
const journal = new Journal({
  clock,
  maxEntries: 1000,
  overflow: "bounded:drop_oldest",
});

// After 1000 entries, oldest are dropped
journal.append("entry 1001"); // Drops entry 1
```

### Error on Overflow (`"bounded:error"`)

```typescript
const journal = new Journal({
  clock,
  maxEntries: 1000,
  overflow: "bounded:error",
});

// Throws JournalOverflowError after 1000 entries
journal.append("entry 1001"); // throws
```

## Event Emission

```typescript
import type { JournalEvent } from "@phyxius/journal";

const events: JournalEvent[] = [];

const journal = new Journal({
  clock,
  emit: (event) => events.push(event),
});

journal.append("test");
console.log(events[1]); // { type: "journal:append", id: "...", seq: 0, size: 1, at: Instant }
```

## Custom Serialization

```typescript
interface User {
  id: string;
  name: string;
  email: string;
}

const journal = new Journal<User>({
  clock,
  serializer: {
    serialize: (user) => ({
      id: user.id,
      name: user.name,
      // Omit email for privacy
    }),
    deserialize: (data: any) => ({
      id: data.id,
      name: data.name,
      email: "[redacted]", // Default value
    }),
  },
});
```

## Deterministic Testing

```typescript
import { ControlledClock } from "@phyxius/clock";

const clock = new ControlledClock(0);
let idCounter = 0;

const journal = new Journal({
  clock,
  idGenerator: () => `id-${++idCounter}`,
});

clock.advance(100);
const entry = journal.append("test");

expect(entry.id).toBe("id-1");
expect(entry.timestamp.wallMs).toBe(100);
expect(entry.sequence).toBe(0);
```

## Event Sourcing Pattern

```typescript
interface Event {
  type: string;
  aggregateId: string;
  version: number;
  data: unknown;
}

const eventStore = new Journal<Event>({ clock });

// Append events
eventStore.append({
  type: "UserCreated",
  aggregateId: "user-123",
  version: 1,
  data: { name: "Alice", email: "alice@example.com" },
});

eventStore.append({
  type: "UserEmailChanged",
  aggregateId: "user-123",
  version: 2,
  data: { email: "alice.smith@example.com" },
});

// Replay events for aggregate
function getEventsForAggregate(id: string): Event[] {
  const snapshot = eventStore.getSnapshot();
  return snapshot.entries.map((entry) => entry.data).filter((event) => event.aggregateId === id);
}

const userEvents = getEventsForAggregate("user-123");
console.log(userEvents.length); // 2
```

## Error Handling

```typescript
import { JournalReentrancyError, JournalOverflowError } from "@phyxius/journal";

try {
  journal.subscribe(() => {
    journal.append("reentrant"); // Forbidden
  });
  journal.append("trigger");
} catch (error) {
  if (error instanceof JournalReentrancyError) {
    console.log("Cannot append during subscriber notification");
  }
}

try {
  const boundedJournal = new Journal({
    clock,
    maxEntries: 1,
    overflow: "bounded:error",
  });

  boundedJournal.append("first");
  boundedJournal.append("second"); // throws
} catch (error) {
  if (error instanceof JournalOverflowError) {
    console.log("Journal is full");
  }
}
```

## Performance Characteristics

- **Append**: O(1) amortized
- **GetEntry**: O(1) lookup by sequence number
- **Size**: O(n) - counts non-undefined entries
- **GetFirst/GetLast**: O(n) worst case when many entries are dropped
- **Snapshot**: O(n) - creates deep copy
- **Serialization**: O(n) - iterates all entries

## Memory Usage

Each entry stores:

- `id`: string (~20-40 bytes)
- `sequence`: number (8 bytes)
- `timestamp`: Instant object (~20 bytes)
- `data`: your payload size

Dense array storage means dropped entries leave `undefined` holes, but the array doesn't shrink until `clear()` is called.

## TypeScript

Fully typed with strict generics:

```typescript
const stringJournal = new Journal<string>({ clock });
const numberJournal = new Journal<number>({ clock });
const eventJournal = new Journal<MyEvent>({ clock });

// Type-safe data access
const entry = stringJournal.getEntry(0);
if (entry) {
  const data: string = entry.data; // ✓ Type-safe
}
```

## License

MIT

# Atom

Versioned, observable state. Timestamped by a Clock you control. A working `compareAndSet` for the moment that actually bites in Node: async retry.

---

## What this really is

Clojure's atom was built for a preemptive-multithreaded runtime. Node isn't that. A synchronous block in JavaScript — including the entire body of `swap(updater)` — can't be interrupted by anything else. So "atomic against threads" isn't the pitch.

The pitch is what's left once you take that for granted:

- **Versioned state** — every commit bumps a monotonic number. Useful for ordering, for "did this change since I last looked?", and as the basis for compare-and-set.
- **Structured change notifications** — `watch` gives you a typed `Change<T>` with old value, new value, version pair, and an `Instant` from the injected Clock. Subscribe, route into a Journal, build whatever audit trail you want.
- **Clock-bound timestamps** — every snapshot and change carries an `Instant` (wall + mono). Integrate with `createControlledClock` and your state transitions become deterministic in tests.
- **A working CAS for async retry** — the one case where "atomic" is the right word in Node: a read, an await, then a conditional write.

None of these are "race conditions." The word is rented from a runtime Node doesn't have. Drop it.

---

## The pattern that actually bites

Node's event loop is single-threaded, but it is not strictly ordered across async boundaries. The moment you `await`, state can change underneath you:

```ts
// Two concurrent handleEvent calls for different events
async function handleEvent(e) {
  const current = state; // read
  const processed = await process(e); // yield — state may now be stale
  state = {
    // write with stale `current`
    count: current.count + 1,
    events: [...current.events, processed],
  };
}
```

Event A lands, Event B lands, one write is lost. Classic.

Atom fixes this not by adding locks but by making the commit sync:

```ts
async function handleEvent(e) {
  const processed = await process(e);
  atoms.state.swap((s) => ({
    count: s.count + 1,
    events: [...s.events, processed],
  }));
}
```

The swap body is synchronous. Both events land. No CAS needed in this shape because the derivation happens inside the updater — the updater always sees the committed latest value.

When the derivation genuinely depends on a value that was read before an await, use CAS:

```ts
const curr = atom.deref();
const next = await derive(curr); // yields
if (!atom.compareAndSet(curr, next)) {
  // somebody else swapped during the await — retry or reconcile
}
```

---

## Examples

### Example 1 — Atomic commit across concurrent async flows

```ts
import { createAtom } from "@phyxiusjs/atom";
import { createSystemClock } from "@phyxiusjs/clock";

const clock = createSystemClock();
const counter = createAtom(0, clock);

await Promise.all(Array.from({ length: 100 }, () => Promise.resolve().then(() => counter.swap((n) => n + 1))));

console.log(counter.deref()); // exactly 100
```

### Example 2 — CAS for async read-modify-write

```ts
async function safeWithdraw(amount: number): Promise<boolean> {
  while (true) {
    const curr = balance.deref();
    if (curr < amount) return false;

    const next = curr - amount;
    // await a side-effect like a risk check, audit log, etc.
    await recordIntent(curr, next);

    if (balance.compareAndSet(curr, next)) return true;
    // another flow won the commit; loop and try again
  }
}
```

### Example 3 — Change stream as the observability channel

```ts
const user = createAtom({ name: "Alice", status: "offline" }, clock);

user.watch((change) => {
  journal.append({
    kind: "user.changed",
    from: change.from,
    to: change.to,
    version: change.versionTo,
    at: change.at,
    cause: change.cause,
  });
});

user.swap((u) => ({ ...u, status: "online" }), { cause: "ws.connect" });
```

### Example 4 — Deterministic audit in tests

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";

const clock = createControlledClock({ initialTime: 1_000 });
const atom = createAtom(0, clock, { historySize: 10 });

clock.advanceBy(ms(100));
atom.swap((n) => n + 1);

clock.advanceBy(ms(250));
atom.swap((n) => n + 1);

const history = atom.history();
// [{ value: 0, version: 0, at: { monoMs: 1000, ... } },
//  { value: 1, version: 1, at: { monoMs: 1100, ... } },
//  { value: 2, version: 2, at: { monoMs: 1350, ... } }]
```

---

## Atom does NOT help you with

- **Complex business logic.** Atom holds state. Domain rules live in the code that calls `swap`.
- **Distributed or cross-process state.** A single-process value. For replication, CRDTs, or shared memory across processes, use a different tool.
- **UI reactivity.** Framework adapters wrap Atom; Atom doesn't know about React, Vue, or Solid.
- **Persistent history.** The ring buffer is a debugging aid. For durable event history, route `watch` into `@phyxiusjs/journal`.

---

## API at a glance

```ts
interface Atom<T> {
  deref(): T;
  version(): number;
  snapshot(): AtomSnapshot<T>;

  swap(updater: (current: T) => T, opts?: { cause?: unknown }): T;
  reset(next: T, opts?: { cause?: unknown }): T;
  compareAndSet(expected: T, next: T, opts?: { cause?: unknown }): boolean;

  watch(fn: (change: Change<T>) => void): () => void;

  history(): readonly AtomSnapshot<T>[];
  clearHistory(): void;
}
```

`compareAndSet` uses the configured `equals` (defaults to `Object.is`). It prevents the classic "my snapshot is stale across an await" case. It does NOT protect against value-ABA if a concurrent flow round-trips through the expected value — in Clojure-style usage with immutable domain records this is rarely a concern, but if you hold primitives you should be aware of it.

### Options

```ts
interface AtomOptions<T> {
  equals?: (a: T, b: T) => boolean;
  historySize?: number; // default 0 — history() returns [] unless opted in
  emit?: (event: AtomEvent) => void;
}
```

`emit` receives out-of-band events — currently only `atom:subscriber:error` when a watch callback throws. Without `emit`, subscriber errors are silently swallowed. The library does not write to stderr on your behalf.

---

## Installation

```bash
npm install @phyxiusjs/atom @phyxiusjs/clock
```

---

## What you get

- State whose changes are **values** you can inspect, store, and replay.
- Commits that are **atomic within a sync block** — the property Node's runtime gives you for free, exposed as a first-class primitive.
- A **CAS** that earns its keep in the one place Node has real ordering hazards: across `await`.
- **Deterministic timestamps** when paired with a controlled Clock.

Atom is a small primitive. It does one thing: hold a value that changes in a disciplined, observable way. Bigger things — audit trails, distributed consensus, UI binding — compose on top.

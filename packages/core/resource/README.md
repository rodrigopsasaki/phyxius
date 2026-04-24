# Resource

Acquire, use, release — with the hard parts removed. Every successful acquire is released exactly once, no matter how the `use` body ends (resolve, throw, timeout, early return). Composes cleanly: acquire many resources in parallel, acquire a dependency chain in sequence, nest freely.

---

## What this really is

Node gives you `try / finally`. The language doesn't give you a _composable discipline_ for bracketing resources. In any real system — DB connections, file handles, subprocesses, temp directories, subscribed channels — you accumulate nested `finally` blocks that subtly break when:

- An inner acquire throws after an outer one succeeded (partial leak).
- You want to release N resources in reverse order of acquisition.
- You want to acquire N resources in parallel and clean up whichever succeeded when any fails.
- A timeout fires mid-acquire.
- A scope propagates through an async boundary.

`Resource<T>` is the value that captures "this thing has a scoped lifetime." It doesn't do the acquire until you call `use()`. It guarantees release on every path. It composes.

Until TC39 `using` ships and stabilizes everywhere, `Resource` is the discipline. Afterwards, it's still useful — `using` is per-block; `Resource` is a value you can pass, combine, and rewrite.

---

## Installation

```bash
npm install @phyxiusjs/resource
```

---

## Quick start

```ts
import { resource } from "@phyxiusjs/resource";
import pg from "pg";

const dbConn = resource.make(
  async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return client;
  },
  async (client) => {
    await client.end();
  },
  { name: "pg-connection" },
);

// Use it. Release is guaranteed, even if the body throws.
const users = await dbConn.use(async (client) => {
  const result = await client.query("SELECT * FROM users");
  return result.rows;
});
```

`dbConn` is a value. You can pass it, return it, compose it — it hasn't acquired anything yet. Each `.use()` call is an independent acquire → use → release cycle.

---

## The `Resource<T>` type

```ts
interface Resource<T> {
  use<R>(fn: (value: T) => Promise<R>): Promise<R>;
  map<U>(fn: (value: T) => U): Resource<U>;
}
```

Two methods, both well-defined:

- **`use(fn)`** — acquire → run `fn(value)` → release. Guarantees release exactly once for every successful acquire, regardless of how `fn` ends. Release errors are emitted as events, never thrown — so a broken `release` never masks a real error from `fn`.
- **`map(fn)`** — transform the acquired value without touching lifecycle. The original resource stays responsible for release; `map` is only ever a view.

---

## Construction

```ts
resource.make(acquire, release, options?): Resource<T>
```

The primary constructor. `acquire` produces the value; `release` tears it down. Both may be sync or async.

```ts
resource.of(value): Resource<T>
```

A resource that holds an already-acquired value and does nothing on release. Useful alongside real resources in compositions.

```ts
resource.bracket(acquire, release, use): Promise<R>
```

One-shot convenience for `make(...).use(...)`. Identical semantics; shorter at the call site.

---

## Composition

Two operators, two explicit semantics. Pick the one that matches your dependency shape — the difference is load-bearing.

### `resource.parallel([a, b, c])`

**Acquire concurrently, release concurrently.** If any acquire fails, the ones that already succeeded are released before the error propagates.

Use when the resources are independent: two DB connections to different servers, a Redis client + a log file, three concurrent HTTP sessions.

```ts
const result = await resource.parallel([db, redis, logFile]).use(async ([db, redis, log]) => {
  log.info("starting job");
  const data = await db.query("...");
  await redis.set("cache-key", data);
  return data.length;
});
```

### `resource.sequence([a, b, c])`

**Acquire in order, release in reverse order.** If acquire N fails, the resources 0 through N-1 are released in reverse before the error propagates.

Use when resources have a dependency chain: a transaction depends on its connection, a file depends on its directory lock. Reverse-order release respects dependencies — the outer layer stays alive while the inner layer tears down.

```ts
const result = await resource.sequence([conn, tx]).use(async ([conn, tx]) => {
  // tx was acquired using conn; tx will be released before conn.
  return await tx.query("UPDATE ...");
});
```

### Why the distinction matters

A parallel release of `[conn, tx]` could close the connection before the transaction rollback ran — you'd leak a stuck transaction on the server. `sequence` prevents that by construction. When order matters, it's not cosmetic; it's correctness.

---

## Observability

Options: `{ clock, name, emit }`. All optional, but supplying a `clock` and `emit` unlocks duration tracking and the full event stream.

```ts
type ResourceEvent =
  | { type: "resource:acquired"; name; at; durationMs }
  | { type: "resource:released"; name; at; durationMs }
  | { type: "resource:acquire-failed"; name; at; cause }
  | { type: "resource:release-failed"; name; at; cause; duringUseError };
```

Wire `emit` into a journal and you get:

- Acquire/release durations on every bracket — spot slow pool checkouts.
- Acquire-failure visibility without wrapping every `use()` in `try/catch`.
- **Release failures**, which are otherwise invisible because they're swallowed. The `duringUseError` flag tells you whether release failed while another error was in flight (which is why we couldn't throw it).

---

## Guarantees

- Release fires exactly once per successful acquire.
- Release fires on `fn` resolve, throw, and async rejection.
- Release errors never mask `fn` errors — `fn`'s error propagates unchanged; release failure is emitted.
- If acquire throws, release never fires (there's nothing to release).
- `parallel` releases everything that was acquired, even if a later acquire fails.
- `sequence` releases in reverse order of acquisition.
- `map` never affects lifecycle — the underlying resource is the sole owner of release.
- Emitter failures are swallowed; nothing in the acquire/release chain cascades through them.

---

## What this does NOT do

- **No signal-based cancellation of in-flight `use`.** If you want to abort, wrap externally with `Promise.race`. The `use()` call still completes its cleanup in the background — the race just stops waiting.
- **No retry on acquire.** Compose with `@phyxiusjs/retry` at the acquire function.
- **No pool management.** A connection pool is a Resource that vends Resources — compose one when you need it.
- **No TC39 `using` interop in v1.** Once `using` is stable everywhere, a `[Symbol.asyncDispose]` shim is a ~5-line addition.

---

## What you get

- **Every lifecycle failure typed and emitted.** No silent leaks. No masked errors.
- **Composable scope.** Parallel + sequence cover the two real dependency shapes; everything else nests.
- **Lifecycle as a value.** You can build a `Resource<T>` in one module and `use` it in another — it hasn't acquired anything until someone calls `use`.

Resource is the primitive Node's standard library forgot. Everything in Phyxius that touches external state — DB connections, files, subprocesses — will eventually compose through it.

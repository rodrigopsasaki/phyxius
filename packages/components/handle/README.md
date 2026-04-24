# Handle

The bracket primitive. Run async work inside a request-scoped container that captures intent, accumulates observed fields, applies a timeout with a real AbortSignal, and appends one journal entry when it's done.

---

## What this really is

`handle` is the composition every request-shaped primitive ends up needing: HTTP handlers, queue consumers, cron jobs, scheduled tasks, anything where "do some work for a unit of work" is the shape. Instead of hand-rolling that bracket every time, compose on top of `handle`.

What happens on every invocation:

1. Opens a fresh `context.scope` seeded with caller-provided data
2. Stamps `handlerName / requestId / startedAt` via typed observe fields
3. Creates a `Clock.Budget` for the timeout (if configured) — its `AbortSignal` is handed to the work
4. Runs the work, racing against the budget's abort
5. On completion: stamps `durationMs / success` (plus `errorType / errorMessage` on failure)
6. Appends **one** canonical log entry to the Journal
7. Returns `{ result: Result<T, HandleError>, log: CanonicalLog }`

So: open scope → work → capture outcome → persist one event. The observability thesis in ~150 lines.

---

## Installation

```bash
npm install @phyxiusjs/handle @phyxiusjs/clock @phyxiusjs/journal @phyxiusjs/context @phyxiusjs/observe @phyxiusjs/fp
```

---

## Quick start

```ts
import { createHandler } from "@phyxiusjs/handle";
import { createSystemClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { isOk } from "@phyxiusjs/fp";

// Declare what this handler observes — the sidecar type
const fields = observe.fields({
  userId: observe.field<string>(),
  foundInCache: observe.field<boolean>(),
});

const clock = createSystemClock();
const journal = new Journal({ clock });
const handle = createHandler({ clock, journal });

const { result, log } = await handle({
  name: "getUser",
  initial: { source: "http" }, // seed metadata into the scope
  timeoutMs: ms(5_000),
  run: async ({ clock, signal }) => {
    const res = await fetch("/users/123", { signal }); // aborts cleanly on timeout
    const user = await res.json();
    fields.userId.set(user.id);
    fields.foundInCache.set(false);
    return user;
  },
});

if (isOk(result)) {
  console.log("got user", result.value);
}
// `log` has handlerName, requestId, startedAt, durationMs, success,
// plus `source`, `userId`, `foundInCache` from the scope.
```

---

## Timeout, the real one

Timeouts go through `Clock.Budget`. The budget's `AbortSignal` is exposed via `tools.signal`. Pass it to any AbortSignal-aware API and the work exits cleanly when the deadline elapses — not orphaned in the background still consuming CPU, memory, and external state.

```ts
await handle({
  name: "httpRequest",
  timeoutMs: ms(2_000),
  run: async ({ signal }) => {
    // fetch aborts when signal aborts
    const res = await fetch(url, { signal });
    return res.json();
  },
});
```

When no `timeoutMs` is configured, `tools.signal` is a never-aborting signal — same shape, no null checks at call sites.

If your work isn't signal-aware (CPU-bound work, a library that ignores signals), the promise is still raced against the budget and handle returns `Err(TIMEOUT)` — but the work keeps running. That's unavoidable in Node. The signal is the escape hatch for code that can participate.

---

## Deterministic testing

Because everything is Clock-driven, timeout tests are reproducible:

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";

const clock = createControlledClock({ initialTime: 0 });
const handle = createHandler({ clock, journal });

const pending = handle({
  name: "slow",
  timeoutMs: ms(50),
  run: async ({ clock: c }) => {
    await c.sleep(ms(200)); // uses the controlled clock
    return "too late";
  },
});

// Let the scope and sleep get registered
await Promise.resolve();

// Advance past the deadline — budget fires, signal aborts, run rejects
clock.advanceBy(ms(50));
await clock.flush();

const { result } = await pending;
// result is Err({ type: "TIMEOUT", ... })
```

No real time passes. No flaky tests.

---

## Canonical log

The log is an open-shape object `{ [key: string]: unknown }` with a guaranteed core:

```ts
interface CanonicalLog {
  readonly handlerName: string;
  readonly requestId: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly errorType?: string;
  readonly errorMessage?: string;
  readonly [key: string]: unknown; // everything else from initial/observe
}
```

The log is populated from three sources, all merged into the scope's `data`:

- **Handle's infrastructure fields** — set automatically via handle's internal typed observe schema
- **Caller's `initial`** — raw seed data stamped when the scope opens
- **Caller's `run` body** — anything written via the caller's own `observe.fields(...)` handles

At the end of the bracket, the whole scope data is captured and appended to the journal as a single entry. This is the "one event per unit of work" pattern in concrete form.

---

## API

```ts
function createHandler(options: {
  clock: Clock;
  journal: Journal<CanonicalLog>;
  defaultTimeoutMs?: Millis;
  idGenerator?: () => string; // defaults to clock-based per-factory counter
}): Handler;

type Handler = <T>(params: {
  name: string;
  initial?: Readonly<Record<string, unknown>>; // seed data for the scope
  timeoutMs?: Millis; // per-call override
  run: (tools: {
    clock: Clock;
    signal: AbortSignal; // aborts on timeout
  }) => Promise<T> | T;
}) => Promise<{
  result: Result<T, HandleError>;
  log: CanonicalLog;
}>;

type HandleError =
  | { type: "TIMEOUT"; timeoutMs: number; name: string }
  | { type: "HANDLER_ERROR"; name: string; cause: unknown };
```

### Options

- **`idGenerator`** — override the default request-ID generator. Useful for deterministic tests (e.g., `let i = 0; () => \`req-${i++}\``). The default is per-factory (two factories have independent sequences) and derives from the injected clock.
- **`defaultTimeoutMs`** — applied when a call doesn't specify `timeoutMs`. Omit for no default timeout.

---

## What handle does NOT do

- **No concurrency bracket.** One invocation, one scope, one journal entry. If you need a bounded queue, concurrency limit, retry, or circuit breaker, compose `handle` inside a broader primitive. (The re-imagined work-unit Handler will do exactly this.)
- **No transport coupling.** Handle doesn't know about HTTP, queues, or cron. Adapters translate transport events into `handle({...})` calls.
- **No automatic retries.** A handler run is one attempt. Retry logic belongs one layer up.
- **No schema enforcement on `initial`.** It's raw seed data. If you want a declared shape for domain observations, use `@phyxiusjs/observe`'s typed fields inside `run`.

---

## Composition

Handle is where Clock / Context / Observe / Journal / fp.Result actually compose into "one event per unit of work." Everything it does is available as separate primitives — handle's value is doing the bracket correctly, once, so every downstream request-shaped primitive doesn't reinvent it.

The next layer up (the re-imagined Handler) will wrap `handle` with a concurrency-bracket: bounded queue, active-count semaphore, overflow policy, maybe supervised restart. At that point each queued work unit flows through `handle`, and every work unit emits exactly one fully-contextual journal entry.

---

## What you get

- **A correct bracket.** Scope open, fields stamped, timeout applied, log captured, journal appended — in the right order, with the right primitives, every time.
- **Cancellation that actually works.** AbortSignal on timeout, not a leaky setTimeout.
- **Deterministic testing.** ControlledClock drives everything — timeouts, durations, request IDs.
- **One line in the journal per invocation.** The complete story of what the handler did, ready for downstream drain to any sink.

Handle is the foundation everything request-shaped builds on. Keep it small, keep it right, compose upward.

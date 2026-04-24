# Process

Long-lived stateful actors with mailbox serialization and supervision. For the moments in Node where "just use a class" silently interleaves state, and "just wrap in try/catch" silently crashes the whole runtime.

---

## What this really is

Node is single-threaded, but that doesn't solve concurrency — it moves it to async boundaries. The moment you `await` in the middle of a state mutation, another flow can read or write the same state. A plain JS class with `async` methods has no serialization guarantee; methods interleave freely across awaits.

Process gives you three things that Node's runtime and standard library do not:

1. **Mailbox serialization.** Messages to the same actor are processed **one at a time**, even when they arrive concurrently. The handler for message N completes before the handler for message N+1 starts. Across async boundaries, across concurrent senders. No shared-state interleaving.
2. **Supervision.** "Let it crash" as a design pattern. When a handler throws, the actor transitions to `failed` and the supervisor decides what to do — restart with fresh state, stop, or escalate. One bad message doesn't take the Node process down.
3. **Message-passing discipline.** State is never touched from outside — only through messages. Tests become trivial; state transitions become discrete values you can assert on.

None of those are available from `Promise.all`, `EventEmitter`, `AbortSignal`, or a plain class.

---

## Mailbox is the point

The primitive you can't easily hand-roll:

```ts
// Broken: two callers, one interleaved mutation
class Counter {
  private value = 0;
  async increment() {
    const current = this.value;
    await recordAudit(current); // yields
    this.value = current + 1; // stale if another increment landed
  }
}
```

```ts
// Process: mailbox guarantees serialization
const counter = await spawn(
  {
    name: "counter",
    init: () => ({ value: 0 }),
    handle: async (state, msg) => {
      if (msg.type === "increment") {
        await recordAudit(state.value);
        return { value: state.value + 1 };
      }
      return state;
    },
  },
  { clock },
);

counter.send({ type: "increment" });
counter.send({ type: "increment" });
// Exactly two increments. No interleaving. Ever.
```

Process doesn't make your code faster. It makes it **correct under concurrent access** without locks, CAS, or defensive copies.

---

## Examples

### Example 1 — Plain spawn, no supervision

```ts
import { spawn } from "@phyxiusjs/process";
import { createSystemClock } from "@phyxiusjs/clock";

const clock = createSystemClock();

type Msg = { type: "increment" } | { type: "get"; reply: (n: number) => void };

const counter = await spawn<Msg, { value: number }>(
  {
    name: "counter",
    init: () => ({ value: 0 }),
    handle: (state, msg) => {
      switch (msg.type) {
        case "increment":
          return { value: state.value + 1 };
        case "get":
          msg.reply(state.value);
          return state;
      }
    },
  },
  { clock },
);

counter.send({ type: "increment" });
counter.send({ type: "increment" });

const value = await counter.ask<number>((reply) => ({ type: "get", reply }));
console.log(value); // 2
```

### Example 2 — Passing context into init

```ts
type Msg = { type: "query"; sql: string; reply: (rows: Row[]) => void };

const db = await spawn<Msg, Connection, { url: string }>(
  {
    name: "db",
    init: async (ctx) => connectDb(ctx.url),
    handle: async (conn, msg) => {
      const rows = await conn.query(msg.sql);
      msg.reply(rows);
      return conn; // keep connection as state
    },
    onStop: async (conn) => {
      await conn.close();
    },
  },
  { clock, ctx: { url: "postgres://..." } },
);
```

### Example 3 — Supervision and restart

```ts
import { Supervisor, spawn } from "@phyxiusjs/process";

const supervisor = new Supervisor({
  clock,
  emit: logger.info,
  strategy: {
    type: "one-for-one",
    maxRestarts: { count: 3, within: 10_000 as never },
    backoff: { initial: 1_000 as never, max: 30_000 as never, factor: 2 },
  },
});

const worker = await supervisor.spawn({
  name: "flaky-worker",
  init: () => ({ processed: 0 }),
  handle: (state, msg) => {
    if (Math.random() < 0.1) throw new Error("Random failure");
    return { processed: state.processed + 1 };
  },
});

// If handle throws, the supervisor restarts with fresh state.
// If it crashes 3 times within 10s, the supervisor gives up and emits
// a 'supervisor:giveup' event — you can subscribe and alert.

worker.send({ type: "work" });
```

### Example 4 — Self-scheduled messages (timers that survive pump idling)

```ts
type Msg = { type: "tick" } | { type: "start" };

const heartbeat = await spawn<Msg>(
  {
    name: "heartbeat",
    handle: (_state, msg, tools) => {
      if (msg.type === "start") {
        tools.schedule(1_000 as never, { type: "tick" });
      } else if (msg.type === "tick") {
        console.log("beat", clock.now().wallMs);
        tools.schedule(1_000 as never, { type: "tick" });
      }
    },
  },
  { clock },
);

await heartbeat.send({ type: "start" });
// Ticks continue firing every second even though no external sender is
// driving the mailbox. Each scheduled message has its own Clock-backed timer.
```

### Example 5 — Request/reply with timeout

```ts
type Msg = { type: "slow-op"; reply: (result: string) => void };

const worker = await spawn<Msg>(
  {
    name: "worker",
    handle: async (_state, msg) => {
      const result = await doExpensiveWork();
      msg.reply(result);
    },
  },
  { clock },
);

try {
  const result = await worker.ask<string>((reply) => ({ type: "slow-op", reply }), 5_000 as never);
  console.log(result);
} catch (err) {
  if (err instanceof TimeoutError) {
    // Work exceeded the budget — handle it
  }
}
```

---

## Process does NOT help you with

- **CPU-bound work.** Node is single-threaded; the actor runs on the same event loop. For CPU work, use Worker threads.
- **Cross-process state.** This is in-memory. For distributed state, replicate via an external system.
- **Transport concerns.** Process is protocol-agnostic — it doesn't know about HTTP, WebSockets, Kafka. Adapters live one layer up.
- **UI reactivity.** Framework adapters wrap Process; Process doesn't know about React or Vue.

---

## API at a glance

### Spawning

```ts
spawn<TMsg, TState, TCtx>(
  spec: ProcessSpec<TMsg, TState, TCtx>,
  options: { clock: Clock; ctx?: TCtx; emit?: EmitFn; id?: ProcessId },
): Promise<ProcessRef<TMsg>>;
```

`spawn` is the only entry point. There is no separate `createProcess` — construction, init, and start are one step. Init failures bubble up; if the promise resolves, the returned ref is in state `running`.

### The spec

```ts
interface ProcessSpec<TMsg, TState = void, TCtx = void> {
  readonly name: string;
  init?(ctx: TCtx): TState | Promise<TState>;
  handle(state: TState, msg: TMsg, tools: Tools<TMsg>): TState | void | Promise<TState | void>;
  onStop?(state: TState, reason: StopReason, ctx: TCtx): void | Promise<void>;
  maxInbox?: number; // default 1024
  mailboxPolicy?: "reject" | "drop-oldest"; // default "reject"
}
```

The `handle` signature is fixed. `void`/`undefined` return means "state unchanged." No arity-dispatch magic.

### Tools (inside a handler)

```ts
interface Tools<TMsg> {
  readonly clock: Clock;
  readonly emit?: EmitFn;
  schedule(after: Millis, msg: TMsg): void;
}
```

Deliberately narrow. Nested spawning is **not** here — supervision is flat, and hierarchy is expressed by creating nested `Supervisor` instances explicitly. That keeps the failure and restart surfaces legible instead of implicit.

### The ref (outside the handler)

```ts
interface ProcessRef<TMsg> {
  readonly id: ProcessId;
  status(): ProcessStatus;
  send(msg: TMsg): Promise<boolean>;
  ask<TResp>(build: (reply: (r: TResp) => void) => TMsg, timeout?: Millis): Promise<TResp>;
  stop(reason?: StopReason): Promise<void>;
}
```

`ask` is the single request/response surface. From inside the handler you still use `ask` via a separate ref if you're talking to a sibling; there is no duplicate `tools.ask` helper.

### Supervisor

```ts
class Supervisor {
  constructor(options: { clock: Clock; id?: ProcessId; emit?: EmitFn; strategy?: SupervisionStrategy });
  spawn<TMsg, TState, TCtx>(spec: ProcessSpec<TMsg, TState, TCtx>, ctx?: TCtx): Promise<ProcessRef<TMsg>>;
  supervise<TMsg>(ref: ProcessRef<TMsg>, action: "restart" | "stop" | "escalate"): void;
  getChildren(): ProcessRef<unknown>[];
  getRestartCount(id: ProcessId): number;
  stop(): Promise<void>;
}
```

`restartCount` lives on the Supervisor, not on individual `ProcessRef`s — it's bookkeeping that only the supervisor can honestly track.

---

## Installation

```bash
npm install @phyxiusjs/process @phyxiusjs/clock
```

---

## What you get

- **Mailbox-serialized state.** Concurrent senders, no interleaving. The guarantee Node can't give you with classes and methods.
- **Supervised restarts.** "Let it crash" as a first-class pattern. One bad handler doesn't crash the runtime.
- **Clock-bound lifecycle.** Every timestamp, every scheduled message, every restart delay is driven by the injected Clock. Deterministic in tests.
- **Observable by default.** Every state transition emits a structured event. Pair with Journal for a replayable audit.

Process is a small primitive. It holds long-lived state that changes in a disciplined, supervised, observable way. Bigger things — request handlers, connection pools, rate limiters, session managers — compose on top.

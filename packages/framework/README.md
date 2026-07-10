# Framework

The convenience bow over Phyxius primitives. `createApp()` returns a value that wires Clock, Journal, Drain, Stats, and the Config watcher, then exposes `.route` / `.schedule` / `.consume` / `.use` on top of them. Transports are opt-in peer dependencies — install only what you use. Invariants pass through unchanged.

---

## What this is (and isn't)

**Is:** a packaged composition of primitives you already have. Every framework method is a documented composition — the source reads as "here's how you'd have written it by hand."

**Isn't:** an escape hatch from any invariant. It can't make you skip declaring a timeout. It can't hide a retry policy. It can't make a state change without producing a journal entry. The framework makes composing Phyxius easy; it doesn't make correctness optional.

If you ever need to drop beneath it, every underlying primitive is reachable via `app.clock`, `app.journal`, `app.config`, `app.stats` — and your existing `@phyxiusjs/handler`, `@phyxiusjs/http`, etc. calls work exactly as documented.

---

## The optimization target

Framework-shaped code is optimized for **engineering, not developer convenience**. Your first commit is a touch slower because the declarations are explicit; your thousandth is dramatically faster because nothing is implicit. That's the trade, and it's visible in the lifetime of the code.

---

## Installation

```bash
npm install @phyxiusjs/framework @phyxiusjs/handler @phyxiusjs/clock
```

Plus one or more transport adapters, **only if you use them**:

```bash
npm install @phyxiusjs/http         # if you call app.route(...)
npm install @phyxiusjs/scheduler    # if you call app.schedule(...)
npm install @phyxiusjs/queue        # if you call app.consume(...)
```

Transports are declared as optional peer dependencies. An app that's handlers-only doesn't pay for HTTP, an HTTP-only app doesn't ship the queue consumer's code, and so on. Staff+ engineers who split their API tier from their worker tier can share everything but transport packages.

---

## Quick start

```ts
import { createApp } from "@phyxiusjs/framework";
import { defineHandler, retry, cb } from "@phyxiusjs/handler";
import { observe } from "@phyxiusjs/observe";
import { ms } from "@phyxiusjs/clock";
import { schedule } from "@phyxiusjs/scheduler";
import { z } from "zod";

const app = await createApp({
  config: "./phyxius.json",
});

// Handler specs are exactly as @phyxiusjs/handler documents them.
const orderFields = observe.fields({
  customerId: observe.field<string>(),
  amount: observe.number(),
});

const orderHandler = await app.use(
  defineHandler({
    name: "order.process",
    input: z.object({ customerId: z.string(), amount: z.number().positive() }),
    output: z.object({ chargeId: z.string(), amount: z.number() }),
    fields: orderFields,
    timeout: ms(5_000),
    concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
    retry: retry.exponential({ maxAttempts: 3, initialDelay: ms(200) }),
    circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),
    run: async ({ customerId, amount }) => {
      orderFields.customerId.set(customerId);
      orderFields.amount.set(amount);
      return { chargeId: `ch_${customerId}`, amount };
    },
  }),
);

app.route({
  method: "POST",
  path: "/orders",
  handler: orderHandler,
  decode: (req) => req.body as { customerId: string; amount: number },
});

app.schedule({
  name: "sessions.cleanup",
  schedule: schedule.every(ms(60_000)),
  handler: cleanupHandler,
  input: (tick) => ({ since: new Date(tick.scheduledAt.wallMs - 60_000).toISOString() }),
});

await app.start();
app.installSignalHandlers();
```

That's a supervised, budget-bounded, retry-aware, circuit-broken, drift-tracked, shutdown-coordinated process. The framework wires the Drain + Stats + Config for you. You wire the domain.

---

## The config contract

Framework-reserved keys: `server` and `observability`. Users' app keys sit alongside these unchanged.

```jsonc
// phyxius.json
{
  "server": { "port": 3000 },

  "observability": {
    "log_drain": "stdout", // "stdout" | "none"
    "log_sampling": {
      "ratio_of_successful_requests": 1.0,
      "log_all_failures": true
    },
    "stats": {
      "window_size": 1000,
      "thresholds": {
        "order.process": { "p95_ms": 500, "error_rate": 0.01 },
        "user.lookup": { "p99_ms": 100 }
      }
    }
  },

  // Your app-specific keys start here.
  "features": { "new_pricing": true }
}
```

The framework ships a Zod schema for the `server` / `observability` slice. Intersect it with your own schema via `appSchema`:

```ts
import { z } from "zod";

const myAppSchema = z.object({
  features: z.object({
    new_pricing: z.boolean().default(false),
  }),
});

const app = await createApp({
  config: "./phyxius.json",
  appSchema: myAppSchema,
});

// Fully typed reads:
const cfg = app.config.getAll();
if (cfg._tag === "Ok") {
  console.log(cfg.value.observability.log_drain); // "stdout"
  console.log(cfg.value.features.new_pricing); // boolean
}
```

The config hot-reloads from file. Change `ratio_of_successful_requests` in `phyxius.json` and the next log event's sampling decision picks up the new value — **no deploy, no restart**. Spend becomes a knob.

---

## Sampling, built in

The framework installs a drain filter wired to the config's `observability.log_sampling` slice. Every `HandlerEvent` flows through a deterministic check:

```ts
// Built-in; you don't write this, but it's what happens.
function shouldLog(event: HandlerEvent, config: ObservabilityConfig): boolean {
  if (event.outcome === "failure" && config.log_sampling.log_all_failures) {
    return true;
  }
  return hashToRatio(event.invocationId) < config.log_sampling.ratio_of_successful_requests;
}
```

**Deterministic, not random.** `hashToRatio` is an FNV-1a hash of the `invocationId`, normalized to `[0, 1)`. Every process in your fleet makes the same decision for the same request — you never get a log half-present across nodes. A sampled request is either fully in your logs or fully absent; never fractured.

---

## Stats + alerts, built in

Stats is wired up automatically from the `observability.stats` config slice:

```jsonc
{
  "observability": {
    "stats": {
      "window_size": 1000,
      "thresholds": {
        "order.process": { "p95_ms": 500, "error_rate": 0.01 }
      }
    }
  }
}
```

The framework subscribes `@phyxiusjs/stats` to the shared journal and routes threshold events back into the same journal. So when `order.process`'s p95 crosses 500ms, a `stats:threshold-breached` event lands in your log stream alongside every other event — same sink, same format, same `correlationId` machinery.

Query snapshots at any time:

```ts
app.stats.snapshot("order.process");
// { p50Ms, p95Ms, p99Ms, errorRate, ... }
```

Expose it via a handler if you want:

```ts
const statsHandler = await app.use(
  defineHandler({
    name: "admin.stats",
    input: z.object({}),
    output: z.array(z.any()),
    // ...
    run: async () => app.stats.snapshotAll(),
  }),
);

app.route({ method: "GET", path: "/admin/stats", handler: statsHandler, decode: () => ({}) });
```

---

## Graceful shutdown

`app.stop()` tears down in the reverse order of `start()`:

1. **HTTP stops accepting** new connections (in-flight requests continue).
2. **Scheduler stops** firing new ticks.
3. **Consumers stop** pulling new messages.
4. **Handlers drain** their in-flight work.
5. **Drain flushes** remaining journal entries.
6. **Stats unsubscribes.**
7. **Config watcher disposes.**

`app.installSignalHandlers()` is opt-in — call it from your entry point and SIGTERM/SIGINT invoke `stop()`:

```ts
await app.start();
app.installSignalHandlers();
// Process will exit gracefully on ctrl-c or SIGTERM.
```

Opt-in by design: globally swallowing signals is the kind of "magic" that bites people later. If you don't install, the framework never touches `process.on` — you're free to wire signals however you want.

---

## Reaching under the framework

Every primitive is reachable:

```ts
app.clock; // the Clock (ControlledClock in tests)
app.journal; // the shared Journal<HandlerEvent>
app.config; // the ConfigInstance (with hot-reload)
app.stats; // the Stats tracker
app.status; // "idle" | "starting" | "running" | "stopping" | "stopped"
```

Want to subscribe to every handler event yourself? `app.journal.subscribe(...)`. Want to run a query against live stats? `app.stats.snapshot(name)`. Want the current config snapshot? `app.config.getAll()`. Nothing is hidden; the framework is a convenience layer, not a sealed box.

---

## What this does NOT do

- **No router DSL / middleware / plugins.** Routes are values; composition is just arrays. No `express.Router`, no middleware stack, no plugin registry. The HTTP adapter's shape survives unchanged.
- **No bundled DB driver.** `@phyxiusjs/db` is not a peer — the framework doesn't know about your database. Use `@phyxiusjs/db` with whichever driver you want; call `db.transaction(...)` inside handler bodies.
- **No built-in authentication.** Auth is a handler concern (or a strategy run before `app.use`). Every non-trivial system has its own shape; hardcoding one would be wrong.
- **No service discovery / cluster coordination.** Each `app` instance is one process. Scaling across nodes is a transport and infra concern.
- **No state machine, strategy, or resource opinions.** Those are application-layer primitives composed inside your handlers. The framework has no API for them on purpose — surface stays small.
- **No file-watching for code changes / hot module replacement.** Not our problem.

---

## What you get

- **~20 lines from zero to a supervised, observable, shutdown-clean service.**
- **Every stability decision still required** — the framework can't hide a timeout from you.
- **Deterministic sampling and stats built in**, configurable via YAML, hot-reloadable.
- **Signal-driven graceful shutdown**, opt-in, correctly ordered.
- **Typed config** that covers framework and app slices together.
- **Tree-shakable transports** — install only the adapters you use.

The framework is the last piece. Everything else was the substrate. This is just the bow.

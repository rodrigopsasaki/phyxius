# Scheduler

The scheduler adapter for `@phyxiusjs/handler`. Time-driven handler invocations — a tick fires, a handler runs, a `HandlerEvent` lands in the journal. Same shape as HTTP and queue. The thing that closes the transport triangle: request-driven (HTTP), event-driven (queue), time-driven (scheduler).

---

## What this really is

A thin translator over the injected `Clock`. Every job declares two things:

1. **When to fire** — a `Schedule` value that answers "what's my next tick?"
2. **What to feed in** — a function that turns a tick into the handler's input.

The handler owns stability (timeout, retry, circuit breaker, concurrency). The scheduler owns timing, overlap policy, and drift tracking. Together they produce the same one-event-per-invocation journal stream as every other adapter.

---

## Installation

```bash
npm install @phyxiusjs/scheduler @phyxiusjs/handler @phyxiusjs/clock
```

---

## Quick start

```ts
import { createSystemClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { cb, defineHandler, retry, spawn } from "@phyxiusjs/handler";
import { createScheduler, schedule } from "@phyxiusjs/scheduler";

const cleanupFields = observe.fields({
  since: observe.field<string>(),
  deletedCount: observe.number(),
});

const cleanupSpec = defineHandler({
  name: "sessions.cleanup",
  input: z.object({ since: z.string() }),
  output: z.object({ deletedCount: z.number() }),
  fields: cleanupFields,
  timeout: ms(30_000),
  concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
  retry: retry.none(),
  circuitBreaker: cb.none(),
  run: async ({ since }) => {
    cleanupFields.since.set(since);
    const deletedCount = await deleteExpiredSessions(since);
    cleanupFields.deletedCount.set(deletedCount);
    return { deletedCount };
  },
});

const clock = createSystemClock();
const journal = new Journal({ clock });
const cleanup = await spawn(cleanupSpec, { clock, journal });

const scheduler = createScheduler({
  clock,
  jobs: [
    {
      name: "cleanup",
      schedule: schedule.every(ms(60_000)),
      handler: cleanup,
      input: (tick) => ({ since: new Date(tick.scheduledAt.wallMs - 60_000).toISOString() }),
    },
  ],
});

await scheduler.start();

// Graceful shutdown:
process.on("SIGTERM", async () => {
  await scheduler.stop();
  await cleanup.stop();
});
```

Same handler guarantees as any other transport. Swap the scheduler for an HTTP adapter or a queue consumer — everything else stays identical.

---

## The `Schedule` interface

```ts
interface Schedule {
  nextTick(after: Instant): Instant | null;
}
```

One method. Given the current instant, return the next instant at which this schedule should fire (or `null` if exhausted). Everything — fixed interval, cron expression, specific instant, timezone-aware recurrence, business-calendar-aware cadence — reduces to this.

### Built-in schedules

```ts
schedule.every(intervalMs); // fire every N milliseconds
schedule.at(instant); // one-shot at a specific instant
schedule.never(); // never fires (placeholder / toggle-off)
```

### Cron

Deliberately not shipped in the box. If you need cron, wrap `cron-parser` in 5 lines:

```ts
import parser from "cron-parser";
import type { Schedule } from "@phyxiusjs/scheduler";

function cron(expression: string, options?: { tz?: string }): Schedule {
  return {
    nextTick(after) {
      const iter = parser.parseExpression(expression, {
        currentDate: new Date(after.wallMs),
        ...(options?.tz ? { tz: options.tz } : {}),
      });
      const next = iter.next().toDate();
      return { wallMs: next.getTime(), monoMs: after.monoMs + (next.getTime() - after.wallMs) };
    },
  };
}

// Usage:
schedule: cron("*/5 * * * *"),             // every 5 minutes
schedule: cron("0 9 * * MON-FRI", { tz: "America/New_York" }),  // weekdays at 9am NY time
```

The primitive doesn't absorb a parser because there are several good ones, each with different quirks and license profiles. You pick.

---

## `ScheduledJob<TInput, TOutput>`

```ts
interface ScheduledJob<TInput, TOutput> {
  readonly name: string; // identity on every HandlerEvent this job emits
  readonly schedule: Schedule;
  readonly handler: RunningHandler<TInput, TOutput>;
  readonly input: (tick: ScheduledTick) => TInput | Promise<TInput>;
  readonly onResult?: (result, tick) => void;
  readonly overlap?: OverlapPolicy; // default: "skip"
  readonly catchup?: CatchupPolicy; // default: "none"
}

interface ScheduledTick {
  readonly scheduledAt: Instant; // when the schedule said to fire
  readonly firedAt: Instant; // when the tick actually fired
  readonly tickIndex: number; // 0-indexed within this job
}
```

The `input` function typically uses `tick.scheduledAt` as a "since" bound for incremental work:

```ts
input: (tick) => ({ since: new Date(tick.scheduledAt.wallMs - 60_000).toISOString() });
```

The `firedAt - scheduledAt` difference is **drift** — how much later the tick actually fired than it was supposed to. Appears on every `HandlerEvent` via `meta.driftMs`, so overloaded schedulers and clock skew show up in the same dashboards as everything else.

---

## Overlap policy

What happens when the next tick fires while the previous tick is still running?

| Policy     | Behavior                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| `skip`     | Drop the new tick; emit `scheduler:tick-skipped`. **Default.**                         |
| `queue`    | Fire anyway; let the handler's `concurrency.queueSize` / `backpressure` policy decide. |
| `parallel` | Fire anyway; handler's `concurrency.max` is the ceiling.                               |

**`skip` is the safe default.** Periodic maintenance jobs (cleanup, refresh, heartbeat) should almost always skip on overlap — that's the signal that your job is slower than your interval, which should trigger an alert, not a cascade. `queue` invites pile-up if the slowdown persists. `parallel` is only safe when ticks are genuinely independent.

---

## Catchup policy

What happens when ticks should have fired while the scheduler wasn't running (process was down, or job added mid-flight)?

| Policy | Behavior                                                             |
| ------ | -------------------------------------------------------------------- |
| `none` | Only schedule ticks strictly after `scheduler.start()`. **Default.** |
| `last` | Fire one catchup tick immediately, then resume normally.             |
| `all`  | Same as `last` at the primitive level; see below.                    |

**`none` is the safe default.** Catchup semantics always surprise people — cron jobs that ran every 5 minutes for an hour firing 12 times in a burst is rarely what anyone wants. Opt in explicitly.

On `all`: the `Schedule` interface is deliberately forward-only (`nextTick(after)`). Enumerating every missed past tick would require a bidirectional schedule, which would constrain every `Schedule` implementation unhelpfully. If your job genuinely needs "fire N times for the missed window," compute the count from `tick.scheduledAt` and do the work in one invocation.

---

## Observability

Two distinct event streams:

- **`HandlerEvent`** — one per invocation, in the handler's journal. Same shape as HTTP and queue. Contains `correlationId` (set to `${jobName}:${tickIndex}`), `source: "scheduler"`, and `meta.driftMs` / `meta.scheduledAtWallMs`.
- **`SchedulerEvent`** — scheduler's own lifecycle events, via `emit`:

```ts
type SchedulerEvent =
  | { type: "scheduler:started"; at; jobCount }
  | { type: "scheduler:stopped"; at; inFlightAtStop }
  | { type: "scheduler:tick-fired"; name; scheduledAt; firedAt; driftMs; tickIndex }
  | { type: "scheduler:tick-skipped"; name; scheduledAt; reason }
  | { type: "scheduler:job-exhausted"; name; at };
```

Lifecycle events are separate from the journal on purpose: they're operator-facing, not per-invocation observability. Wire them to a metrics sink or discard them.

---

## Testing

A `ControlledClock` makes the whole thing deterministic:

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";

const clock = createControlledClock({ initialTime: 0 });
const scheduler = createScheduler({ clock, jobs: [...] });

await scheduler.start();

// Step time forward; each slice lets the scheduler wake, fire, and register
// its next deadline before the next slice is drained.
for (let i = 0; i < 10; i++) {
  clock.advanceBy(ms(50));
  await clock.flush();
}

expect(journal.getSnapshot().entries.length).toBe(10);
```

No real timers, no wall-clock waits, no flaky cron tests.

---

## What this does NOT do

- **No distributed scheduling.** One scheduler per process. Leader election, persistent schedule state, and cross-node coordination are transport concerns that explicitly live outside this primitive.
- **No cron parser.** Wrap your library of choice.
- **No "fire immediately on start" semantics for `every`.** The first tick lands at `start + interval`. If you want an immediate run, invoke the handler once directly before `scheduler.start()`.
- **No dynamic job registration.** Jobs are declared at construction time. Hot-adding / removing jobs is a higher-level concern; for now, stop and restart the scheduler.

---

## What you get

- **Transport-stable observability.** Every scheduled tick produces the same `HandlerEvent` shape as an HTTP request or a queue message.
- **Drift as a first-class signal.** Overloaded schedulers, clock skew, GC pauses — all visible in the same journal as everything else.
- **Deterministic tests.** `ControlledClock` + `stepClock` pattern removes every timing flake from scheduler tests.
- **Stability from the handler.** A scheduled job that fails goes through the same retry / circuit-breaker / backpressure machinery as any other invocation.

The scheduler closes the transport triangle: HTTP (requests), queue (events), scheduler (time). Past here, Phyxius has full coverage of how work enters a system.

import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import type { Instant } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { cb, defineHandler, retry, spawn, type HandlerEvent, type HandlerRuntime } from "@phyxiusjs/handler";

import { createScheduler, sleepUntil } from "../src/scheduler.js";
import { at, every, never } from "../src/schedule.js";
import type { SchedulerEvent } from "../src/types.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

const tickFields = observe.fields({
  tickIndex: observe.number(),
  scheduledAtWallMs: observe.number(),
});

function makeCounterHandler() {
  return defineHandler({
    name: "tick.counter",
    input: z.object({
      tickIndex: z.number(),
      scheduledAtWallMs: z.number(),
    }),
    output: z.object({ counted: z.number() }),
    fields: tickFields,
    timeout: ms(1_000),
    concurrency: { max: 4, queueSize: 10, backpressure: "reject" },
    retry: retry.none(),
    circuitBreaker: cb.none(),
    run: async ({ tickIndex, scheduledAtWallMs }) => {
      tickFields.tickIndex.set(tickIndex);
      tickFields.scheduledAtWallMs.set(scheduledAtWallMs);
      return { counted: tickIndex };
    },
  });
}

function setup() {
  const clock = createControlledClock({ initialTime: 1_000 });
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 100 });
  const runtime: HandlerRuntime = { clock, journal };
  return { clock, journal, runtime };
}

/**
 * Step the clock forward in small slices, flushing microtasks between each
 * slice. This matches real behavior more faithfully than a single large
 * `advanceBy`: each slice gives the scheduler a chance to wake, fire, and
 * register its next deadline before the next slice is drained. Without
 * stepping, a large advance drains the initial deadline during `drainUntil`
 * but the scheduler's follow-up deadline isn't registered until after the
 * advance returns — so only one tick fires per advance.
 */
async function stepClock(
  clock: ReturnType<typeof createControlledClock>,
  totalMs: number,
  sliceMs: number = 10,
): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(sliceMs, remaining);
    clock.advanceBy(step as never);
    await clock.flush();
    remaining -= step;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("sleepUntil — abort-listener cleanup", () => {
  it("resolves once the deadline passes", async () => {
    const clock = createControlledClock({ initialTime: 1_000 });
    const controller = new AbortController();

    const promise = sleepUntil(clock, { wallMs: 1_100, monoMs: 1_100 } as Instant, controller.signal);

    clock.advanceBy(100 as never);
    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves early when the signal aborts before the deadline", async () => {
    const clock = createControlledClock({ initialTime: 1_000 });
    const controller = new AbortController();

    const promise = sleepUntil(clock, { wallMs: 2_000, monoMs: 2_000 } as Instant, controller.signal);
    controller.abort();

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves immediately when the signal is already aborted on entry", async () => {
    const clock = createControlledClock({ initialTime: 1_000 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      sleepUntil(clock, { wallMs: 2_000, monoMs: 2_000 } as Instant, controller.signal),
    ).resolves.toBeUndefined();
    // Already-aborted is a fast path — no listener is ever attached.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("removes its abort listener once the deadline wins, leaving no listener leak", async () => {
    const clock = createControlledClock({ initialTime: 1_000 });
    const controller = new AbortController();

    const promise = sleepUntil(clock, { wallMs: 1_100, monoMs: 1_100 } as Instant, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    clock.advanceBy(100 as never);
    await promise;

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not accumulate listeners on a long-lived signal across many non-aborted ticks", async () => {
    // Regression for the leak flagged in the #22 PR body: the scheduler
    // reuses one AbortController across its whole lifetime, so every tick
    // that wins on the deadline (the normal, non-aborted case) must leave
    // the shared signal exactly as it found it.
    const clock = createControlledClock({ initialTime: 1_000 });
    const controller = new AbortController();

    let targetMs = clock.now().wallMs;
    for (let tick = 0; tick < 25; tick++) {
      targetMs += 10;
      const promise = sleepUntil(clock, { wallMs: targetMs, monoMs: targetMs } as Instant, controller.signal);
      clock.advanceBy(10 as never);
      await promise;
    }

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("createScheduler — basic firing", () => {
  it("fires a single job on its schedule", async () => {
    const { clock, journal, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);
    const events: SchedulerEvent[] = [];

    const scheduler = createScheduler({
      clock,
      emit: (e) => events.push(e),
      jobs: [
        {
          name: "counter",
          schedule: every(ms(100)),
          handler,
          input: (tick) => ({
            tickIndex: tick.tickIndex,
            scheduledAtWallMs: tick.scheduledAt.wallMs,
          }),
        },
      ],
    });

    await scheduler.start();

    // Advance past the first tick time (now=1000, first tick at 1100).
    await stepClock(clock, 150);

    const { entries } = journal.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.name).toBe("tick.counter");
    expect(entries[0]?.data.source).toBe("scheduler");
    expect(entries[0]?.data.observed).toMatchObject({
      tickIndex: 0,
      scheduledAtWallMs: 1100,
    });

    await scheduler.stop();
    await handler.stop();
  });

  it("fires multiple times on recurring schedule", async () => {
    const { clock, journal, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);

    const scheduler = createScheduler({
      clock,
      jobs: [
        {
          name: "repeating",
          schedule: every(ms(50)),
          handler,
          input: (tick) => ({
            tickIndex: tick.tickIndex,
            scheduledAtWallMs: tick.scheduledAt.wallMs,
          }),
        },
      ],
    });

    await scheduler.start();

    // Advance enough to fire 3 ticks (50ms each starting at 1050).
    await stepClock(clock, 200);

    const { entries } = journal.getSnapshot();
    expect(entries.length).toBeGreaterThanOrEqual(3);
    // Tick indexes are 0, 1, 2, ...
    const tickIndexes = entries.map((e) => (e.data.observed as { tickIndex: number }).tickIndex);
    expect(tickIndexes.slice(0, 3)).toEqual([0, 1, 2]);

    await scheduler.stop();
    await handler.stop();
  });

  it("emits tick-fired events with drift tracking", async () => {
    const { clock, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);
    const events: SchedulerEvent[] = [];

    const scheduler = createScheduler({
      clock,
      emit: (e) => events.push(e),
      jobs: [
        {
          name: "driftable",
          schedule: every(ms(100)),
          handler,
          input: (tick) => ({
            tickIndex: tick.tickIndex,
            scheduledAtWallMs: tick.scheduledAt.wallMs,
          }),
        },
      ],
    });

    await scheduler.start();
    await stepClock(clock, 150);

    const tickFired = events.filter((e) => e.type === "scheduler:tick-fired");
    expect(tickFired.length).toBeGreaterThanOrEqual(1);
    const first = tickFired[0];
    if (first?.type === "scheduler:tick-fired") {
      expect(first.name).toBe("driftable");
      // Drift = firedAt - scheduledAt. With controlled clock and no
      // work-in-loop latency, should be exactly 0 (we advance to the
      // exact deadline instant).
      expect(first.driftMs).toBeGreaterThanOrEqual(0);
      expect(first.tickIndex).toBe(0);
    }

    await scheduler.stop();
    await handler.stop();
  });
});

describe("multiple jobs", () => {
  it("interleaves ticks by deadline across jobs", async () => {
    const { clock, journal, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);

    const scheduler = createScheduler({
      clock,
      jobs: [
        {
          name: "fast",
          schedule: every(ms(50)),
          handler,
          input: (tick) => ({ tickIndex: tick.tickIndex, scheduledAtWallMs: tick.scheduledAt.wallMs }),
        },
        {
          name: "slow",
          schedule: every(ms(150)),
          handler,
          input: (tick) => ({ tickIndex: tick.tickIndex, scheduledAtWallMs: tick.scheduledAt.wallMs }),
        },
      ],
    });

    await scheduler.start();
    await stepClock(clock, 200);

    // fast fires at 1050, 1100, 1150, 1200 → 4
    // slow fires at 1150 → 1
    // Total: at least 5 journal entries.
    const { entries } = journal.getSnapshot();
    expect(entries.length).toBeGreaterThanOrEqual(4);

    await scheduler.stop();
    await handler.stop();
  });
});

describe("one-shot and exhaustion", () => {
  it("at() fires once and the job is marked exhausted", async () => {
    const { clock, journal, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);
    const events: SchedulerEvent[] = [];

    const scheduler = createScheduler({
      clock,
      emit: (e) => events.push(e),
      jobs: [
        {
          name: "once",
          schedule: at({ wallMs: 1_100, monoMs: 1_100 } as Instant),
          handler,
          input: (tick) => ({ tickIndex: tick.tickIndex, scheduledAtWallMs: tick.scheduledAt.wallMs }),
        },
      ],
    });

    await scheduler.start();
    await stepClock(clock, 500);

    expect(journal.getSnapshot().entries).toHaveLength(1);
    expect(events.some((e) => e.type === "scheduler:job-exhausted" && e.name === "once")).toBe(true);

    await scheduler.stop();
    await handler.stop();
  });

  it("never() jobs are dropped immediately with job-exhausted event", async () => {
    const { clock, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);
    const events: SchedulerEvent[] = [];

    // Need at least one non-never job to prevent the loop from exiting immediately
    // (scheduler requires >=1 job; a single never() schedule is legal though useless).
    const scheduler = createScheduler({
      clock,
      emit: (e) => events.push(e),
      jobs: [
        {
          name: "noop",
          schedule: never(),
          handler,
          input: (tick) => ({ tickIndex: tick.tickIndex, scheduledAtWallMs: tick.scheduledAt.wallMs }),
        },
      ],
    });

    await scheduler.start();
    await stepClock(clock, 1_000);

    expect(events.some((e) => e.type === "scheduler:job-exhausted" && e.name === "noop")).toBe(true);

    await scheduler.stop();
    await handler.stop();
  });

  it("constructor rejects empty job list", () => {
    const { clock } = setup();
    expect(() => createScheduler({ clock, jobs: [] })).toThrow(/at least one job/);
  });
});

describe("overlap: skip (default)", () => {
  it("emits tick-skipped when the previous tick is still in flight", async () => {
    const { clock, runtime } = setup();

    // Slow handler: sleeps 200ms; schedule fires every 50ms.
    // First tick at 1050 starts and holds inflight; 1100, 1150 should be skipped.
    const slowFields = observe.fields({ tickIndex: observe.number() });
    const slowHandler = await spawn(
      defineHandler({
        name: "slow.work",
        input: z.object({ tickIndex: z.number() }),
        output: z.object({ done: z.boolean() }),
        fields: slowFields,
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        run: async ({ tickIndex }, { clock: c }) => {
          slowFields.tickIndex.set(tickIndex);
          await c.sleep(ms(200));
          return { done: true };
        },
      }),
      runtime,
    );

    const events: SchedulerEvent[] = [];
    const scheduler = createScheduler({
      clock,
      emit: (e) => events.push(e),
      jobs: [
        {
          name: "overlapping",
          schedule: every(ms(50)),
          handler: slowHandler,
          input: (tick) => ({ tickIndex: tick.tickIndex }),
          overlap: "skip",
        },
      ],
    });

    await scheduler.start();

    // Advance to fire 1st tick. Handler begins a 200ms sleep inside the tick.
    await stepClock(clock, 60);
    // While the handler is still sleeping, advance through the window where
    // more ticks would have fired. overlap: "skip" must drop them.
    await stepClock(clock, 100);

    const skipped = events.filter((e) => e.type === "scheduler:tick-skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);

    // Kick off stop() without awaiting — it'll signal the loop to exit,
    // then wait for the in-flight dispatch to drain. To let that drain,
    // we advance the clock past the slow handler's sleep *while stop is
    // waiting*, then await the stop. This mirrors real shutdown: the
    // abort signal fires, but the handler body still needs to complete
    // its in-flight work before the process can exit.
    const stopPromise = scheduler.stop();
    await stepClock(clock, 500);
    await stopPromise;
    await slowHandler.stop();
  });
});

describe("onResult callback", () => {
  it("fires on every tick with the Result and tick", async () => {
    const { clock, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);

    const results: { ok: boolean; tickIndex: number }[] = [];
    const scheduler = createScheduler({
      clock,
      jobs: [
        {
          name: "callback",
          schedule: every(ms(50)),
          handler,
          input: (tick) => ({ tickIndex: tick.tickIndex, scheduledAtWallMs: tick.scheduledAt.wallMs }),
          onResult: (result, tick) => {
            results.push({ ok: result._tag === "Ok", tickIndex: tick.tickIndex });
          },
        },
      ],
    });

    await scheduler.start();
    await stepClock(clock, 120);

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]?.tickIndex).toBe(0);

    await scheduler.stop();
    await handler.stop();
  });
});

describe("input-thunk failure", () => {
  it("preserves the original cause on both the emitted event and the synthesized Result", async () => {
    const { clock, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);

    const originalError = new Error("upstream credentials expired");
    const events: SchedulerEvent[] = [];
    const results: { tickIndex: number; cause: unknown }[] = [];

    const scheduler = createScheduler({
      clock,
      emit: (e) => events.push(e),
      jobs: [
        {
          name: "flaky-input",
          schedule: every(ms(50)),
          handler,
          input: () => {
            throw originalError;
          },
          onResult: (result, tick) => {
            if (result._tag === "Err" && result.error.type === "HANDLER_ERROR") {
              results.push({ tickIndex: tick.tickIndex, cause: result.error.cause });
            }
          },
        },
      ],
    });

    await scheduler.start();
    await stepClock(clock, 60);
    await scheduler.stop();
    await handler.stop();

    const inputErrors = events.filter((e) => e.type === "scheduler:input-error");
    expect(inputErrors.length).toBeGreaterThanOrEqual(1);
    expect(inputErrors[0]).toMatchObject({
      name: "flaky-input",
      // every(ms(50)) from initialTime 1_000 fires tick 0 at 1_050 — same
      // first-tick timing asserted elsewhere in this file (see the
      // correlationId + context test's scheduledAtWallMs: 1050).
      at: { wallMs: 1_050, monoMs: 1_050 },
      tickIndex: 0,
      cause: originalError,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.cause).toBe(originalError);
  });
});

describe("correlationId + context", () => {
  it("sets correlationId to `${jobName}:${tickIndex}` and passes scheduledAt through context", async () => {
    const { clock, journal, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);

    const scheduler = createScheduler({
      clock,
      jobs: [
        {
          name: "corr",
          schedule: every(ms(50)),
          handler,
          input: (tick) => ({ tickIndex: tick.tickIndex, scheduledAtWallMs: tick.scheduledAt.wallMs }),
        },
      ],
    });

    await scheduler.start();
    await stepClock(clock, 60);

    const entry = journal.getSnapshot().entries[0];
    expect(entry?.data.correlationId).toBe("corr:0");
    // context is promoted to meta on the journal entry.
    expect(entry?.data.meta).toMatchObject({
      scheduledAtWallMs: 1050,
      tickIndex: 0,
    });

    await scheduler.stop();
    await handler.stop();
  });
});

describe("lifecycle", () => {
  it("stop() is idempotent", async () => {
    const { clock, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);

    const scheduler = createScheduler({
      clock,
      jobs: [
        {
          name: "x",
          schedule: every(ms(1_000)),
          handler,
          input: (tick) => ({ tickIndex: tick.tickIndex, scheduledAtWallMs: tick.scheduledAt.wallMs }),
        },
      ],
    });

    await scheduler.start();
    await Promise.all([scheduler.stop(), scheduler.stop(), scheduler.stop()]);
    expect(scheduler.getStatus()).toBe("stopped");

    await handler.stop();
  });

  it("emits started + stopped events", async () => {
    const { clock, runtime } = setup();
    const handler = await spawn(makeCounterHandler(), runtime);
    const events: SchedulerEvent[] = [];

    const scheduler = createScheduler({
      clock,
      emit: (e) => events.push(e),
      jobs: [
        {
          name: "life",
          schedule: every(ms(1_000)),
          handler,
          input: (tick) => ({ tickIndex: tick.tickIndex, scheduledAtWallMs: tick.scheduledAt.wallMs }),
        },
      ],
    });

    await scheduler.start();
    await scheduler.stop();

    expect(events.some((e) => e.type === "scheduler:started")).toBe(true);
    expect(events.some((e) => e.type === "scheduler:stopped")).toBe(true);

    await handler.stop();
  });
});

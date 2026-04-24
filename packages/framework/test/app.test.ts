import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { cb, defineHandler, retry, type HandlerEvent } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { createMemorySource } from "@phyxiusjs/queue";
import { every, schedule } from "@phyxiusjs/scheduler";

import { createApp } from "../src/app.js";

// ── Test fixtures ─────────────────────────────────────────────────────────

const noopFields = observe.fields({
  value: observe.number(),
});

const noopSpec = defineHandler({
  name: "noop",
  input: z.object({ value: z.number() }),
  output: z.object({ echoed: z.number() }),
  fields: noopFields,
  timeout: ms(1_000),
  concurrency: { max: 4, queueSize: 10, backpressure: "reject" },
  retry: retry.none(),
  circuitBreaker: cb.none(),
  run: async ({ value }) => {
    noopFields.value.set(value);
    return { echoed: value };
  },
});

// ── createApp — basic lifecycle ───────────────────────────────────────────

describe("createApp — basic lifecycle", () => {
  it("creates an app with default config when none supplied", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const app = await createApp({ clock });

    expect(app.status).toBe("idle");
    await app.start();
    expect(app.status).toBe("running");
    await app.stop();
    expect(app.status).toBe("stopped");
  });

  it("accepts an inline config object", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const app = await createApp({
      clock,
      config: {
        observability: {
          log_drain: "none",
          log_sampling: { ratio_of_successful_requests: 0.5, log_all_failures: true },
          stats: { window_size: 500, thresholds: {} },
        },
      },
    });

    const cfg = app.config.getAll();
    expect(cfg._tag).toBe("Ok");
    if (cfg._tag === "Ok") {
      expect(cfg.value.observability.log_drain).toBe("none");
      expect(cfg.value.observability.stats.window_size).toBe(500);
    }

    await app.stop();
  });

  it("start() then stop() succeeds without any registrations", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const app = await createApp({ clock });

    await app.start();
    await app.stop();
    // status reflects terminal state
    expect(app.status).toBe("stopped");
  });

  it("stop() is idempotent", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const app = await createApp({ clock });
    await app.start();
    await Promise.all([app.stop(), app.stop(), app.stop()]);
    expect(app.status).toBe("stopped");
  });
});

// ── app.use — handler registration ────────────────────────────────────────

describe("createApp — use()", () => {
  it("spawns a handler and returns a RunningHandler", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const app = await createApp({ clock });

    const handler = await app.use(noopSpec);
    expect(handler.name).toBe("noop");

    // Handler actually works
    const result = await handler.invoke({ value: 42 });
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") expect(result.value.echoed).toBe(42);

    await app.stop();
  });

  it("handler invocations produce events in the shared journal", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const journal = new Journal<HandlerEvent>({ clock });
    const app = await createApp({ clock, journal });

    const handler = await app.use(noopSpec);
    await handler.invoke({ value: 1 });
    await handler.invoke({ value: 2 });

    const {entries} = journal.getSnapshot();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.data.name).toBe("noop");

    await app.stop();
  });

  it("stops all registered handlers on app.stop()", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const app = await createApp({ clock });

    const h1 = await app.use(noopSpec);
    const h2 = await app.use({ ...noopSpec, name: "noop-2" });

    await app.start();
    await app.stop();

    expect(h1.getStatus()).toBe("stopped");
    expect(h2.getStatus()).toBe("stopped");
  });
});

// ── app.schedule ──────────────────────────────────────────────────────────

describe("createApp — schedule()", () => {
  it("fires scheduled jobs after start", async () => {
    const clock = createControlledClock({ initialTime: 1_000 });
    const journal = new Journal<HandlerEvent>({ clock });
    const app = await createApp({ clock, journal });

    const handler = await app.use(noopSpec);
    app.schedule({
      name: "every-100ms",
      schedule: every(ms(100)),
      handler,
      input: (tick) => ({ value: tick.tickIndex }),
    });

    await app.start();

    // Step the clock forward in slices so the scheduler can register each
    // follow-up deadline before the next drain.
    for (let i = 0; i < 30; i++) {
      clock.advanceBy(ms(10));
      await clock.flush();
    }

    const scheduledEvents = journal.getSnapshot().entries.filter((e) => e.data.source === "scheduler");
    expect(scheduledEvents.length).toBeGreaterThanOrEqual(2);

    await app.stop();
  });

  it("rejects schedule() after start", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const app = await createApp({ clock });
    const handler = await app.use(noopSpec);

    await app.start();
    expect(() =>
      app.schedule({
        name: "too-late",
        schedule: schedule.never(),
        handler,
        input: () => ({ value: 0 }),
      }),
    ).toThrow(/before app.start/);

    await app.stop();
  });
});

// ── app.consume ──────────────────────────────────────────────────────────

describe("createApp — consume()", () => {
  it("dispatches queue messages to the handler", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const journal = new Journal<HandlerEvent>({ clock });
    const app = await createApp({ clock, journal });

    const handler = await app.use(noopSpec);
    const source = createMemorySource({ clock });

    app.consume({
      source,
      handler,
      decode: (msg) => msg.body as { value: number },
    });

    await app.start();
    source.enqueue({ body: { value: 7 } });

    // Poll until the ack lands.
    await waitUntil(() => source.getAckHistory().length === 1);

    const queueEvents = journal.getSnapshot().entries.filter((e) => e.data.source === "queue");
    expect(queueEvents).toHaveLength(1);

    await app.stop();
  });
});

// ── Typed app config extension ────────────────────────────────────────────

describe("createApp — typed config extension", () => {
  it("accepts an extended schema and exposes typed reads", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const appSchema = z.object({
      features: z.object({
        feature_a: z.boolean().default(false),
      }),
    });

    const app = await createApp({
      clock,
      appSchema,
      config: {
        features: { feature_a: true },
      } as never,
    });

    const snap = app.config.getAll();
    expect(snap._tag).toBe("Ok");
    if (snap._tag === "Ok") {
      // Framework slice still present
      expect(snap.value.observability.log_drain).toBe("stdout");
      // User slice present and typed
      expect((snap.value as { features: { feature_a: boolean } }).features.feature_a).toBe(true);
    }

    await app.stop();
  });
});

// ── Signal handlers ──────────────────────────────────────────────────────

describe("createApp — installSignalHandlers()", () => {
  it("registers SIGTERM and SIGINT listeners", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const app = await createApp({ clock });

    const before = {
      sigterm: process.listenerCount("SIGTERM"),
      sigint: process.listenerCount("SIGINT"),
    };

    app.installSignalHandlers();

    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);

    await app.stop();

    // Listeners are removed after stop.
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

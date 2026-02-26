import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { createRuntime } from "@phyxiusjs/runtime";
import { defineFunction, ServiceError, NO_RETRY, NO_CIRCUIT_BREAKER } from "@phyxiusjs/service";
import { ok, err, isOk, isErr } from "@phyxiusjs/fp";
import { z } from "zod";
import { createHandler, defineHandler, HandlerError, type HandlerJournalEvent } from "../src/index.js";

// ── Shared test infrastructure ───────────────────────────────────────────────

function makeEchoFunction() {
  return defineFunction({
    name: "test.echo",
    layer: "data",
    input: z.object({ message: z.string() }),
    output: z.object({ echo: z.string() }),
    policy: {
      timeout: 5_000 as import("@phyxiusjs/clock").Millis,
      retry: NO_RETRY,
      circuitBreaker: NO_CIRCUIT_BREAKER,
    },
    handler: async (_ctx, input) => ok({ echo: input.message }),
  });
}

function makeFailingFunction() {
  return defineFunction({
    name: "test.fail",
    layer: "data",
    input: z.object({ message: z.string() }),
    output: z.object({ result: z.string() }),
    policy: {
      timeout: 5_000 as import("@phyxiusjs/clock").Millis,
      retry: NO_RETRY,
      circuitBreaker: NO_CIRCUIT_BREAKER,
    },
    handler: async (_ctx, _input) => err(ServiceError.internal("Intentional test failure")),
  });
}

function makeSlowFunction(delayMs: number) {
  return defineFunction({
    name: "test.slow",
    layer: "data",
    input: z.object({ value: z.number() }),
    output: z.object({ value: z.number() }),
    policy: {
      timeout: 10_000 as import("@phyxiusjs/clock").Millis,
      retry: NO_RETRY,
      circuitBreaker: NO_CIRCUIT_BREAKER,
    },
    handler: async (_ctx, input) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return ok({ value: input.value });
    },
  });
}

describe("Handler", () => {
  let clock: ReturnType<typeof createSystemClock>;
  let journal: Journal<HandlerJournalEvent>;
  let runtime: ReturnType<typeof createRuntime>;

  beforeEach(() => {
    clock = createSystemClock();
    journal = new Journal({ clock });
    runtime = createRuntime({ clock });
  });

  // ── defineHandler ──────────────────────────────────────────────────────────

  describe("defineHandler", () => {
    it("returns the definition unchanged (pure configuration)", () => {
      const fn = makeEchoFunction();
      const definition = defineHandler({
        name: "echo-handler",
        fn,
        concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
      });

      expect(definition.name).toBe("echo-handler");
      expect(definition.fn).toBe(fn);
      expect(definition.concurrency.max).toBe(5);
      expect(definition.concurrency.backpressure).toBe("reject");
      expect(definition.concurrency.queueSize).toBe(10);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts in idle state", () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          fn: makeEchoFunction(),
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal, runtime },
      );

      expect(handler.getState()).toBe("idle");
    });

    it("transitions idle → running after start()", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          fn: makeEchoFunction(),
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      expect(handler.getState()).toBe("running");

      await handler.stop();
    });

    it("transitions running → stopped after stop()", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          fn: makeEchoFunction(),
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();
      await handler.stop();

      expect(handler.getState()).toBe("stopped");
    });

    it("throws HANDLER_ALREADY_RUNNING when started twice", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          fn: makeEchoFunction(),
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      await expect(handler.start()).rejects.toBeInstanceOf(HandlerError);

      await handler.stop();
    });

    it("stop() is a no-op when handler is not running", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          fn: makeEchoFunction(),
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal, runtime },
      );

      await expect(handler.stop()).resolves.toBeUndefined();
    });
  });

  // ── submit() basic execution ───────────────────────────────────────────────

  describe("submit() — basic execution", () => {
    it("executes the ServiceFunction and returns Ok on success", async () => {
      const handler = createHandler(
        defineHandler({
          name: "echo",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const result = await handler.submit({ message: "hello" });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value.echo).toBe("hello");
      }

      await handler.stop();
    });

    it("returns Err wrapping the ServiceError on failure", async () => {
      const handler = createHandler(
        defineHandler({
          name: "failing",
          fn: makeFailingFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const result = await handler.submit({ message: "will fail" });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(HandlerError);
        expect(result.error.code).toBe("EXECUTION_FAILED");
      }

      await handler.stop();
    });

    it("returns HANDLER_NOT_RUNNING when submitted before start()", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      const result = await handler.submit({ message: "too early" });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("HANDLER_NOT_RUNNING");
      }
    });

    it("propagates correlationId from WorkMeta to the Journal event", async () => {
      const handler = createHandler(
        defineHandler({
          name: "traced",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      await handler.submit(
        { message: "trace me" },
        {
          source: "test",
          correlationId: "my-trace-id-123",
        },
      );

      const snapshot = journal.getSnapshot();
      expect(snapshot.totalCount).toBeGreaterThan(0);
      const lastEntry = snapshot.entries[snapshot.entries.length - 1];
      expect(lastEntry).toBeDefined();
      if (lastEntry) {
        expect(lastEntry.data.correlationId).toBe("my-trace-id-123");
        expect(lastEntry.data.source).toBe("test");
      }

      await handler.stop();
    });
  });

  // ── submit() blocks when concurrency max is reached ─────────────────────

  describe("submit() — concurrency", () => {
    it("queues work when concurrency max is reached, executes when slot opens", async () => {
      const fn = makeSlowFunction(50);
      const handler = createHandler(
        defineHandler({
          name: "limited",
          fn,
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      // Submit two items concurrently — max=1 so second must queue
      const [r1, r2] = await Promise.all([handler.submit({ value: 1 }), handler.submit({ value: 2 })]);

      expect(isOk(r1)).toBe(true);
      expect(isOk(r2)).toBe(true);

      await handler.stop();
    });

    it("getMetrics() shows activeCount and queuedCount", async () => {
      const fn = makeSlowFunction(200);
      const handler = createHandler(
        defineHandler({
          name: "measured",
          fn,
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      // Start two submissions but don't await — check metrics in between
      const p1 = handler.submit({ value: 1 });
      const p2 = handler.submit({ value: 2 });

      // Give them a tick to be picked up
      await new Promise((r) => setTimeout(r, 10));

      const metrics = handler.getMetrics();
      expect(metrics.activeCount).toBeGreaterThanOrEqual(1);
      expect(metrics.state).toBe("running");

      await Promise.all([p1, p2]);
      await handler.stop();
    });
  });

  // ── Backpressure ─────────────────────────────────────────────────────────

  describe("submit() — backpressure: reject", () => {
    it("returns BACKPRESSURE_REJECT when queue is full with 'reject' policy", async () => {
      const fn = makeSlowFunction(500); // very slow so queue fills up
      const handler = createHandler(
        defineHandler({
          name: "capped",
          fn,
          concurrency: { max: 1, backpressure: "reject", queueSize: 1 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      // Submit 3: first executes (uses the 1 slot), second queues (queueSize=1), third is rejected
      const p1 = handler.submit({ value: 1 });
      await new Promise((r) => setTimeout(r, 5)); // let p1 start executing
      const p2 = handler.submit({ value: 2 }); // should queue
      const p3 = handler.submit({ value: 3 }); // queue full — should reject

      const r3 = await p3;
      expect(isErr(r3)).toBe(true);
      if (isErr(r3)) {
        expect(r3.error.code).toBe("BACKPRESSURE_REJECT");
      }

      // Cleanup
      await Promise.all([p1, p2]);
      await handler.stop();
    });
  });

  describe("submit() — backpressure: drop-oldest", () => {
    it("evicts the oldest queued item and enqueues the new one when queue is full", async () => {
      const fn = makeSlowFunction(500);
      const handler = createHandler(
        defineHandler({
          name: "drop-oldest",
          fn,
          concurrency: { max: 1, backpressure: "drop-oldest", queueSize: 1 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const p1 = handler.submit({ value: 1 }); // starts executing
      await new Promise((r) => setTimeout(r, 5));
      const p2 = handler.submit({ value: 2 }); // queued
      const p3 = handler.submit({ value: 3 }); // drops p2, queues p3

      // p2 should be dropped (BACKPRESSURE_REJECT)
      const r2 = await p2;
      expect(isErr(r2)).toBe(true);
      if (isErr(r2)) {
        expect(r2.error.code).toBe("BACKPRESSURE_REJECT");
      }

      // p3 should eventually execute (it replaced p2)
      await Promise.all([p1, p3]);
      await handler.stop();
    });
  });

  // ── Journal events ────────────────────────────────────────────────────────

  describe("Journal events", () => {
    it("appends one Journal event per completed work unit", async () => {
      const handler = createHandler(
        defineHandler({
          name: "journaled",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      await handler.submit({ message: "one" });
      await handler.submit({ message: "two" });
      await handler.submit({ message: "three" });

      await handler.stop();

      const snapshot = journal.getSnapshot();
      expect(snapshot.totalCount).toBe(3);
    });

    it("Journal event has correct fields for successful execution", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test.echo",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      await handler.submit(
        { message: "inspect me" },
        {
          source: "http",
          correlationId: "trace-abc",
        },
      );

      await handler.stop();

      const snapshot = journal.getSnapshot();
      const event = snapshot.entries[0]?.data;
      expect(event).toBeDefined();
      if (!event) return;

      expect(event.functionName).toBe("test.echo");
      expect(event.source).toBe("http");
      expect(event.correlationId).toBe("trace-abc");
      expect(event.outcome).toBe("success");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.error).toBeUndefined();
    });

    it("Journal event has correct fields for failed execution", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test.fail",
          fn: makeFailingFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      await handler.submit({ message: "fail please" });

      await handler.stop();

      const snapshot = journal.getSnapshot();
      const event = snapshot.entries[0]?.data;
      expect(event).toBeDefined();
      if (!event) return;

      expect(event.outcome).toBe("failure");
      expect(event.error).toBeDefined();
      expect(event.error?.code).toBeDefined();
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  describe("stop() — graceful shutdown", () => {
    it("drains active work before stopping", async () => {
      const fn = makeSlowFunction(100);
      const handler = createHandler(
        defineHandler({
          name: "graceful",
          fn,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      // Kick off work but don't await it
      const work = handler.submit({ value: 42 });

      // Stop while work is in-flight
      await handler.stop();

      // Work should have completed
      const result = await work;
      expect(isOk(result)).toBe(true);

      // State is stopped
      expect(handler.getState()).toBe("stopped");
    });

    it("rejects queued (not yet started) work when stopping", async () => {
      const fn = makeSlowFunction(500);
      const handler = createHandler(
        defineHandler({
          name: "clear-queue",
          fn,
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const p1 = handler.submit({ value: 1 }); // starts executing
      await new Promise((r) => setTimeout(r, 5));
      const p2 = handler.submit({ value: 2 }); // queued

      // Stop — should drain p1, reject p2
      await handler.stop();

      const r2 = await p2;
      expect(isErr(r2)).toBe(true);
      if (isErr(r2)) {
        expect(r2.error.code).toBe("HANDLER_NOT_RUNNING");
      }

      // p1 should have completed
      const r1 = await p1;
      expect(isOk(r1)).toBe(true);
    });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  describe("getMetrics()", () => {
    it("updates totalProcessed, totalSucceeded, totalFailed after each execution", async () => {
      const handler = createHandler(
        defineHandler({
          name: "counted",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      await handler.submit({ message: "one" });
      await handler.submit({ message: "two" });

      const m = handler.getMetrics();
      expect(m.totalProcessed).toBe(2);
      expect(m.totalSucceeded).toBe(2);
      expect(m.totalFailed).toBe(0);

      await handler.stop();
    });

    it("counts failures separately", async () => {
      const handler = createHandler(
        defineHandler({
          name: "failures",
          fn: makeFailingFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      await handler.submit({ message: "fail" });
      await handler.submit({ message: "fail again" });

      const m = handler.getMetrics();
      expect(m.totalProcessed).toBe(2);
      expect(m.totalSucceeded).toBe(0);
      expect(m.totalFailed).toBe(2);

      await handler.stop();
    });
  });
});

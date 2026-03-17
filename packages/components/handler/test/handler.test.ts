import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import type { Millis } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { isOk, isErr } from "@phyxiusjs/fp";
import {
  createHandler,
  defineHandler,
  HandlerError,
  type HandlerEvent,
} from "../src/index.js";

// ── Shared test infrastructure ───────────────────────────────────────────────

function echoProcessor(input: { message: string }): Promise<{ echo: string }> {
  return Promise.resolve({ echo: input.message });
}

function failingProcessor(_input: { message: string }): Promise<{ result: string }> {
  return Promise.reject(new Error("Intentional test failure"));
}

function slowProcessor(delayMs: number) {
  return async (input: { value: number }): Promise<{ value: number }> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { value: input.value };
  };
}

describe("Handler", () => {
  let clock: ReturnType<typeof createSystemClock>;
  let journal: Journal<HandlerEvent>;

  beforeEach(() => {
    clock = createSystemClock();
    journal = new Journal({ clock });
  });

  // ── defineHandler ──────────────────────────────────────────────────────────

  describe("defineHandler", () => {
    it("returns the definition unchanged (pure configuration)", () => {
      const definition = defineHandler({
        name: "echo-handler",
        processor: echoProcessor,
        concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
      });

      expect(definition.name).toBe("echo-handler");
      expect(definition.processor).toBe(echoProcessor);
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
          processor: echoProcessor,
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal },
      );

      expect(handler.getState()).toBe("idle");
    });

    it("transitions idle → running after start()", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          processor: echoProcessor,
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal },
      );

      await handler.start();

      expect(handler.getState()).toBe("running");

      await handler.stop();
    });

    it("transitions running → stopped after stop()", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          processor: echoProcessor,
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal },
      );

      await handler.start();
      await handler.stop();

      expect(handler.getState()).toBe("stopped");
    });

    it("throws HANDLER_ALREADY_RUNNING when started twice", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          processor: echoProcessor,
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal },
      );

      await handler.start();

      await expect(handler.start()).rejects.toBeInstanceOf(HandlerError);

      await handler.stop();
    });

    it("stop() is a no-op when handler is not running", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test",
          processor: echoProcessor,
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal },
      );

      await expect(handler.stop()).resolves.toBeUndefined();
    });
  });

  // ── submit() basic execution ─────────────────────────────────────────────

  describe("submit() — basic execution", () => {
    it("executes the processor and returns Ok on success", async () => {
      const handler = createHandler(
        defineHandler({
          name: "echo",
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
      );

      await handler.start();

      const result = await handler.submit({ message: "hello" });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value.echo).toBe("hello");
      }

      await handler.stop();
    });

    it("returns Err wrapping the error on failure", async () => {
      const handler = createHandler(
        defineHandler({
          name: "failing",
          processor: failingProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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

  // ── submit() concurrency ───────────────────────────────────────────────────

  describe("submit() — concurrency", () => {
    it("queues work when concurrency max is reached, executes when slot opens", async () => {
      const handler = createHandler(
        defineHandler({
          name: "limited",
          processor: slowProcessor(50),
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal },
      );

      await handler.start();

      const [r1, r2] = await Promise.all([
        handler.submit({ value: 1 }),
        handler.submit({ value: 2 }),
      ]);

      expect(isOk(r1)).toBe(true);
      expect(isOk(r2)).toBe(true);

      await handler.stop();
    });

    it("getMetrics() shows activeCount and queuedCount", async () => {
      const handler = createHandler(
        defineHandler({
          name: "measured",
          processor: slowProcessor(200),
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal },
      );

      await handler.start();

      const p1 = handler.submit({ value: 1 });
      const p2 = handler.submit({ value: 2 });

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
      const handler = createHandler(
        defineHandler({
          name: "capped",
          processor: slowProcessor(500),
          concurrency: { max: 1, backpressure: "reject", queueSize: 1 },
        }),
        { clock, journal },
      );

      await handler.start();

      const p1 = handler.submit({ value: 1 });
      await new Promise((r) => setTimeout(r, 5));
      const p2 = handler.submit({ value: 2 });
      const p3 = handler.submit({ value: 3 });

      const r3 = await p3;
      expect(isErr(r3)).toBe(true);
      if (isErr(r3)) {
        expect(r3.error.code).toBe("BACKPRESSURE_REJECT");
      }

      await Promise.all([p1, p2]);
      await handler.stop();
    });
  });

  describe("submit() — backpressure: drop-oldest", () => {
    it("evicts the oldest queued item and enqueues the new one when queue is full", async () => {
      const handler = createHandler(
        defineHandler({
          name: "drop-oldest",
          processor: slowProcessor(500),
          concurrency: { max: 1, backpressure: "drop-oldest", queueSize: 1 },
        }),
        { clock, journal },
      );

      await handler.start();

      const p1 = handler.submit({ value: 1 });
      await new Promise((r) => setTimeout(r, 5));
      const p2 = handler.submit({ value: 2 });
      const p3 = handler.submit({ value: 3 });

      const r2 = await p2;
      expect(isErr(r2)).toBe(true);
      if (isErr(r2)) {
        expect(r2.error.code).toBe("BACKPRESSURE_REJECT");
      }

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
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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

      expect(event.handlerName).toBe("test.echo");
      expect(event.source).toBe("http");
      expect(event.correlationId).toBe("trace-abc");
      expect(event.outcome).toBe("success");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.attempts).toBe(1);
      expect(event.error).toBeUndefined();
    });

    it("Journal event has correct fields for failed execution", async () => {
      const handler = createHandler(
        defineHandler({
          name: "test.fail",
          processor: failingProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
      expect(event.error?.message).toBe("Intentional test failure");
    });

    it("Journal event captures observed data from Context+Observe", async () => {
      const processorWithObserve = async (input: { userId: string }): Promise<{ ok: true }> => {
        const { observe } = await import("@phyxiusjs/observe");
        observe.set("userId", input.userId);
        observe.set("action", "profile.lookup");
        observe.inc("lookupCount");
        return { ok: true };
      };

      const handler = createHandler(
        defineHandler({
          name: "observe-test",
          processor: processorWithObserve,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal: journal as unknown as Journal<HandlerEvent> },
      );

      await handler.start();

      await handler.submit({ userId: "user-42" });

      await handler.stop();

      const snapshot = journal.getSnapshot();
      const event = snapshot.entries[0]?.data;
      expect(event).toBeDefined();
      if (!event) return;

      // Handler-seeded observe data
      expect(event.observed["handler"]).toBe("observe-test");
      expect(event.observed["executionId"]).toBeDefined();
      expect(event.observed["source"]).toBe("unknown");

      // Processor-set observe data — THE MISSING PIECE
      expect(event.observed["userId"]).toBe("user-42");
      expect(event.observed["action"]).toBe("profile.lookup");
      expect(event.observed["lookupCount"]).toBe(1);
    });
  });

  // ── Graceful shutdown ───────────────────────────────────────────────────────

  describe("stop() — graceful shutdown", () => {
    it("drains active work before stopping", async () => {
      const handler = createHandler(
        defineHandler({
          name: "graceful",
          processor: slowProcessor(100),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
      );

      await handler.start();

      const work = handler.submit({ value: 42 });

      await handler.stop();

      const result = await work;
      expect(isOk(result)).toBe(true);

      expect(handler.getState()).toBe("stopped");
    });

    it("rejects queued (not yet started) work when stopping", async () => {
      const handler = createHandler(
        defineHandler({
          name: "clear-queue",
          processor: slowProcessor(500),
          concurrency: { max: 1, backpressure: "reject", queueSize: 5 },
        }),
        { clock, journal },
      );

      await handler.start();

      const p1 = handler.submit({ value: 1 });
      await new Promise((r) => setTimeout(r, 5));
      const p2 = handler.submit({ value: 2 });

      await handler.stop();

      const r2 = await p2;
      expect(isErr(r2)).toBe(true);
      if (isErr(r2)) {
        expect(r2.error.code).toBe("HANDLER_NOT_RUNNING");
      }

      const r1 = await p1;
      expect(isOk(r1)).toBe(true);
    });
  });

  // ── Metrics ─────────────────────────────────────────────────────────────────

  describe("getMetrics()", () => {
    it("updates totalProcessed, totalSucceeded, totalFailed after each execution", async () => {
      const handler = createHandler(
        defineHandler({
          name: "counted",
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
          processor: failingProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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

  // ── Timeout ─────────────────────────────────────────────────────────────────

  describe("timeout", () => {
    it("fails with EXECUTION_TIMEOUT when processor exceeds timeout", async () => {
      const handler = createHandler(
        defineHandler({
          name: "timeout-test",
          processor: slowProcessor(500),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
          timeout: 50 as Millis,
        }),
        { clock, journal },
      );

      await handler.start();

      const result = await handler.submit({ value: 1 });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("EXECUTION_FAILED");
        expect(result.error.message).toContain("timed out");
      }

      await handler.stop();
    });

    it("succeeds when processor completes within timeout", async () => {
      const handler = createHandler(
        defineHandler({
          name: "fast-enough",
          processor: slowProcessor(10),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
          timeout: 1000 as Millis,
        }),
        { clock, journal },
      );

      await handler.start();

      const result = await handler.submit({ value: 42 });

      expect(isOk(result)).toBe(true);

      await handler.stop();
    });
  });

  // ── Retry ───────────────────────────────────────────────────────────────────

  describe("retry", () => {
    it("retries the processor on failure up to maxAttempts", async () => {
      let callCount = 0;
      const failTwiceThenSucceed = async (input: { value: number }): Promise<{ value: number }> => {
        callCount++;
        if (callCount < 3) {
          throw new Error(`Attempt ${callCount} failed`);
        }
        return { value: input.value };
      };

      const handler = createHandler(
        defineHandler({
          name: "retry-test",
          processor: failTwiceThenSucceed,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
          retry: {
            maxAttempts: 3,
            backoff: "fixed",
            initialDelay: 10 as Millis,
          },
        }),
        { clock, journal },
      );

      await handler.start();

      const result = await handler.submit({ value: 99 });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value.value).toBe(99);
      }
      expect(callCount).toBe(3);

      // Journal should show 3 attempts
      const snapshot = journal.getSnapshot();
      const event = snapshot.entries[0]?.data;
      expect(event?.attempts).toBe(3);

      await handler.stop();
    });

    it("fails after exhausting all retry attempts", async () => {
      const alwaysFail = async (_input: { value: number }): Promise<{ value: number }> => {
        throw new Error("Always fails");
      };

      const handler = createHandler(
        defineHandler({
          name: "exhausted-retries",
          processor: alwaysFail,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
          retry: {
            maxAttempts: 2,
            backoff: "fixed",
            initialDelay: 10 as Millis,
          },
        }),
        { clock, journal },
      );

      await handler.start();

      const result = await handler.submit({ value: 1 });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("EXECUTION_FAILED");
      }

      await handler.stop();
    });
  });

  // ── Circuit Breaker ─────────────────────────────────────────────────────────

  describe("circuit breaker", () => {
    it("opens the circuit after reaching failure threshold", async () => {
      const alwaysFail = async (_input: { value: number }): Promise<{ value: number }> => {
        throw new Error("Boom");
      };

      const handler = createHandler(
        defineHandler({
          name: "cb-test",
          processor: alwaysFail,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
          circuitBreaker: {
            failureThreshold: 2,
            resetTimeout: 60_000 as Millis,
          },
        }),
        { clock, journal },
      );

      await handler.start();

      // First two failures trip the circuit
      await handler.submit({ value: 1 });
      await handler.submit({ value: 2 });

      // Third call should be rejected by the circuit breaker
      const result = await handler.submit({ value: 3 });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("CIRCUIT_OPEN");
      }

      await handler.stop();
    });

    it("resets the circuit after a successful execution", async () => {
      let callCount = 0;
      const failOnceThenSucceed = async (input: { value: number }): Promise<{ value: number }> => {
        callCount++;
        if (callCount === 1) {
          throw new Error("First call fails");
        }
        return { value: input.value };
      };

      const handler = createHandler(
        defineHandler({
          name: "cb-reset-test",
          processor: failOnceThenSucceed,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
          circuitBreaker: {
            failureThreshold: 3,
            resetTimeout: 60_000 as Millis,
          },
        }),
        { clock, journal },
      );

      await handler.start();

      // First call fails (1 consecutive failure)
      await handler.submit({ value: 1 });

      // Second call succeeds — should reset consecutive failures to 0
      const result = await handler.submit({ value: 2 });

      expect(isOk(result)).toBe(true);

      await handler.stop();
    });
  });
});

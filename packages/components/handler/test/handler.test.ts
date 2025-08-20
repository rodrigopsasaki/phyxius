import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import {
  createHandler,
  DEFAULT_HANDLER_CONFIG,
  HandlerError,
  type Adapter,
  type WorkUnit,
  type HandlerEvent,
} from "../src/index.js";
import { EffectUtils } from "../src/utils.js";

describe("Handler", () => {
  let clock: ReturnType<typeof createSystemClock>;
  let events: HandlerEvent[];

  beforeEach(() => {
    clock = createSystemClock();
    events = [];
  });

  describe("Handler Creation and Lifecycle", () => {
    it("should create a handler with correct initial state", () => {
      const handler = createHandler({
        name: "test-handler",
        processor: (input: string) => EffectUtils.succeed(input.toUpperCase()),
        config: DEFAULT_HANDLER_CONFIG,
        clock,
        emit: (event) => events.push(event),
      });

      expect(handler.id).toBeDefined();
      expect(handler.name).toBe("test-handler");
      expect(handler.state).toBe("stopped");
    });

    it("should provide initial metrics", () => {
      const handler = createHandler({
        name: "test-handler",
        processor: (input: string) => EffectUtils.succeed(input.toUpperCase()),
        config: DEFAULT_HANDLER_CONFIG,
        clock,
      });

      const metrics = handler.getMetrics();
      expect(metrics.state).toBe("stopped");
      expect(metrics.activeCount).toBe(0);
      expect(metrics.queueSize).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.errorCount).toBe(0);
    });

    it("should throw error for process ref when not started", () => {
      const handler = createHandler({
        name: "test-handler",
        processor: (input: string) => EffectUtils.succeed(input.toUpperCase()),
        config: DEFAULT_HANDLER_CONFIG,
        clock,
      });

      expect(() => handler.getProcessRef()).toThrow(HandlerError);
    });
  });

  describe("Handler Start and Stop", () => {
    it("should start and stop handler successfully", async () => {
      const adapter = createMockAdapter();
      const handler = createHandler({
        name: "test-handler",
        processor: (input: string) => EffectUtils.succeed(input.toUpperCase()),
        config: DEFAULT_HANDLER_CONFIG,
        clock,
        emit: (event) => events.push(event),
      });

      // Start handler
      const startResult = await handler.start(adapter).unsafeRunPromise();
      expect(startResult._tag).toBe("Ok");
      expect(handler.state).toBe("running");

      // Check events
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("handler:started");
      expect(events[0].handlerId).toBe(handler.id);

      // Stop handler
      const stopResult = await handler.stop().unsafeRunPromise();
      expect(stopResult._tag).toBe("Ok");
      expect(handler.state).toBe("stopped");

      // Check stop event
      const stopEvents = events.filter((e) => e.type === "handler:stopped");
      expect(stopEvents).toHaveLength(1);
    });

    it("should fail to start if already running", async () => {
      const adapter = createMockAdapter();
      const handler = createHandler({
        name: "test-handler",
        processor: (input: string) => EffectUtils.succeed(input.toUpperCase()),
        config: DEFAULT_HANDLER_CONFIG,
        clock,
      });

      // Start handler
      await handler.start(adapter).unsafeRunPromise();

      // Try to start again
      const secondStartResult = await handler.start(adapter).unsafeRunPromise();
      expect(secondStartResult._tag).toBe("Err");
      expect(secondStartResult.error.code).toBe("HANDLER_ALREADY_RUNNING");
    });

    it("should fail to stop if not running", async () => {
      const handler = createHandler({
        name: "test-handler",
        processor: (input: string) => EffectUtils.succeed(input.toUpperCase()),
        config: DEFAULT_HANDLER_CONFIG,
        clock,
      });

      const stopResult = await handler.stop().unsafeRunPromise();
      expect(stopResult._tag).toBe("Err");
      expect(stopResult.error.code).toBe("HANDLER_NOT_RUNNING");
    });
  });

  describe("Error Handling", () => {
    it("should handle adapter health check failure", async () => {
      const unhealthyAdapter = createMockAdapter(false);
      const handler = createHandler({
        name: "test-handler",
        processor: (input: string) => EffectUtils.succeed(input.toUpperCase()),
        config: DEFAULT_HANDLER_CONFIG,
        clock,
      });

      const startResult = await handler.start(unhealthyAdapter).unsafeRunPromise();
      expect(startResult._tag).toBe("Err");
      expect(startResult.error.code).toBe("ADAPTER_ERROR");
      expect(handler.state).toBe("failed");
    });
  });
});

/**
 * Create a mock adapter for testing.
 */
function createMockAdapter(healthy = true): Adapter<string, string> {
  const workUnits: WorkUnit<string>[] = [];

  return {
    name: "mock-adapter",

    async *receive() {
      // Simple implementation that yields no work units for now
      yield* workUnits;
    },

    respond: (correlationId: string, result) => {
      // Mock response - just log for testing
      console.log(`Mock adapter responding to ${correlationId}:`, result);
      return EffectUtils.succeed(undefined);
    },

    close: () => {
      return EffectUtils.succeed(undefined);
    },

    isHealthy: () => healthy,
  };
}

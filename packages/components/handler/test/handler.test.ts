import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import { succeed } from "@phyxiusjs/effect";
import { Journal } from "@phyxiusjs/journal";
import {
  createHandler,
  DEFAULT_HANDLER_CONFIG,
  type Adapter,
  type WorkUnit,
  type HandlerEvent,
  type ProcessorPipeline,
} from "../src/index.js";

describe("Handler", () => {
  let clock: ReturnType<typeof createSystemClock>;
  let events: HandlerEvent[];
  let journal: Journal<HandlerEvent>;

  beforeEach(() => {
    clock = createSystemClock();
    events = [];
    journal = new Journal({
      clock,
      maxEntries: 1000,
      overflow: "bounded:drop_oldest",
    });
  });

  describe("Handler Creation and Lifecycle", () => {
    it("should create a handler with correct initial state", () => {
      const processor: ProcessorPipeline<string, string> = {
        process: (input: string) => succeed(input.toUpperCase()),
      };

      const handler = createHandler({
        name: "test-handler",
        processor,
        config: DEFAULT_HANDLER_CONFIG,
        clock,
        journal,
        emit: (event) => events.push(event),
      });

      expect(handler.id).toBeDefined();
      expect(handler.name).toBe("test-handler");
      expect(handler.state).toBe("initializing");
    });

    it("should provide initial metrics", () => {
      const processor: ProcessorPipeline<string, string> = {
        process: (input: string) => succeed(input.toUpperCase()),
      };

      const handler = createHandler({
        name: "test-handler",
        processor,
        config: DEFAULT_HANDLER_CONFIG,
        clock,
        journal,
      });

      const metrics = handler.getMetrics();
      expect(metrics.state).toBe("initializing");
      expect(metrics.activeCount).toBe(0);
      expect(metrics.queueSize).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.errorCount).toBe(0);
    });

    it("should provide process ref", () => {
      const processor: ProcessorPipeline<string, string> = {
        process: (input: string) => succeed(input.toUpperCase()),
      };

      const handler = createHandler({
        name: "test-handler",
        processor,
        config: DEFAULT_HANDLER_CONFIG,
        clock,
        journal,
      });

      const processRef = handler.getProcessRef();
      expect(processRef).toBeDefined();
      expect(processRef.id).toBeDefined();
    });
  });

  describe("Handler Start and Stop", () => {
    it("should start and stop handler successfully", async () => {
      const adapter = createMockAdapter();
      const processor: ProcessorPipeline<string, string> = {
        process: (input: string) => succeed(input.toUpperCase()),
      };

      const handler = createHandler({
        name: "test-handler",
        processor,
        config: DEFAULT_HANDLER_CONFIG,
        clock,
        journal,
        emit: (event) => events.push(event),
      });

      // Start handler
      const startResult = await handler.start(adapter).unsafeRunPromise();
      expect(startResult._tag).toBe("Ok");
      expect(handler.state).toBe("running");

      // Stop handler
      const stopResult = await handler.stop().unsafeRunPromise();
      expect(stopResult._tag).toBe("Ok");
      expect(handler.state).toBe("stopped");

      // Check events
      const startEvents = events.filter((e) => e.type === "handler:started");
      expect(startEvents).toHaveLength(1);

      const stopEvents = events.filter((e) => e.type === "handler:stopped");
      expect(stopEvents).toHaveLength(1);
    });

    it("should fail to start if already running", async () => {
      const adapter = createMockAdapter();
      const processor: ProcessorPipeline<string, string> = {
        process: (input: string) => succeed(input.toUpperCase()),
      };

      const handler = createHandler({
        name: "test-handler",
        processor,
        config: DEFAULT_HANDLER_CONFIG,
        clock,
        journal,
      });

      // Start handler first time
      const firstStartResult = await handler.start(adapter).unsafeRunPromise();
      expect(firstStartResult._tag).toBe("Ok");

      // Try to start again
      const secondStartResult = await handler.start(adapter).unsafeRunPromise();
      expect(secondStartResult._tag).toBe("Err");
      expect(secondStartResult.error.code).toBe("HANDLER_ALREADY_RUNNING");
    });
  });

  describe("Error Handling", () => {
    it("should handle adapter health check failure", async () => {
      const unhealthyAdapter = createMockAdapter(false);
      const processor: ProcessorPipeline<string, string> = {
        process: (input: string) => succeed(input.toUpperCase()),
      };

      const handler = createHandler({
        name: "test-handler",
        processor,
        config: DEFAULT_HANDLER_CONFIG,
        clock,
        journal,
      });

      // Try to start with unhealthy adapter
      const startResult = await handler.start(unhealthyAdapter).unsafeRunPromise();
      expect(startResult._tag).toBe("Err");
      expect(startResult.error.code).toBe("ADAPTER_ERROR");
      expect(handler.state).toBe("initializing"); // Should remain in initial state
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
      console.warn(`Mock adapter responding to ${correlationId}:`, result);
      return succeed(undefined);
    },

    close: () => {
      return succeed(undefined);
    },

    isHealthy: () => healthy,
  };
}

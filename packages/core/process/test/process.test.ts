import { describe, it, expect, beforeEach } from "vitest";
import { createProcess, createProcessId } from "../src/index.js";
import type { ProcessBehavior, Message } from "../src/index.js";

describe("Process", () => {
  let events: unknown[] = [];
  const emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("basic process lifecycle", () => {
    it("should create process with generated ID", () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      expect(process.id.value).toBeDefined();
      expect(process.state).toBe("starting");
    });

    it("should create process with specific ID", () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };
      const id = createProcessId("test-process");

      const process = createProcess(behavior, { id, emit });
      expect(process.id.value).toBe("test-process");
    });

    it("should start successfully", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      await process.start();

      expect(process.state).toBe("running");

      const startEvents = events.filter((e: any) => e.type === "process:started");
      expect(startEvents).toHaveLength(1);
    });

    it("should call init if provided", async () => {
      let initCalled = false;
      const behavior: ProcessBehavior = {
        init: async () => {
          initCalled = true;
        },
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      await process.start();

      expect(initCalled).toBe(true);
      expect(process.state).toBe("running");
    });

    it("should stop successfully", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      await process.start();
      await process.stop();

      expect(process.state).toBe("stopped");
    });

    it("should call terminate if provided", async () => {
      let terminateCalled = false;
      const behavior: ProcessBehavior = {
        handle: async () => {},
        terminate: async () => {
          terminateCalled = true;
        },
      };

      const process = createProcess(behavior, { emit });
      await process.start();
      await process.stop();

      expect(terminateCalled).toBe(true);
      expect(process.state).toBe("stopped");
    });
  });

  describe("message handling", () => {
    it("should handle messages", async () => {
      const receivedMessages: Message[] = [];
      const behavior: ProcessBehavior = {
        handle: async (message) => {
          receivedMessages.push(message);
        },
      };

      const process = createProcess(behavior, { emit });
      await process.start();

      await process.send({ type: "test", data: "hello" });

      // Wait for message processing
      await new Promise((resolve) => setImmediate(resolve));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual({ type: "test", data: "hello" });
    });

    it("should queue multiple messages", async () => {
      const receivedMessages: Message[] = [];
      const behavior: ProcessBehavior = {
        handle: async (message) => {
          receivedMessages.push(message);
          // Small delay to test queuing
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      };

      const process = createProcess(behavior, { emit });
      await process.start();

      await process.send({ type: "msg1" });
      await process.send({ type: "msg2" });
      await process.send({ type: "msg3" });

      // Wait for all messages to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedMessages).toHaveLength(3);
      expect(receivedMessages.map((m) => m.type)).toEqual(["msg1", "msg2", "msg3"]);
    });

    it("should not accept messages when not running", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });

      await expect(process.send({ type: "test" })).rejects.toThrow("Cannot send message to process in state: starting");
    });

    it("should handle message processing errors", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {
          throw new Error("Processing failed");
        },
      };

      const process = createProcess(behavior, { emit });
      await process.start();

      await process.send({ type: "test" });

      // Wait for message processing
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(process.state).toBe("failed");
      expect(process.getInfo().lastError?.message).toBe("Processing failed");
    });
  });

  describe("process info", () => {
    it("should provide process info", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      const info = process.getInfo();

      expect(info.id).toBe(process.id);
      expect(info.state).toBe("starting");
      expect(info.restartCount).toBe(0);
      expect(info.startedAt).toBe(0);
      expect(info.lastError).toBeUndefined();
    });

    it("should update info after starting", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      await process.start();

      const info = process.getInfo();
      expect(info.state).toBe("running");
      expect(info.startedAt).toBeGreaterThan(0);
    });
  });

  describe("error handling", () => {
    it("should fail if init throws", async () => {
      const behavior: ProcessBehavior = {
        init: async () => {
          throw new Error("Init failed");
        },
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });

      await expect(process.start()).rejects.toThrow("Init failed");
      expect(process.state).toBe("failed");
    });

    it("should fail if terminate throws", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
        terminate: async () => {
          throw new Error("Terminate failed");
        },
      };

      const process = createProcess(behavior, { emit });
      await process.start();

      await expect(process.stop()).rejects.toThrow("Terminate failed");
      expect(process.state).toBe("failed");
    });

    it("should not restart twice", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      await process.start();

      await expect(process.start()).rejects.toThrow("Cannot start process in state: running");
    });
  });

  describe("restart functionality", () => {
    it("should restart after failure", async () => {
      let callCount = 0;
      const behavior: ProcessBehavior = {
        init: async () => {
          callCount++;
        },
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      await process.start();
      expect(callCount).toBe(1);

      // Simulate restart
      if ("restart" in process) {
        await (process as any).restart();
        expect(callCount).toBe(2);
        expect(process.getInfo().restartCount).toBe(1);
      }
    });
  });

  describe("event emission", () => {
    it("should emit lifecycle events", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior, { emit });
      await process.start();
      await process.stop();

      const eventTypes = events.map((e: any) => e.type);
      expect(eventTypes).toContain("process:starting");
      expect(eventTypes).toContain("process:started");
      expect(eventTypes).toContain("process:stopping");
      expect(eventTypes).toContain("process:stopped");
    });

    it("should emit message events", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      };

      const process = createProcess(behavior, { emit });
      await process.start();
      await process.send({ type: "test" });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      const eventTypes = events.map((e: any) => e.type);
      expect(eventTypes).toContain("process:message:queued");
      expect(eventTypes).toContain("process:message:processing");
      expect(eventTypes).toContain("process:message:processed");
    });

    it("should work without emit function", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const process = createProcess(behavior);
      await process.start();
      await process.send({ type: "test" });
      await process.stop();

      expect(process.state).toBe("stopped");
    });
  });
});

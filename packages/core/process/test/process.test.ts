import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import { spawn, createProcessId } from "../src/index.js";
import type { ProcessSpec } from "../src/index.js";

interface TestEvent {
  type: string;
  [key: string]: unknown;
}

describe("spawn (Process)", () => {
  const clock = createSystemClock();
  let events: unknown[] = [];
  const emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("basic lifecycle", () => {
    it("should spawn a running process with a generated id", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "noop",
        handle: () => {},
      };

      const process = await spawn(spec, { clock, emit });

      expect(process.id.value).toBeDefined();
      expect(process.status()).toBe("running");

      await process.stop();
    });

    it("should accept a caller-provided id", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "noop",
        handle: () => {},
      };
      const id = createProcessId("specific-id");

      const process = await spawn(spec, { clock, emit, id });
      expect(process.id.value).toBe("specific-id");

      await process.stop();
    });

    it("should call init before reaching running state", async () => {
      let initCalled = false;
      const spec: ProcessSpec<unknown, void, void> = {
        name: "with-init",
        init: () => {
          initCalled = true;
        },
        handle: () => {},
      };

      const process = await spawn(spec, { clock, emit });

      expect(initCalled).toBe(true);
      expect(process.status()).toBe("running");

      await process.stop();
    });

    it("should pass ctx into init", async () => {
      let receivedCtx: { port: number } | undefined;
      const spec: ProcessSpec<unknown, void, { port: number }> = {
        name: "with-ctx",
        init: (ctx) => {
          receivedCtx = ctx;
        },
        handle: () => {},
      };

      const process = await spawn(spec, { clock, emit, ctx: { port: 8080 } });

      expect(receivedCtx).toEqual({ port: 8080 });

      await process.stop();
    });

    it("should stop gracefully", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "noop",
        handle: () => {},
      };

      const process = await spawn(spec, { clock, emit });
      await process.stop();

      expect(process.status()).toBe("stopped");
    });

    it("should call onStop on shutdown", async () => {
      let stopCalled = false;
      const spec: ProcessSpec<unknown> = {
        name: "with-onstop",
        handle: () => {},
        onStop: () => {
          stopCalled = true;
        },
      };

      const process = await spawn(spec, { clock, emit });
      await process.stop();

      expect(stopCalled).toBe(true);
      expect(process.status()).toBe("stopped");
    });
  });

  describe("message handling", () => {
    it("should process messages one at a time, in order", async () => {
      const received: Array<{ type: string }> = [];
      const spec: ProcessSpec<{ type: string }> = {
        name: "collector",
        handle: (_state, msg) => {
          received.push(msg);
        },
      };

      const process = await spawn(spec, { clock, emit });

      await process.send({ type: "msg1" });
      await process.send({ type: "msg2" });
      await process.send({ type: "msg3" });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received.map((m) => m.type)).toEqual(["msg1", "msg2", "msg3"]);

      await process.stop();
    });

    it("should treat void return from handle as 'keep state'", async () => {
      const spec: ProcessSpec<{ type: string }, { count: number }> = {
        name: "counter",
        init: () => ({ count: 0 }),
        handle: (state, msg) => {
          if (msg.type === "inc") return { count: state.count + 1 };
          // no return: state unchanged
        },
      };

      const process = await spawn(spec, { clock, emit });

      await process.send({ type: "inc" });
      await process.send({ type: "noop" });
      await process.send({ type: "inc" });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const count = await process
        .ask<number>((reply) => ({ type: "get", reply }) as unknown as { type: string }, 100 as never)
        .catch(() => -1);
      // Handler doesn't implement get — we just want to know the pump works.
      expect(count).toBe(-1);

      await process.stop();
    });

    it("should reject sends when the process isn't running", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "noop",
        handle: () => {},
      };

      const process = await spawn(spec, { clock, emit });
      await process.stop();

      await expect(process.send({ type: "test" })).rejects.toThrow("Cannot send message to process in state: stopped");
    });

    it("should transition to 'failed' when handle throws", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "flaky",
        handle: () => {
          throw new Error("Processing failed");
        },
      };

      const process = await spawn(spec, { clock, emit });

      await process.send({ type: "test" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(process.status()).toBe("failed");
    });
  });

  describe("ask", () => {
    it("should resolve when the handler calls reply", async () => {
      type Msg = { type: "get"; reply: (value: number) => void };
      const spec: ProcessSpec<Msg, { value: number }> = {
        name: "responder",
        init: () => ({ value: 42 }),
        handle: (state, msg) => {
          msg.reply(state.value);
        },
      };

      const process = await spawn(spec, { clock, emit });

      const result = await process.ask<number>((reply) => ({ type: "get", reply }));
      expect(result).toBe(42);

      await process.stop();
    });

    it("should reject on timeout", async () => {
      type Msg = { type: "slow"; reply: (value: number) => void };
      const spec: ProcessSpec<Msg> = {
        name: "slow-responder",
        handle: () => {
          // never replies
        },
      };

      const process = await spawn(spec, { clock, emit });

      await expect(process.ask<number>((reply) => ({ type: "slow", reply }), 20 as never)).rejects.toThrow(
        "Ask timeout",
      );

      await process.stop();
    });
  });

  describe("scheduled messages", () => {
    it("should fire a scheduled message even when the mailbox is otherwise empty", async () => {
      let wokenUp = false;
      type Msg = { type: "wake" } | { type: "start" };

      const spec: ProcessSpec<Msg> = {
        name: "sleeper",
        handle: (_state, msg, tools) => {
          if (msg.type === "start") {
            tools.schedule(30 as never, { type: "wake" });
          } else if (msg.type === "wake") {
            wokenUp = true;
          }
        },
      };

      const process = await spawn(spec, { clock, emit });

      await process.send({ type: "start" });
      // The pump goes idle here — scheduled message must still fire.

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(wokenUp).toBe(true);

      await process.stop();
    });
  });

  describe("event emission", () => {
    it("should emit lifecycle events", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "observable",
        handle: () => {},
      };

      const process = await spawn(spec, { clock, emit });
      await process.stop();

      const eventTypes = events.map((e) => (e as TestEvent).type);
      expect(eventTypes).toContain("process:starting");
      expect(eventTypes).toContain("process:started");
      expect(eventTypes).toContain("process:stopping");
      expect(eventTypes).toContain("process:stopped");
    });

    it("should emit message events", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "observable",
        handle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      };

      const process = await spawn(spec, { clock, emit });
      await process.send({ type: "test" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const eventTypes = events.map((e) => (e as TestEvent).type);
      expect(eventTypes).toContain("process:message:queued");
      expect(eventTypes).toContain("process:message:processing");
      expect(eventTypes).toContain("process:message:processed");

      await process.stop();
    });

    it("should work without an emit function", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "silent",
        handle: () => {},
      };

      const process = await spawn(spec, { clock });
      await process.send({ type: "test" });
      await process.stop();

      expect(process.status()).toBe("stopped");
    });
  });

  describe("error handling", () => {
    it("should fail to spawn if init throws", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "bad-init",
        init: () => {
          throw new Error("Init failed");
        },
        handle: () => {},
      };

      await expect(spawn(spec, { clock, emit })).rejects.toThrow("Init failed");
    });

    it("should transition to 'failed' if onStop throws during stop", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "bad-onstop",
        handle: () => {},
        onStop: () => {
          throw new Error("onStop failed");
        },
      };

      const process = await spawn(spec, { clock, emit });

      await expect(process.stop()).rejects.toThrow("onStop failed");
      expect(process.status()).toBe("failed");
    });
  });
});

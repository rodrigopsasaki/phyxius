import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import { Supervisor, createProcessId } from "../src/index.js";
import type { ProcessSpec } from "../src/index.js";

interface TestEvent {
  type: string;
  [key: string]: unknown;
}

describe("Supervisor", () => {
  const clock = createSystemClock();
  let events: unknown[] = [];
  const emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("lifecycle", () => {
    it("should create a supervisor with a generated id", () => {
      const supervisor = new Supervisor({ clock, emit });
      expect(supervisor.id.value).toBeDefined();
      expect(supervisor.getChildren()).toHaveLength(0);
    });

    it("should accept a caller-provided id", () => {
      const id = createProcessId("test-supervisor");
      const supervisor = new Supervisor({ clock, id, emit });
      expect(supervisor.id.value).toBe("test-supervisor");
    });
  });

  describe("spawning", () => {
    it("should spawn and start a supervised process", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });
      const process = await supervisor.spawn(spec);

      expect(process.status()).toBe("running");
      expect(supervisor.getChildren()).toHaveLength(1);
      expect(supervisor.getChildren()[0]).toBe(process);

      await supervisor.stop();
    });

    it("should emit spawning events", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });
      await supervisor.spawn(spec);

      const spawnEvents = events.filter(
        (e) => (e as TestEvent).type === "supervisor:spawning" || (e as TestEvent).type === "supervisor:spawned",
      );
      expect(spawnEvents).toHaveLength(2);

      await supervisor.stop();
    });

    it("should fail to spawn when stopped", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });
      await supervisor.stop();

      await expect(supervisor.spawn(spec)).rejects.toThrow("Cannot spawn process: supervisor is stopped");
    });

    it("should surface spawn failures", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "bad-child",
        init: () => {
          throw new Error("Spawn failed");
        },
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });

      await expect(supervisor.spawn(spec)).rejects.toThrow("Spawn failed");

      const failEvents = events.filter((e) => (e as TestEvent).type === "supervisor:spawn:failed");
      expect(failEvents).toHaveLength(1);

      await supervisor.stop();
    });

    it("should pass ctx through to the child's init", async () => {
      let received: { port: number } | undefined;
      const spec: ProcessSpec<unknown, void, { port: number }> = {
        name: "with-ctx",
        init: (ctx) => {
          received = ctx;
        },
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });
      await supervisor.spawn(spec, { port: 8080 });

      expect(received).toEqual({ port: 8080 });

      await supervisor.stop();
    });
  });

  describe("supervision strategies", () => {
    it("should apply stop strategy", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });
      const process = await supervisor.spawn(spec);

      supervisor.supervise(process, "stop");

      const supervisionEvents = events.filter(
        (e) => (e as TestEvent).type === "supervisor:supervising" && (e as TestEvent).strategy === "stop",
      );
      expect(supervisionEvents).toHaveLength(1);

      await supervisor.stop();
    });

    it("should apply escalate strategy", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });
      const process = await supervisor.spawn(spec);

      supervisor.supervise(process, "escalate");

      const supervisionEvents = events.filter(
        (e) => (e as TestEvent).type === "supervisor:supervising" && (e as TestEvent).strategy === "escalate",
      );
      expect(supervisionEvents).toHaveLength(1);

      await supervisor.stop();
    });

    it("should restart failed processes and track the restart count", async () => {
      let failCount = 0;
      const spec: ProcessSpec<unknown> = {
        name: "flaky",
        handle: () => {
          failCount++;
          if (failCount === 1) {
            throw new Error("First failure");
          }
        },
      };

      const supervisor = new Supervisor({
        clock,
        emit,
        strategy: {
          type: "one-for-one",
          maxRestarts: { count: 3, within: 10_000 as never },
          backoff: { initial: 0 as never, max: 100 as never, factor: 1 },
        },
      });
      const process = await supervisor.spawn(spec);
      const originalId = process.id;

      await process.send({ type: "test" });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const restartEvents = events.filter((e) => (e as TestEvent).type === "supervisor:child:restarted");
      expect(restartEvents.length).toBeGreaterThan(0);
      expect(supervisor.getRestartCount(originalId)).toBeGreaterThan(0);

      await supervisor.stop();
    });
  });

  describe("shutdown", () => {
    it("should stop all children on supervisor stop", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });
      const p1 = await supervisor.spawn(spec);
      const p2 = await supervisor.spawn(spec);

      expect(supervisor.getChildren()).toHaveLength(2);

      await supervisor.stop();

      expect(p1.status()).toBe("stopped");
      expect(p2.status()).toBe("stopped");
      expect(supervisor.getChildren()).toHaveLength(0);
    });

    it("should emit stop events", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });
      await supervisor.spawn(spec);
      await supervisor.stop();

      const stopEvents = events.filter(
        (e) => (e as TestEvent).type === "supervisor:stopping" || (e as TestEvent).type === "supervisor:stopped",
      );
      expect(stopEvents).toHaveLength(2);
    });

    it("should handle child stop errors gracefully", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
        onStop: () => {
          throw new Error("Stop failed");
        },
      };

      const supervisor = new Supervisor({ clock, emit });
      await supervisor.spawn(spec);

      await expect(supervisor.stop()).resolves.not.toThrow();

      const errorEvents = events.filter((e) => (e as TestEvent).type === "supervisor:child:stop:error");
      expect(errorEvents).toHaveLength(1);
    });

    it("should be idempotent", async () => {
      const supervisor = new Supervisor({ clock, emit });
      await supervisor.stop();
      await supervisor.stop(); // no throw

      expect(supervisor.getChildren()).toHaveLength(0);
    });
  });

  describe("isolation", () => {
    it("should keep per-actor state independent", async () => {
      let proc1Count = 0;
      let proc2Count = 0;

      const spec1: ProcessSpec<unknown> = {
        name: "counter-1",
        handle: () => {
          proc1Count++;
        },
      };
      const spec2: ProcessSpec<unknown> = {
        name: "counter-2",
        handle: () => {
          proc2Count++;
        },
      };

      const supervisor = new Supervisor({ clock, emit });
      const p1 = await supervisor.spawn(spec1);
      const p2 = await supervisor.spawn(spec2);

      await p1.send({ type: "msg1" });
      await p1.send({ type: "msg2" });
      await p2.send({ type: "msg3" });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(proc1Count).toBe(2);
      expect(proc2Count).toBe(1);

      await supervisor.stop();
    });

    it("should spawn multiple processes in parallel without interference", async () => {
      const spec: ProcessSpec<unknown> = {
        name: "child",
        handle: () => {},
      };

      const supervisor = new Supervisor({ clock, emit });

      const processes = await Promise.all([supervisor.spawn(spec), supervisor.spawn(spec), supervisor.spawn(spec)]);

      expect(supervisor.getChildren()).toHaveLength(3);

      await supervisor.stop();

      processes.forEach((p) => {
        expect(p.status()).toBe("stopped");
      });
    });
  });
});

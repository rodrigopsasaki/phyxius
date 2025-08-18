import { describe, it, expect, beforeEach } from "vitest";
import { createSupervisor, createProcessId } from "../src/index.js";
import type { ProcessBehavior } from "../src/index.js";

describe("Supervisor", () => {
  let events: unknown[] = [];
  const emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("supervisor lifecycle", () => {
    it("should create supervisor with generated ID", () => {
      const supervisor = createSupervisor({ emit });
      expect(supervisor.id.value).toBeDefined();
      expect(supervisor.getChildren()).toHaveLength(0);
    });

    it("should create supervisor with specific ID", () => {
      const id = createProcessId("test-supervisor");
      const supervisor = createSupervisor({ id, emit });
      expect(supervisor.id.value).toBe("test-supervisor");
    });
  });

  describe("process spawning", () => {
    it("should spawn and start process", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });
      const process = await supervisor.spawn(behavior);

      expect(process.state).toBe("running");
      expect(supervisor.getChildren()).toHaveLength(1);
      expect(supervisor.getChildren()[0]).toBe(process);
    });

    it("should emit spawning events", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });
      await supervisor.spawn(behavior);

      const spawnEvents = events.filter(
        (e: any) => e.type === "supervisor:spawning" || e.type === "supervisor:spawned",
      );
      expect(spawnEvents).toHaveLength(2);
    });

    it("should fail to spawn when stopped", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });
      await supervisor.stop();

      await expect(supervisor.spawn(behavior)).rejects.toThrow("Cannot spawn process: supervisor is stopped");
    });

    it("should handle spawn failures", async () => {
      const behavior: ProcessBehavior = {
        init: async () => {
          throw new Error("Spawn failed");
        },
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });

      await expect(supervisor.spawn(behavior)).rejects.toThrow("Spawn failed");

      const failEvents = events.filter((e: any) => e.type === "supervisor:spawn:failed");
      expect(failEvents).toHaveLength(1);
    });
  });

  describe("supervision strategies", () => {
    it("should supervise with custom strategy", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });
      const process = await supervisor.spawn(behavior);

      supervisor.supervise(process, "stop");

      const supervisionEvents = events.filter((e: any) => e.type === "supervisor:supervising");
      expect(supervisionEvents).toHaveLength(2); // Default + custom
    });

    it("should restart failed processes with restart strategy", async () => {
      let failCount = 0;
      const behavior: ProcessBehavior = {
        handle: async () => {
          failCount++;
          if (failCount === 1) {
            throw new Error("First failure");
          }
        },
      };

      const supervisor = createSupervisor({ emit });
      const process = await supervisor.spawn(behavior);

      // Send message that will cause failure
      await process.send({ type: "test" });

      // Wait for failure and restart
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Process should be restarted
      const restartEvents = events.filter((e: any) => e.type === "supervisor:child:restarted");
      expect(restartEvents.length).toBeGreaterThan(0);
    });

    it("should apply stop strategy supervision", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });
      const process = await supervisor.spawn(behavior);

      // Test that we can apply stop strategy
      supervisor.supervise(process, "stop");

      const supervisionEvents = events.filter((e: any) => e.type === "supervisor:supervising" && e.strategy === "stop");
      expect(supervisionEvents).toHaveLength(1);
    });

    it("should apply escalate strategy supervision", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });
      const process = await supervisor.spawn(behavior);

      // Test that we can apply escalate strategy
      supervisor.supervise(process, "escalate");

      const supervisionEvents = events.filter(
        (e: any) => e.type === "supervisor:supervising" && e.strategy === "escalate",
      );
      expect(supervisionEvents).toHaveLength(1);
    });
  });

  describe("supervisor shutdown", () => {
    it("should stop all children when stopping", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });
      const process1 = await supervisor.spawn(behavior);
      const process2 = await supervisor.spawn(behavior);

      expect(supervisor.getChildren()).toHaveLength(2);

      await supervisor.stop();

      expect(process1.state).toBe("stopped");
      expect(process2.state).toBe("stopped");
      expect(supervisor.getChildren()).toHaveLength(0);
    });

    it("should emit stop events", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });
      await supervisor.spawn(behavior);
      await supervisor.stop();

      const stopEvents = events.filter((e: any) => e.type === "supervisor:stopping" || e.type === "supervisor:stopped");
      expect(stopEvents).toHaveLength(2);
    });

    it("should handle child stop errors gracefully", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
        terminate: async () => {
          throw new Error("Stop failed");
        },
      };

      const supervisor = createSupervisor({ emit });
      await supervisor.spawn(behavior);

      // Should not throw despite child stop error
      await expect(supervisor.stop()).resolves.not.toThrow();

      const errorEvents = events.filter((e: any) => e.type === "supervisor:child:stop:error");
      expect(errorEvents).toHaveLength(1);
    });

    it("should be idempotent", async () => {
      const supervisor = createSupervisor({ emit });
      await supervisor.stop();
      await supervisor.stop(); // Should not throw

      expect(supervisor.getChildren()).toHaveLength(0);
    });
  });

  describe("complex scenarios", () => {
    it("should handle multiple failures and restarts", async () => {
      let attempts = 0;
      const behavior: ProcessBehavior = {
        handle: async () => {
          attempts++;
          if (attempts <= 2) {
            throw new Error(`Attempt ${attempts} failed`);
          }
        },
      };

      const supervisor = createSupervisor({ emit });
      const process = await supervisor.spawn(behavior);

      // Send messages that will fail initially
      await process.send({ type: "test1" });
      await process.send({ type: "test2" });
      await process.send({ type: "test3" });

      // Wait for processing and restarts
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have multiple restart attempts
      const restartEvents = events.filter((e: any) => e.type === "supervisor:child:restarted");
      expect(restartEvents.length).toBeGreaterThan(0);
    });

    it("should work without emit function", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor();
      const process = await supervisor.spawn(behavior);

      expect(process.state).toBe("running");
      await supervisor.stop();
      expect(process.state).toBe("stopped");
    });

    it("should handle rapid spawn/stop cycles", async () => {
      const behavior: ProcessBehavior = {
        handle: async () => {},
      };

      const supervisor = createSupervisor({ emit });

      // Rapid spawning
      const processes = await Promise.all([
        supervisor.spawn(behavior),
        supervisor.spawn(behavior),
        supervisor.spawn(behavior),
      ]);

      expect(supervisor.getChildren()).toHaveLength(3);

      // Rapid stopping
      await supervisor.stop();

      processes.forEach((process) => {
        expect(process.state).toBe("stopped");
      });
    });

    it("should maintain process isolation", async () => {
      let process1Messages = 0;
      let process2Messages = 0;

      const behavior1: ProcessBehavior = {
        handle: async () => {
          process1Messages++;
        },
      };

      const behavior2: ProcessBehavior = {
        handle: async () => {
          process2Messages++;
        },
      };

      const supervisor = createSupervisor({ emit });
      const proc1 = await supervisor.spawn(behavior1);
      const proc2 = await supervisor.spawn(behavior2);

      await proc1.send({ type: "msg1" });
      await proc1.send({ type: "msg2" });
      await proc2.send({ type: "msg3" });

      // Wait for message processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process1Messages).toBe(2);
      expect(process2Messages).toBe(1);
    });
  });
});

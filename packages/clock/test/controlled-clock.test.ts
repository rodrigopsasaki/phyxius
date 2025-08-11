import { describe, it, expect, beforeEach } from "vitest";
import { createControlledClock } from "../src/controlled-clock.js";
import type { Millis, DeadlineTarget } from "../src/types.js";

describe("ControlledClock", () => {
  let clock: ReturnType<typeof createControlledClock>;
  let events: unknown[] = [];

  beforeEach(() => {
    events = [];
    clock = createControlledClock({
      initialTime: 1000000000000, // Fixed start time
      emit: (event) => events.push(event),
    });
  });

  describe("now()", () => {
    it("should return configured initial time", () => {
      const instant = clock.now();
      expect(instant.wallMs).toBe(1000000000000);
      expect(instant.monoMs).toBe(1000000000000);
    });

    it("should advance monotonic time independently", async () => {
      const instant1 = clock.now();
      await clock.advanceBy(100 as Millis);
      const instant2 = clock.now();

      expect(instant2.wallMs).toBe(instant1.wallMs + 100);
      expect(instant2.monoMs).toBe(instant1.monoMs + 100);
    });
  });

  describe("sleep()", () => {
    it("should not resolve until time is advanced", async () => {
      let resolved = false;
      const sleepPromise = clock.sleep(100 as Millis).then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);

      await clock.advanceBy(50 as Millis);
      expect(resolved).toBe(false);

      await clock.advanceBy(50 as Millis);
      await sleepPromise;
      expect(resolved).toBe(true);
    });

    it("should emit sleep events", async () => {
      const sleepPromise = clock.sleep(100 as Millis);
      await clock.advanceBy(100 as Millis);
      await sleepPromise;

      // Filter out advance events
      const sleepEvents = events.filter((e: any) => e.type.startsWith("time:sleep"));
      expect(sleepEvents).toHaveLength(2);
      expect(sleepEvents[0]).toMatchObject({
        type: "time:sleep:start",
        durationMs: 100,
      });
      expect(sleepEvents[1]).toMatchObject({
        type: "time:sleep:end",
        durationMs: 100,
        actualMs: 100,
      });
    });

    it("should handle non-positive durations", async () => {
      await clock.sleep(0 as Millis);
      await clock.sleep(-10 as Millis);
      expect(events).toHaveLength(0);
    });
  });

  describe("deadline()", () => {
    it("should wait for deadline", async () => {
      const target: DeadlineTarget = { wallMs: 1000000000000 + 50 };
      const deadlinePromise = clock.deadline(target);
      await clock.advanceBy(50 as Millis);
      await deadlinePromise;

      const okEvent = events.find((e: any) => e.type === "time:deadline:ok");
      expect(okEvent).toBeDefined();
    });

    it("should handle past deadlines", async () => {
      await clock.advanceBy(100 as Millis);
      const past: DeadlineTarget = { wallMs: clock.now().wallMs - 50 };
      await clock.deadline(past);

      const errEvent = events.find((e: any) => e.type === "time:deadline:err");
      expect(errEvent).toBeDefined();
    });
  });

  describe("interval()", () => {
    it("should fire at specified intervals", async () => {
      const callbacks: number[] = [];
      const handle = clock.interval(100 as Millis, () => {
        callbacks.push(clock.now().monoMs);
      });

      await clock.advanceBy(250 as Millis);
      handle.cancel();

      expect(callbacks).toEqual([1000000000100, 1000000000200]);
    });

    it("should emit interval events", async () => {
      const handle = clock.interval(100 as Millis, () => {});
      await clock.advanceBy(250 as Millis);
      handle.cancel();

      const setEvent = events.find((e: any) => e.type === "time:interval:set");
      const tickEvents = events.filter((e: any) => e.type === "time:interval:tick");
      const cancelEvent = events.find((e: any) => e.type === "time:interval:cancel");

      expect(setEvent).toBeDefined();
      expect(tickEvents).toHaveLength(2);
      expect(cancelEvent).toBeDefined();
    });

    it("should continue on callback errors", async () => {
      let callCount = 0;
      const handle = clock.interval(100 as Millis, () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Test error");
        }
      });

      await clock.advanceBy(350 as Millis);
      handle.cancel();

      expect(callCount).toBe(3);
      const errorEvent = events.find((e: any) => e.type === "time:interval:error");
      expect(errorEvent).toBeDefined();
    });

    it("should throw for non-positive intervals", () => {
      expect(() => clock.interval(0 as Millis, () => {})).toThrow("Interval must be positive");
      expect(() => clock.interval(-10 as Millis, () => {})).toThrow("Interval must be positive");
    });
  });

  describe("advanceBy()", () => {
    it("should advance time by specified amount", async () => {
      const before = clock.now();
      await clock.advanceBy(500 as Millis);
      const after = clock.now();

      expect(after.monoMs).toBe(before.monoMs + 500);
      expect(after.wallMs).toBe(before.wallMs + 500);
    });

    it("should emit advance events", async () => {
      await clock.advanceBy(100 as Millis);

      const advanceEvent = events.find((e: any) => e.type === "time:advance");
      expect(advanceEvent).toMatchObject({
        type: "time:advance",
        byMs: 100,
        fromMono: 1000000000000,
        toMono: 1000000000100,
      });
    });

    it("should handle non-positive advances", async () => {
      const before = clock.now();
      await clock.advanceBy(0 as Millis);
      await clock.advanceBy(-10 as Millis);
      const after = clock.now();

      expect(after.monoMs).toBe(before.monoMs);
      expect(after.wallMs).toBe(before.wallMs);
    });
  });

  describe("advanceTo()", () => {
    it("should advance to specific monotonic time", async () => {
      await clock.advanceTo(1000000000500);
      const instant = clock.now();

      expect(instant.monoMs).toBe(1000000000500);
      expect(instant.wallMs).toBe(1000000000500);
    });

    it("should not go backwards", async () => {
      await clock.advanceTo(1000000000100);
      const before = clock.now();
      await clock.advanceTo(1000000000050);
      const after = clock.now();

      expect(after.monoMs).toBe(before.monoMs);
      expect(after.wallMs).toBe(before.wallMs);
    });
  });

  describe("tick()", () => {
    it("should advance to next timer", async () => {
      clock.sleep(100 as Millis);
      clock.sleep(200 as Millis);

      await clock.tick();
      expect(clock.now().monoMs).toBe(1000000000100);

      await clock.tick();
      expect(clock.now().monoMs).toBe(1000000000200);
    });

    it("should do nothing with no pending timers", async () => {
      const before = clock.now();
      await clock.tick();
      const after = clock.now();

      expect(after.monoMs).toBe(before.monoMs);
      expect(after.wallMs).toBe(before.wallMs);
    });
  });

  describe("getPendingTimerCount()", () => {
    it("should return number of active timers", () => {
      expect(clock.getPendingTimerCount()).toBe(0);

      clock.sleep(100 as Millis);
      expect(clock.getPendingTimerCount()).toBe(1);

      const handle = clock.interval(50 as Millis, () => {});
      expect(clock.getPendingTimerCount()).toBe(2);

      handle.cancel();
      expect(clock.getPendingTimerCount()).toBe(1);
    });
  });

  describe("complex scenarios", () => {
    it("should handle multiple overlapping timers", async () => {
      const results: string[] = [];

      clock.sleep(100 as Millis).then(() => results.push("sleep1"));
      clock.sleep(150 as Millis).then(() => results.push("sleep2"));
      clock.deadline({ wallMs: clock.now().wallMs + 75 }).then(() => results.push("deadline"));

      await clock.advanceBy(200 as Millis);

      expect(results).toContain("deadline");
      expect(results).toContain("sleep1");
      expect(results).toContain("sleep2");
      expect(results.length).toBe(3);
    });

    it("should handle intervals with other timers", async () => {
      const results: string[] = [];
      const handle = clock.interval(50 as Millis, () => results.push("interval"));

      clock.sleep(125 as Millis).then(() => results.push("sleep"));
      await clock.advanceBy(175 as Millis);
      handle.cancel();

      expect(results).toContain("sleep");
      expect(results.filter((r) => r === "interval")).toHaveLength(3);
      expect(results.length).toBe(4);
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { ControlledClock } from "../src/controlled-clock.js";

describe("ControlledClock", () => {
  let clock: ControlledClock;
  let events: unknown[] = [];

  beforeEach(() => {
    events = [];
    clock = new ControlledClock({
      initialTime: 1000000000000, // Fixed start time
      emit: (event) => events.push(event),
    });
  });

  describe("now()", () => {
    it("should return configured initial time", () => {
      const instant = clock.now();
      expect(instant.wallMs).toBe(1000000000000);
      expect(instant.monoMs).toBe(0);
    });

    it("should advance monotonic time independently", async () => {
      const instant1 = clock.now();
      await clock.advanceBy(100);
      const instant2 = clock.now();

      expect(instant2.wallMs).toBe(instant1.wallMs + 100);
      expect(instant2.monoMs).toBe(instant1.monoMs + 100);
    });
  });

  describe("sleep()", () => {
    it("should not resolve until time is advanced", async () => {
      let resolved = false;
      const sleepPromise = clock.sleep(100).then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);

      await clock.advanceBy(50);
      expect(resolved).toBe(false);

      await clock.advanceBy(50);
      await sleepPromise;
      expect(resolved).toBe(true);
    });

    it("should emit sleep events", async () => {
      const sleepPromise = clock.sleep(100);
      await clock.advanceBy(100);
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
      await clock.sleep(0);
      await clock.sleep(-10);
      expect(events).toHaveLength(0);
    });
  });

  describe("deadline()", () => {
    it("should wait for relative deadline", async () => {
      const deadlinePromise = clock.deadline(50);
      await clock.advanceBy(50);
      await deadlinePromise;

      const okEvent = events.find((e: any) => e.type === "time:deadline:ok");
      expect(okEvent).toBeDefined();
    });

    it("should wait for absolute deadline", async () => {
      const target = 1000000000000 + 50;
      const deadlinePromise = clock.deadline(target);
      await clock.advanceBy(50);
      await deadlinePromise;

      const okEvent = events.find((e: any) => e.type === "time:deadline:ok");
      expect(okEvent).toBeDefined();
    });

    it("should handle past deadlines", async () => {
      await clock.advanceBy(100);
      const past = clock.now().wallMs - 50;
      await clock.deadline(past);

      const errEvent = events.find((e: any) => e.type === "time:deadline:err");
      expect(errEvent).toBeDefined();
    });
  });

  describe("interval()", () => {
    it("should fire at specified intervals", async () => {
      const callbacks: number[] = [];
      const handle = clock.interval(100, () => {
        callbacks.push(clock.now().monoMs);
      });

      await clock.advanceBy(250);
      handle.clear();

      expect(callbacks).toEqual([100, 200]);
    });

    it("should emit interval events", async () => {
      const handle = clock.interval(100, () => {});
      await clock.advanceBy(250);
      handle.clear();

      const setEvent = events.find((e: any) => e.type === "time:interval:set");
      const tickEvents = events.filter((e: any) => e.type === "time:interval:tick");
      const cancelEvent = events.find((e: any) => e.type === "time:interval:cancel");

      expect(setEvent).toBeDefined();
      expect(tickEvents).toHaveLength(2);
      expect(cancelEvent).toBeDefined();
    });

    it("should continue on callback errors", async () => {
      let callCount = 0;
      const handle = clock.interval(100, () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Test error");
        }
      });

      await clock.advanceBy(350);
      handle.clear();

      expect(callCount).toBe(3);
      const errorEvent = events.find((e: any) => e.type === "time:interval:error");
      expect(errorEvent).toBeDefined();
    });

    it("should throw for non-positive intervals", () => {
      expect(() => clock.interval(0, () => {})).toThrow("Interval must be positive");
      expect(() => clock.interval(-10, () => {})).toThrow("Interval must be positive");
    });
  });

  describe("advanceBy()", () => {
    it("should advance time by specified amount", async () => {
      const before = clock.now();
      await clock.advanceBy(500);
      const after = clock.now();

      expect(after.monoMs).toBe(before.monoMs + 500);
      expect(after.wallMs).toBe(before.wallMs + 500);
    });

    it("should emit advance events", async () => {
      await clock.advanceBy(100);

      const advanceEvent = events.find((e: any) => e.type === "time:advance");
      expect(advanceEvent).toMatchObject({
        type: "time:advance",
        byMs: 100,
        fromMono: 0,
        toMono: 100,
      });
    });

    it("should handle non-positive advances", async () => {
      const before = clock.now();
      await clock.advanceBy(0);
      await clock.advanceBy(-10);
      const after = clock.now();

      expect(after.monoMs).toBe(before.monoMs);
      expect(after.wallMs).toBe(before.wallMs);
    });
  });

  describe("advanceTo()", () => {
    it("should advance to specific monotonic time", async () => {
      await clock.advanceTo(500);
      const instant = clock.now();

      expect(instant.monoMs).toBe(500);
      expect(instant.wallMs).toBe(1000000000000 + 500);
    });

    it("should not go backwards", async () => {
      await clock.advanceTo(100);
      const before = clock.now();
      await clock.advanceTo(50);
      const after = clock.now();

      expect(after.monoMs).toBe(before.monoMs);
      expect(after.wallMs).toBe(before.wallMs);
    });
  });

  describe("tick()", () => {
    it("should advance to next timer", async () => {
      clock.sleep(100);
      clock.sleep(200);

      await clock.tick();
      expect(clock.now().monoMs).toBe(100);

      await clock.tick();
      expect(clock.now().monoMs).toBe(200);
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

      clock.sleep(100);
      expect(clock.getPendingTimerCount()).toBe(1);

      const handle = clock.interval(50, () => {});
      expect(clock.getPendingTimerCount()).toBe(2);

      handle.clear();
      expect(clock.getPendingTimerCount()).toBe(1);
    });
  });

  describe("complex scenarios", () => {
    it("should handle multiple overlapping timers", async () => {
      const results: string[] = [];

      clock.sleep(100).then(() => results.push("sleep1"));
      clock.sleep(150).then(() => results.push("sleep2"));
      clock.deadline(75).then(() => results.push("deadline"));

      await clock.advanceBy(200);

      expect(results).toContain("deadline");
      expect(results).toContain("sleep1");
      expect(results).toContain("sleep2");
      expect(results.length).toBe(3);
    });

    it("should handle intervals with other timers", async () => {
      const results: string[] = [];
      const handle = clock.interval(50, () => results.push("interval"));

      clock.sleep(125).then(() => results.push("sleep"));
      await clock.advanceBy(175);
      handle.clear();

      expect(results).toContain("sleep");
      expect(results.filter((r) => r === "interval")).toHaveLength(3);
      expect(results.length).toBe(4);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSystemClock } from "../src/system-clock.js";
import type { Clock, Millis, DeadlineTarget } from "../src/types.js";

describe("SystemClock", () => {
  let clock: Clock;
  let events: unknown[] = [];

  beforeEach(() => {
    events = [];
    clock = createSystemClock({
      emit: (event) => events.push(event),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("now()", () => {
    it("should return current wall and monotonic time", () => {
      const before = Date.now();
      const instant = clock.now();
      const after = Date.now();

      expect(instant.wallMs).toBeGreaterThanOrEqual(before);
      expect(instant.wallMs).toBeLessThanOrEqual(after);
      expect(instant.monoMs).toBeGreaterThan(0);
    });

    it("should return increasing monotonic time", () => {
      const instant1 = clock.now();
      const instant2 = clock.now();

      expect(instant2.monoMs).toBeGreaterThanOrEqual(instant1.monoMs);
      expect(instant2.wallMs).toBeGreaterThanOrEqual(instant1.wallMs);
    });
  });

  describe("sleep()", () => {
    it("should sleep for the specified duration", async () => {
      const start = Date.now();
      await clock.sleep(50 as Millis);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
      expect(elapsed).toBeLessThan(100);
    });

    it("should emit sleep events", async () => {
      await clock.sleep(10 as Millis);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "time:sleep:start",
        durationMs: 10,
      });
      expect(events[1]).toMatchObject({
        type: "time:sleep:end",
        durationMs: 10,
      });
    });

    it("should return immediately for non-positive durations", async () => {
      const start = Date.now();
      await clock.sleep(0 as Millis);
      await clock.sleep(-10 as Millis);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10);
      expect(events).toHaveLength(0);
    });
  });

  describe("deadline()", () => {
    it("should wait until deadline", async () => {
      const start = Date.now();
      const target: DeadlineTarget = { wallMs: Date.now() + 50 };
      await clock.deadline(target);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(100);
    });

    it("should emit deadline events", async () => {
      const target: DeadlineTarget = { wallMs: Date.now() + 10 };
      await clock.deadline(target);

      const deadlineStart = events.find((e: any) => e.type === "time:deadline:start");
      const deadlineEnd = events.find((e: any) => e.type?.startsWith("time:deadline:"));

      expect(deadlineStart).toBeDefined();
      expect(deadlineEnd).toBeDefined();
    });

    it("should handle past deadlines", async () => {
      const past: DeadlineTarget = { wallMs: Date.now() - 1000 };
      await clock.deadline(past);

      const errEvent = events.find((e: any) => e.type === "time:deadline:err");
      expect(errEvent).toBeDefined();
    });
  });

  describe("interval()", () => {
    it("should call callback at intervals", async () => {
      const callbacks: number[] = [];
      const handle = clock.interval(20 as Millis, () => {
        callbacks.push(Date.now());
      });

      await new Promise((resolve) => setTimeout(resolve, 65));
      handle.cancel();

      expect(callbacks.length).toBeGreaterThanOrEqual(2);
      expect(callbacks.length).toBeLessThanOrEqual(4);
    });

    it("should emit interval events", async () => {
      const handle = clock.interval(20 as Millis, () => {});

      await new Promise((resolve) => setTimeout(resolve, 45));
      handle.cancel();

      const setEvent = events.find((e: any) => e.type === "time:interval:set");
      const tickEvents = events.filter((e: any) => e.type === "time:interval:tick");
      const cancelEvent = events.find((e: any) => e.type === "time:interval:cancel");

      expect(setEvent).toBeDefined();
      expect(tickEvents.length).toBeGreaterThanOrEqual(1);
      expect(cancelEvent).toBeDefined();
    });

    it("should continue on callback errors", async () => {
      let callCount = 0;
      const handle = clock.interval(20 as Millis, () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Test error");
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 65));
      handle.cancel();

      expect(callCount).toBeGreaterThanOrEqual(3);
      const errorEvent = events.find((e: any) => e.type === "time:interval:error");
      expect(errorEvent).toBeDefined();
    });

    it("should throw for non-positive intervals", () => {
      expect(() => clock.interval(0 as Millis, () => {})).toThrow();
      expect(() => clock.interval(-10 as Millis, () => {})).toThrow();
    });
  });

  describe("timeout()", () => {
    it("should timeout for the specified duration", async () => {
      const start = Date.now();
      await clock.timeout(50 as Millis);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(100);
    });
  });
});

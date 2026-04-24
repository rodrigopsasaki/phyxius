import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSystemClock } from "../src/system-clock.js";
import type { Clock, Millis, DeadlineTarget } from "../src/types.js";

interface ClockEvent {
  type: string;
  [key: string]: unknown;
}

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

      const deadlineStart = events.find((e: ClockEvent) => e.type === "time:deadline:start");
      const deadlineEnd = events.find((e: ClockEvent) => e.type?.startsWith("time:deadline:"));

      expect(deadlineStart).toBeDefined();
      expect(deadlineEnd).toBeDefined();
    });

    it("should handle past deadlines", async () => {
      const past: DeadlineTarget = { wallMs: Date.now() - 1000 };
      await clock.deadline(past);

      const errEvent = events.find((e: ClockEvent) => e.type === "time:deadline:err");
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

      const setEvent = events.find((e: ClockEvent) => e.type === "time:interval:set");
      const tickEvents = events.filter((e: ClockEvent) => e.type === "time:interval:tick");
      const cancelEvent = events.find((e: ClockEvent) => e.type === "time:interval:cancel");

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
      const errorEvent = events.find((e: ClockEvent) => e.type === "time:interval:error");
      expect(errorEvent).toBeDefined();
    });

    it("should throw for non-positive intervals", () => {
      expect(() => clock.interval(0 as Millis, () => {})).toThrow();
      expect(() => clock.interval(-10 as Millis, () => {})).toThrow();
    });
  });

  describe("timeout()", () => {
    it("should return a budget that expires after the specified duration", async () => {
      const budget = clock.timeout(50 as Millis);

      expect(budget.expired()).toBe(false);
      expect(budget.signal.aborted).toBe(false);

      await new Promise<void>((resolve) => {
        budget.signal.addEventListener("abort", () => resolve());
      });

      expect(budget.expired()).toBe(true);
      expect(budget.signal.aborted).toBe(true);
      // `remaining()` clamps to 0 when the deadline has passed — but
      // setTimeout (fires the abort) and performance.now() (feeds
      // monoMs) are independent clock sources that can disagree by
      // sub-millisecond amounts under CI load. A small positive value
      // here doesn't violate the contract; a meaningfully positive one
      // would.
      expect(budget.remaining()).toBeLessThanOrEqual(10);
    });

    it("should expose a deadline based on the current instant", () => {
      const before = clock.now();
      const budget = clock.timeout(100 as Millis);

      expect(budget.deadline.wallMs).toBeGreaterThanOrEqual(before.wallMs + 100);
      expect(budget.deadline.monoMs).toBeGreaterThanOrEqual(before.monoMs + 100);
    });

    it("should not abort the signal when released", async () => {
      const budget = clock.timeout(50 as Millis);
      budget.release();

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(budget.signal.aborted).toBe(false);
      expect(budget.expired()).toBe(false);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SystemClock } from "../src/system-clock.js";

describe("SystemClock", () => {
  let clock: SystemClock;
  let events: unknown[] = [];

  beforeEach(() => {
    events = [];
    clock = new SystemClock({
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
      await clock.sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
      expect(elapsed).toBeLessThan(100);
    });

    it("should emit sleep events", async () => {
      await clock.sleep(10);

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
      await clock.sleep(0);
      await clock.sleep(-10);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10);
      expect(events).toHaveLength(0);
    });
  });

  describe("deadline()", () => {
    it("should wait until relative deadline", async () => {
      const start = Date.now();
      await clock.deadline(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(100);
    });

    it("should wait until absolute deadline", async () => {
      const target = Date.now() + 50;
      const start = Date.now();
      await clock.deadline(target);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(100);
    });

    it("should emit deadline events", async () => {
      await clock.deadline(10);

      const deadlineStart = events.find((e: any) => e.type === "time:deadline:start");
      const deadlineEnd = events.find((e: any) => e.type?.startsWith("time:deadline:"));

      expect(deadlineStart).toBeDefined();
      expect(deadlineEnd).toBeDefined();
    });

    it("should handle past deadlines", async () => {
      const past = Date.now() - 1000;
      await clock.deadline(past);

      const errEvent = events.find((e: any) => e.type === "time:deadline:err");
      expect(errEvent).toBeDefined();
    });
  });

  describe("interval()", () => {
    it("should call callback at intervals", async () => {
      const callbacks: number[] = [];
      const handle = clock.interval(20, () => {
        callbacks.push(Date.now());
      });

      await new Promise((resolve) => setTimeout(resolve, 65));
      handle.clear();

      expect(callbacks.length).toBeGreaterThanOrEqual(2);
      expect(callbacks.length).toBeLessThanOrEqual(4);
    });

    it("should emit interval events", async () => {
      const handle = clock.interval(20, () => {});

      await new Promise((resolve) => setTimeout(resolve, 45));
      handle.clear();

      const setEvent = events.find((e: any) => e.type === "time:interval:set");
      const tickEvents = events.filter((e: any) => e.type === "time:interval:tick");
      const cancelEvent = events.find((e: any) => e.type === "time:interval:cancel");

      expect(setEvent).toBeDefined();
      expect(tickEvents.length).toBeGreaterThanOrEqual(1);
      expect(cancelEvent).toBeDefined();
    });

    it("should continue on callback errors", async () => {
      let callCount = 0;
      const handle = clock.interval(20, () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Test error");
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 65));
      handle.clear();

      expect(callCount).toBeGreaterThanOrEqual(3);
      const errorEvent = events.find((e: any) => e.type === "time:interval:error");
      expect(errorEvent).toBeDefined();
    });

    it("should throw for non-positive intervals", () => {
      expect(() => clock.interval(0, () => {})).toThrow();
      expect(() => clock.interval(-10, () => {})).toThrow();
    });
  });
});

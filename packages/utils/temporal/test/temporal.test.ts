import { describe, it, expect, vi } from "vitest";
import { createControlledClock, type Millis } from "@phyxiusjs/clock";
import { debounce, throttle } from "../src/index.js";

describe("Temporal Utilities", () => {
  describe("debounce", () => {
    it("should delay function execution", async () => {
      const clock = createControlledClock();
      const fn = vi.fn();
      const debounced = debounce(fn, 100 as Millis, clock);

      debounced("test");
      expect(fn).not.toHaveBeenCalled();

      clock.advanceBy(100 as Millis);
      await clock.flush();
      expect(fn).toHaveBeenCalledWith("test");
    });

    it("should cancel previous calls when called again", async () => {
      const clock = createControlledClock();
      const fn = vi.fn();
      const debounced = debounce(fn, 100 as Millis, clock);

      debounced("first");
      clock.advanceBy(50 as Millis);

      debounced("second");
      clock.advanceBy(100 as Millis);
      await clock.flush();

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("second");
    });
  });

  describe("throttle", () => {
    it("should execute immediately on first call", () => {
      const clock = createControlledClock();
      const fn = vi.fn();
      const throttled = throttle(fn, 100 as Millis, clock);

      throttled("test");
      expect(fn).toHaveBeenCalledWith("test");
    });

    it("should throttle subsequent calls", async () => {
      const clock = createControlledClock();
      const fn = vi.fn();
      const throttled = throttle(fn, 100 as Millis, clock);

      throttled("first");
      throttled("second");

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("first");

      clock.advanceBy(100 as Millis);
      await clock.flush();

      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith("second");
    });
  });

  describe("no-accumulation property", () => {
    it("debounce should keep at most one pending timer regardless of call rate", () => {
      const clock = createControlledClock();
      const fn = vi.fn();
      const debounced = debounce(fn, 100 as Millis, clock);

      // Hammer the debouncer — 100 calls in rapid succession.
      for (let i = 0; i < 100; i++) {
        debounced(i);
      }

      // Controlled clock exposes pending timer count; must stay at 1 because
      // each new call releases the previous budget and creates a fresh one.
      expect(clock.getPendingTimerCount()).toBe(1);
    });

    it("throttle should keep at most one pending trailing timer", () => {
      const clock = createControlledClock();
      const fn = vi.fn();
      const throttled = throttle(fn, 100 as Millis, clock);

      throttled(0); // fires immediately
      for (let i = 1; i < 100; i++) {
        throttled(i); // all fall within the window, only update trailing args
      }

      // Exactly one trailing timer, regardless of the 99 in-window calls.
      expect(clock.getPendingTimerCount()).toBe(1);
    });

    it("debounce should fire with the latest args after a burst", async () => {
      const clock = createControlledClock();
      const fn = vi.fn();
      const debounced = debounce(fn, 100 as Millis, clock);

      for (let i = 0; i < 50; i++) {
        debounced(i);
      }
      // Nothing fires yet.
      expect(fn).not.toHaveBeenCalled();

      clock.advanceBy(100 as Millis);
      await clock.flush();

      // Exactly one fire, with the latest args.
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(49);
    });

    it("throttle should fire with the latest args at the end of the window", async () => {
      const clock = createControlledClock();
      const fn = vi.fn();
      const throttled = throttle(fn, 100 as Millis, clock);

      throttled(0); // fires immediately
      for (let i = 1; i < 50; i++) {
        throttled(i);
      }

      clock.advanceBy(100 as Millis);
      await clock.flush();

      // Immediate fire + one trailing fire = 2 total.
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(1, 0);
      expect(fn).toHaveBeenNthCalledWith(2, 49); // latest args
    });
  });
});

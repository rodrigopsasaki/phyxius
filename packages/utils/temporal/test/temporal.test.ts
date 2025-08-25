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
});

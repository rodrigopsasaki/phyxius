import { describe, it, expect, vi } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { isOk, isErr } from "@phyxiusjs/fp";
import { retry, runWithRetry } from "../src/index.js";

describe("@phyxiusjs/retry", () => {
  describe("retry.none", () => {
    it("should run exactly once", async () => {
      const clock = createControlledClock();
      const fn = vi.fn(async () => "result");

      const result = await runWithRetry(fn, retry.none(), clock);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe("result");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should return EXHAUSTED after one failure", async () => {
      const clock = createControlledClock();
      const fn = vi.fn(async () => {
        throw new Error("boom");
      });

      const result = await runWithRetry(fn, retry.none(), clock);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.type).toBe("EXHAUSTED");
        if (result.error.type === "EXHAUSTED") {
          expect(result.error.attempts).toBe(1);
        }
      }
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry.fixed", () => {
    it("should retry with a fixed delay between attempts", async () => {
      const clock = createControlledClock();
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error(`attempt ${calls}`);
        return "finally";
      });

      const policy = retry.fixed({ maxAttempts: 3, delay: ms(100) });
      const promise = runWithRetry(fn, policy, clock);

      // Attempt 1 runs immediately (no delay before first).
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);

      // Advance past first retry delay (100ms).
      clock.advanceBy(ms(100));
      await clock.flush();
      expect(fn).toHaveBeenCalledTimes(2);

      // Advance past second retry delay.
      clock.advanceBy(ms(100));
      await clock.flush();

      const result = await promise;
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe("finally");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should return EXHAUSTED when all attempts fail", async () => {
      const clock = createControlledClock();
      const fn = vi.fn(async () => {
        throw new Error("always fails");
      });

      const promise = runWithRetry(fn, retry.fixed({ maxAttempts: 2, delay: ms(10) }), clock);
      await Promise.resolve();
      clock.advanceBy(ms(10));
      await clock.flush();

      const result = await promise;
      expect(isErr(result)).toBe(true);
      if (isErr(result) && result.error.type === "EXHAUSTED") {
        expect(result.error.attempts).toBe(2);
        expect((result.error.lastError as Error).message).toBe("always fails");
      }
    });

    it("should reject maxAttempts < 1", () => {
      expect(() => retry.fixed({ maxAttempts: 0, delay: ms(0) })).toThrow(/maxAttempts/);
    });

    it("should honor shouldRetry predicate", async () => {
      const clock = createControlledClock();
      const fn = vi.fn(async () => {
        throw new TypeError("not retryable");
      });

      const policy = retry.fixed({
        maxAttempts: 3,
        delay: ms(10),
        shouldRetry: (e) => !(e instanceof TypeError),
      });

      const result = await runWithRetry(fn, policy, clock);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.type).toBe("REJECTED");
        if (result.error.type === "REJECTED") {
          expect(result.error.attempts).toBe(1);
        }
      }
      // Only the first attempt runs — predicate rejected the retry.
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry.exponential", () => {
    it("should use exponential backoff with default factor 2", async () => {
      const clock = createControlledClock();
      const fn = vi.fn(async () => {
        throw new Error("fail");
      });

      const policy = retry.exponential({ maxAttempts: 4, initialDelay: ms(100) });
      const promise = runWithRetry(fn, policy, clock);

      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);

      clock.advanceBy(ms(100));
      await clock.flush();
      expect(fn).toHaveBeenCalledTimes(2);

      // Second delay: 200ms
      clock.advanceBy(ms(200));
      await clock.flush();
      expect(fn).toHaveBeenCalledTimes(3);

      // Third delay: 400ms
      clock.advanceBy(ms(400));
      await clock.flush();
      expect(fn).toHaveBeenCalledTimes(4);

      const result = await promise;
      expect(isErr(result)).toBe(true);
    });

    it("should cap at maxDelay", async () => {
      const clock = createControlledClock();
      const fn = vi.fn(async () => {
        throw new Error("fail");
      });

      const policy = retry.exponential({
        maxAttempts: 5,
        initialDelay: ms(100),
        maxDelay: ms(300),
      });
      const promise = runWithRetry(fn, policy, clock);

      await Promise.resolve();
      // Delay schedule: 100ms, 200ms, 300ms (capped), 300ms (capped)
      clock.advanceBy(ms(100));
      await clock.flush();
      expect(fn).toHaveBeenCalledTimes(2);

      clock.advanceBy(ms(200));
      await clock.flush();
      expect(fn).toHaveBeenCalledTimes(3);

      clock.advanceBy(ms(300));
      await clock.flush();
      expect(fn).toHaveBeenCalledTimes(4);

      clock.advanceBy(ms(300));
      await clock.flush();
      expect(fn).toHaveBeenCalledTimes(5);

      const result = await promise;
      expect(isErr(result)).toBe(true);
    });

    it("should reject factor < 1", () => {
      expect(() => retry.exponential({ maxAttempts: 3, initialDelay: ms(10), factor: 0.5 })).toThrow(/factor/);
    });

    it("should reject jitter out of [0, 1]", () => {
      expect(() => retry.exponential({ maxAttempts: 3, initialDelay: ms(10), jitter: 1.5 })).toThrow(/jitter/);
    });
  });

  describe("signal abort", () => {
    it("should return ABORTED when signal aborts before first attempt", async () => {
      const clock = createControlledClock();
      const controller = new AbortController();
      controller.abort();

      const fn = vi.fn(async () => "never-reached");

      const result = await runWithRetry(fn, retry.fixed({ maxAttempts: 3, delay: ms(10) }), clock, {
        signal: controller.signal,
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.type).toBe("ABORTED");
      expect(fn).not.toHaveBeenCalled();
    });

    it("should return ABORTED if signal aborts during inter-attempt wait", async () => {
      const clock = createControlledClock();
      const controller = new AbortController();
      const fn = vi.fn(async () => {
        throw new Error("fail");
      });

      const promise = runWithRetry(fn, retry.fixed({ maxAttempts: 3, delay: ms(100) }), clock, {
        signal: controller.signal,
      });

      // First attempt runs, then we abort during the wait.
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);

      controller.abort();

      const result = await promise;
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.type).toBe("ABORTED");

      // The second attempt never starts — we aborted first.
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("delay function", () => {
    it("should return 0 for attempt 1 (first attempt has no delay)", () => {
      const policy = retry.exponential({ maxAttempts: 5, initialDelay: ms(100) });
      expect(policy.delay(1)).toBe(0);
    });

    it("should return initialDelay for attempt 2", () => {
      const policy = retry.exponential({ maxAttempts: 5, initialDelay: ms(100) });
      expect(policy.delay(2)).toBe(100);
    });

    it("should apply exponential growth for later attempts", () => {
      const policy = retry.exponential({
        maxAttempts: 5,
        initialDelay: ms(100),
        factor: 2,
      });
      expect(policy.delay(3)).toBe(200);
      expect(policy.delay(4)).toBe(400);
    });
  });
});

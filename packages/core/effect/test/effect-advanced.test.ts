import { describe, it, expect, beforeEach } from "vitest";
import { effect, succeed, fail, sleep } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

interface EffectEvent {
  type: string;
  [key: string]: unknown;
}

describe("Effect Advanced Features - Timeout, Retry, Interruption", () => {
  let events: unknown[] = [];
  const emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("timeout: Deadline enforcement", () => {
    it("should complete normally if within timeout", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const fastEffect = effect(async (env) => {
        await sleep(50).unsafeRunPromise({ clock: env.clock });
        return { _tag: "Ok", value: "completed" };
      }).timeout(100);

      const resultPromise = fastEffect.unsafeRunPromise({ clock });
      clock.advanceBy(50);

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Ok", value: "completed" });
    });

    it("should timeout if operation takes too long", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const slowEffect = effect(async (env) => {
        await sleep(200).unsafeRunPromise({ clock: env.clock });
        return { _tag: "Ok", value: "should not complete" };
      }).timeout(100);

      const resultPromise = slowEffect.unsafeRunPromise({ clock });
      clock.advanceBy(100);

      const result = await resultPromise;

      expect(result).toEqual({
        _tag: "Err",
        error: { _tag: "Timeout" },
      });
    });

    it("should emit timeout events", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      const slowEffect = effect(
        async (env) => {
          await sleep(200).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "slow" };
        },
        { emit },
      ).timeout(100);

      const resultPromise = slowEffect.unsafeRunPromise({ clock });
      clock.advanceBy(100);

      await resultPromise;

      const timeoutEvents = events.filter((e: EffectEvent) => e.type?.includes("timeout"));
      expect(timeoutEvents.length).toBeGreaterThan(0);

      const startEvent = events.find((e: EffectEvent) => e.type === "effect:timeout:start") as EffectEvent;
      expect(startEvent).toBeDefined();
      expect(startEvent.timeoutMs).toBe(100);
      expect(startEvent.timestamp).toBe(1000);

      const triggeredEvent = events.find((e: EffectEvent) => e.type === "effect:timeout:triggered") as EffectEvent;
      expect(triggeredEvent).toBeDefined();
      expect(triggeredEvent.timestamp).toBe(1100);
    });

    it("should cleanup timeout when effect completes early", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const fastEffect = effect(async (env) => {
        await sleep(30).unsafeRunPromise({ clock: env.clock });
        return { _tag: "Ok", value: "fast" };
      }).timeout(100);

      const resultPromise = fastEffect.unsafeRunPromise({ clock });
      clock.advanceBy(30);

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Ok", value: "fast" });

      // Advance more time - timeout should not trigger
      clock.advanceBy(100);
      // If cleanup worked properly, no additional timeout effects should occur
    });
  });

  describe("retry: Automatic retry with backoff", () => {
    it("should retry failing effects according to policy", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let attempts = 0;

      const flakyEffect = effect(async () => {
        attempts++;
        if (attempts < 3) {
          return { _tag: "Err", error: `Attempt ${attempts} failed` };
        }
        return { _tag: "Ok", value: "Success!" };
      }).retry({
        maxAttempts: 5,
        baseDelayMs: 100,
        backoffFactor: 2,
      });

      const resultPromise = flakyEffect.unsafeRunPromise({ clock });

      // Advance through retries
      // Attempt 1: immediate failure
      await clock.flush();
      // Delay 1: 100ms
      clock.advanceBy(100);
      await clock.flush();
      // Attempt 2: failure
      // Delay 2: 200ms
      clock.advanceBy(200);
      await clock.flush();
      // Attempt 3: success

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Ok", value: "Success!" });
      expect(attempts).toBe(3);
    });

    it("should respect maxAttempts limit", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let attempts = 0;

      const alwaysFailingEffect = effect(async () => {
        attempts++;
        return { _tag: "Err", error: `Attempt ${attempts} failed` };
      }).retry({
        maxAttempts: 3,
        baseDelayMs: 10,
      });

      const resultPromise = alwaysFailingEffect.unsafeRunPromise({ clock });

      // Advance through all retries
      await clock.flush();
      clock.advanceBy(10);
      await clock.flush();
      clock.advanceBy(10);
      await clock.flush();
      clock.advanceBy(10);
      await clock.flush();

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Err", error: "Attempt 3 failed" });
      expect(attempts).toBe(3);
    });

    it("should apply exponential backoff correctly", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let attempts = 0;
      const timestamps: number[] = [];

      const flakyEffect = effect(async (env) => {
        attempts++;
        timestamps.push(env.clock?.now().wallMs ?? 0);
        return { _tag: "Err", error: `Attempt ${attempts}` };
      }).retry({
        maxAttempts: 4,
        baseDelayMs: 100,
        backoffFactor: 2,
      });

      const resultPromise = flakyEffect.unsafeRunPromise({ clock });

      // Manually advance through each retry delay
      await clock.flush(); // Attempt 1: t=0
      clock.advanceBy(100); // Delay 100ms, Attempt 2: t=100
      await clock.flush();
      clock.advanceBy(200); // Delay 200ms, Attempt 3: t=300
      await clock.flush();
      clock.advanceBy(400); // Delay 400ms, Attempt 4: t=700
      await clock.flush();

      await resultPromise;

      expect(timestamps).toEqual([0, 100, 300, 700]);
    });

    it("should respect maxDelayMs cap", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let attempts = 0;

      const flakyEffect = effect(async () => {
        attempts++;
        return { _tag: "Err", error: `Attempt ${attempts}` };
      }).retry({
        maxAttempts: 5,
        baseDelayMs: 100,
        backoffFactor: 3,
        maxDelayMs: 250,
      });

      const resultPromise = flakyEffect.unsafeRunPromise({ clock });

      // Delays should be: 100, 250 (capped), 250 (capped), 250 (capped)
      await clock.flush(); // Attempt 1
      clock.advanceBy(100); // Attempt 2
      await clock.flush();
      clock.advanceBy(250); // Attempt 3 (would be 300, but capped at 250)
      await clock.flush();
      clock.advanceBy(250); // Attempt 4 (would be 900, but capped at 250)
      await clock.flush();
      clock.advanceBy(250); // Attempt 5 (would be 2700, but capped at 250)
      await clock.flush();

      await resultPromise;

      expect(attempts).toBe(5);
    });

    it("should emit retry events", async () => {
      const clock = createControlledClock({ initialTime: 1000 });
      let attempts = 0;

      const flakyEffect = effect(
        async () => {
          attempts++;
          if (attempts < 3) {
            return { _tag: "Err", error: "failed" };
          }
          return { _tag: "Ok", value: "success" };
        },
        { emit },
      ).retry({
        maxAttempts: 3,
        baseDelayMs: 100,
        backoffFactor: 1, // No exponential backoff for this test
      });

      const resultPromise = flakyEffect.unsafeRunPromise({ clock });

      await clock.flush();
      clock.advanceBy(100); // First retry delay
      await clock.flush();
      clock.advanceBy(100); // Second retry delay (no backoff factor, so still 100ms)
      await clock.flush();

      await resultPromise;

      const retryAttempts = events.filter((e: EffectEvent) => e.type === "effect:retry:attempt");
      const retryDelays = events.filter((e: EffectEvent) => e.type === "effect:retry:delay");
      const retrySuccess = events.filter((e: EffectEvent) => e.type === "effect:retry:success");

      expect(retryAttempts).toHaveLength(3);
      expect(retryDelays).toHaveLength(2); // Only delays between attempts
      expect(retrySuccess).toHaveLength(1);
    });

    it("should stop retrying if cancelled", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let attempts = 0;

      const retryingEffect = effect(async (env) => {
        attempts++;
        if (env.cancel.isCanceled()) {
          return { _tag: "Err", error: { _tag: "Interrupted" } };
        }
        return { _tag: "Err", error: "keep failing" };
      }).retry({
        maxAttempts: 10,
        baseDelayMs: 100,
      });

      const fiberResult = await retryingEffect.fork().unsafeRunPromise({ clock });
      const fiber = fiberResult.value;

      // Let it try a few times
      clock.advanceBy(50); // First attempt
      clock.advanceBy(100); // First delay + second attempt

      // Interrupt it
      await fiber.interrupt().unsafeRunPromise({ clock });

      const result = await fiber.join().unsafeRunPromise({ clock });

      expect(result).toEqual({ _tag: "Err", error: { _tag: "Interrupted" } });
      expect(attempts).toBeLessThan(10); // Should not have tried all attempts
    });
  });

  describe("onInterrupt: Cleanup on cancellation", () => {
    it("should run cleanup when effect is interrupted", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const cleanupActions: string[] = [];

      const interruptibleEffect = effect(async (env) => {
        // Long running operation
        for (let i = 0; i < 10; i++) {
          if (env.cancel.isCanceled()) {
            return { _tag: "Err", error: "Cancelled" };
          }
          await sleep(100).unsafeRunPromise({ clock: env.clock });
        }
        return { _tag: "Ok", value: "completed" };
      }).onInterrupt(() =>
        effect(async () => {
          cleanupActions.push("cleanup executed");
          return { _tag: "Ok", value: undefined };
        }),
      );

      const fiberResult = await interruptibleEffect.fork().unsafeRunPromise({ clock });
      const fiber = fiberResult.value;

      // Let it run a bit
      clock.advanceBy(250);

      // Interrupt it
      await fiber.interrupt().unsafeRunPromise({ clock });

      expect(cleanupActions).toContain("cleanup executed");
    });

    it("should not run cleanup if effect completes normally", async () => {
      const cleanupActions: string[] = [];

      const normalEffect = succeed("normal result").onInterrupt(() =>
        effect(async () => {
          cleanupActions.push("should not happen");
          return { _tag: "Ok", value: undefined };
        }),
      );

      const result = await normalEffect.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Ok", value: "normal result" });
      expect(cleanupActions).toHaveLength(0);
    });

    it("should not run cleanup if effect fails normally", async () => {
      const cleanupActions: string[] = [];

      const failingEffect = fail("normal error").onInterrupt(() =>
        effect(async () => {
          cleanupActions.push("should not happen");
          return { _tag: "Ok", value: undefined };
        }),
      );

      const result = await failingEffect.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Err", error: "normal error" });
      expect(cleanupActions).toHaveLength(0);
    });

    it("should handle cleanup errors gracefully", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const interruptibleEffect = effect(async (env) => {
        await sleep(1000).unsafeRunPromise({ clock: env.clock });
        return { _tag: "Ok", value: "should not complete" };
      }).onInterrupt(() =>
        effect(async () => {
          throw new Error("cleanup failed");
        }),
      );

      const fiberResult = await interruptibleEffect.fork().unsafeRunPromise({ clock });
      const fiber = fiberResult.value;

      clock.advanceBy(100);

      // Should not throw despite cleanup failure
      await expect(fiber.interrupt().unsafeRunPromise({ clock })).resolves.not.toThrow();
    });
  });
});

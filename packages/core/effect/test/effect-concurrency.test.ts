import { describe, it, expect, beforeEach } from "vitest";
import { effect, all, race, sleep } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Effect Concurrency - Structured Concurrency", () => {
  let events: unknown[] = [];
  const _emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("fork: Structured concurrency", () => {
    it("should create a fiber that can be joined", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const eff = effect(async (env) => {
        await sleep(100).unsafeRunPromise({ clock: env.clock });
        return { _tag: "Ok", value: "completed" };
      });

      const fiberEffect = eff.fork();
      const fiberResult = await fiberEffect.unsafeRunPromise({ clock });

      expect(fiberResult._tag).toBe("Ok");
      const fiber = fiberResult.value;

      // Advance time to complete the forked effect
      clock.advanceBy(100);

      const joinResult = await fiber.join().unsafeRunPromise({ clock });
      expect(joinResult).toEqual({ _tag: "Ok", value: "completed" });
    });

    it("should allow interrupting fibers", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let completed = false;

      const longRunning = effect(async (env) => {
        // Check cancellation periodically
        for (let i = 0; i < 10; i++) {
          if (env.cancel.isCanceled()) {
            return { _tag: "Err", error: "Cancelled" };
          }
          await sleep(100).unsafeRunPromise({ clock: env.clock });
        }
        completed = true;
        return { _tag: "Ok", value: "completed" };
      });

      const fiberResult = await longRunning.fork().unsafeRunPromise({ clock });
      const fiber = fiberResult.value;

      // Let it run a bit
      clock.advanceBy(250);

      // Interrupt it
      const interruptResult = await fiber.interrupt().unsafeRunPromise({ clock });
      expect(interruptResult._tag).toBe("Ok");

      // It should not have completed
      expect(completed).toBe(false);
    });

    it("should allow polling fiber status", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const eff = effect(async (env) => {
        await sleep(100).unsafeRunPromise({ clock: env.clock });
        return { _tag: "Ok", value: "done" };
      });

      const fiberResult = await eff.fork().unsafeRunPromise({ clock });
      const fiber = fiberResult.value;

      // Should be running initially
      const poll1 = await fiber.poll().unsafeRunPromise({ clock });
      expect(poll1).toEqual({ _tag: "Ok", value: undefined });

      // Complete the work
      clock.advanceBy(100);

      // Flush microtasks to ensure result is stored
      await clock.flush();

      // Should be completed now
      const poll2 = await fiber.poll().unsafeRunPromise({ clock });
      expect(poll2).toEqual({ _tag: "Ok", value: { _tag: "Ok", value: "done" } });
    });
  });

  describe("all: Parallel execution", () => {
    it("should run all effects in parallel and collect results", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const effects = [
        effect(async (env) => {
          await sleep(100).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "first" };
        }),
        effect(async (env) => {
          await sleep(50).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "second" };
        }),
        effect(async (env) => {
          await sleep(75).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "third" };
        }),
      ];

      const allEffect = all(effects);

      // Start execution
      const resultPromise = allEffect.unsafeRunPromise({ clock });

      // Advance time to complete all
      clock.advanceBy(100);

      const result = await resultPromise;

      expect(result).toEqual({
        _tag: "Ok",
        value: ["first", "second", "third"],
      });
    });

    it("should fail fast if any effect fails", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let thirdCompleted = false;

      const effects = [
        effect(async (env) => {
          await sleep(100).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "first" };
        }),
        effect(async (env) => {
          await sleep(50).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Err", error: "second failed" };
        }),
        effect(async (env) => {
          await sleep(200).unsafeRunPromise({ clock: env.clock });
          thirdCompleted = true;
          return { _tag: "Ok", value: "third" };
        }),
      ];

      const allEffect = all(effects);

      // Start execution
      const resultPromise = allEffect.unsafeRunPromise({ clock });

      // Advance enough for the failing effect
      clock.advanceBy(50);

      // Flush microtasks
      await clock.flush();

      const result = await resultPromise;

      expect(result).toEqual({
        _tag: "Err",
        error: "second failed",
      });

      // Third effect should not have completed due to early termination
      expect(thirdCompleted).toBe(false);
    });

    it("should handle empty array", async () => {
      const result = await all([]).unsafeRunPromise();

      expect(result).toEqual({
        _tag: "Ok",
        value: [],
      });
    });
  });

  describe("race: Competitive execution", () => {
    it("should return result of first completing effect", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const effects = [
        effect(async (env) => {
          await sleep(100).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "slow" };
        }),
        effect(async (env) => {
          await sleep(30).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "fast" };
        }),
        effect(async (env) => {
          await sleep(200).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "slowest" };
        }),
      ];

      const raceEffect = race(effects);

      // Start execution
      const resultPromise = raceEffect.unsafeRunPromise({ clock });

      // Advance time to let the fastest complete
      clock.advanceBy(30);

      const result = await resultPromise;

      expect(result).toEqual({
        _tag: "Ok",
        value: "fast",
      });
    });

    it("should cancel losing effects", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let slowCompleted = false;
      let slowestCompleted = false;

      const effects = [
        effect(async (env) => {
          await sleep(100).unsafeRunPromise({ clock: env.clock });
          slowCompleted = true;
          return { _tag: "Ok", value: "slow" };
        }),
        effect(async (env) => {
          await sleep(30).unsafeRunPromise({ clock: env.clock });
          return { _tag: "Ok", value: "fast" };
        }),
        effect(async (env) => {
          await sleep(200).unsafeRunPromise({ clock: env.clock });
          slowestCompleted = true;
          return { _tag: "Ok", value: "slowest" };
        }),
      ];

      const raceEffect = race(effects);

      // Start execution
      const resultPromise = raceEffect.unsafeRunPromise({ clock });

      // Advance time to complete the winner
      clock.advanceBy(30);

      await resultPromise;

      // Losers should not complete even if we advance time further
      clock.advanceBy(200);

      expect(slowCompleted).toBe(false);
      expect(slowestCompleted).toBe(false);
    });

    it("should handle empty array by hanging forever", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const raceEffect = race([]);

      // Start execution but don't await - it should hang
      const resultPromise = raceEffect.unsafeRunPromise({ clock });

      // Advance time significantly
      clock.advanceBy(10000);

      // Promise should still be pending
      let resolved = false;
      resultPromise.then(() => (resolved = true));

      // Give it a tick
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(resolved).toBe(false);
    });

    it("should handle single effect", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const singleEffect = effect(async (env) => {
        await sleep(50).unsafeRunPromise({ clock: env.clock });
        return { _tag: "Ok", value: "only one" };
      });

      const raceEffect = race([singleEffect]);

      const resultPromise = raceEffect.unsafeRunPromise({ clock });
      clock.advanceBy(50);

      const result = await resultPromise;

      expect(result).toEqual({
        _tag: "Ok",
        value: "only one",
      });
    });
  });

  describe("sleep: Time-based effects", () => {
    it("should delay execution by specified time", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      const delayedEffect = effect(async (env) => {
        const start = env.clock?.now().wallMs ?? 0;
        await sleep(500).unsafeRunPromise({ clock: env.clock });
        const end = env.clock?.now().wallMs ?? 0;

        return { _tag: "Ok", value: end - start };
      });

      const resultPromise = delayedEffect.unsafeRunPromise({ clock });

      // Advance time
      clock.advanceBy(500);

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Ok", value: 500 });
    });

    it("should respect cancellation", async () => {
      const clock = createControlledClock({ initialTime: 0 });

      const sleepEffect = sleep(1000);

      const fiberResult = await sleepEffect.fork().unsafeRunPromise({ clock });
      const fiber = fiberResult.value;

      // Let it start sleeping
      clock.advanceBy(100);

      // Interrupt it
      await fiber.interrupt().unsafeRunPromise({ clock });

      // It should complete without waiting for the full duration
      const joinResult = await fiber.join().unsafeRunPromise({ clock });
      expect(joinResult._tag).toBe("Ok");
    });
  });
});

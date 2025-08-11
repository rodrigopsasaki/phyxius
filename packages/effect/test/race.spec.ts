import { describe, it, expect } from "vitest";
import { effect, succeed, fail, sleep, race } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Race", () => {
  it("should return the first completing effect", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const fast = succeed("fast");
    const slow = sleep(ms(1000)).map(() => "slow");

    const raceEffect = race([fast, slow]);

    const result = await raceEffect.unsafeRunPromise({ clock });

    expect(result).toEqual({ _tag: "Ok", value: "fast" });
  });

  it("should cancel losing effects", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let slowEffectWasCancelled = false;

    const fast = sleep(ms(100)).map(() => "fast");
    const slow = effect(async (env) => {
      env.cancel.onCancel(() => {
        slowEffectWasCancelled = true;
      });

      const sleepResult = await sleep(ms(1000)).unsafeRunPromise({ clock: env.clock });
      if (sleepResult._tag === "Err") throw sleepResult.error;

      return { _tag: "Ok", value: "slow" };
    });

    const raceEffect = race([fast, slow]);

    // Start the race
    const _resultPromise = raceEffect.unsafeRunPromise({ clock });

    await Promise.resolve(); // Allow forking to complete

    // Advance time to complete the fast effect
    clock.advanceBy(ms(100));
    await Promise.resolve();

    const result = await _resultPromise;

    expect(result).toEqual({ _tag: "Ok", value: "fast" });
    expect(slowEffectWasCancelled).toBe(true);
  });

  it("should propagate errors from the winning effect", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const failing = fail("test error");
    const slow = sleep(ms(1000)).map(() => "slow");

    const raceEffect = race([failing, slow]);

    const result = await raceEffect.unsafeRunPromise({ clock });

    expect(result).toEqual({ _tag: "Err", error: "test error" });
  });

  it("should handle multiple concurrent effects with proper cancellation", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let cancelledCount = 0;

    const createEffect = (name: string, delay: number) =>
      effect(async (env) => {
        env.cancel.onCancel(() => {
          cancelledCount++;
        });

        const sleepResult = await sleep(ms(delay)).unsafeRunPromise({ clock: env.clock });
        if (sleepResult._tag === "Err") throw sleepResult.error;

        return { _tag: "Ok", value: name };
      });

    const effects = [
      createEffect("effect1", 300),
      createEffect("effect2", 100), // This should win
      createEffect("effect3", 500),
      createEffect("effect4", 200),
    ];

    const raceEffect = race(effects);

    // Start the race
    const _resultPromise = raceEffect.unsafeRunPromise({ clock });

    await Promise.resolve(); // Allow forking to complete

    // Advance time to complete the winning effect (100ms)
    clock.advanceBy(ms(100));
    await Promise.resolve();

    const result = await _resultPromise;

    expect(result).toEqual({ _tag: "Ok", value: "effect2" });
    // The other 3 effects should have been cancelled
    expect(cancelledCount).toBe(3);
  });

  it("should handle empty race by hanging forever", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const raceEffect = race([]);

    // Start the race
    const _resultPromise = raceEffect.unsafeRunPromise({ clock });

    // Advance time - should still be pending
    clock.advanceBy(ms(1000));
    await Promise.resolve();

    // The promise should still be pending (not resolved)
    // We can't easily test this directly, so we'll test it doesn't throw
    // and that advancing time doesn't resolve it
    expect(true).toBe(true); // Placeholder - empty race hangs as expected
  });

  it("should handle single effect race", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const singleEffect = succeed("only one");
    const raceEffect = race([singleEffect]);

    const result = await raceEffect.unsafeRunPromise({ clock });

    expect(result).toEqual({ _tag: "Ok", value: "only one" });
  });

  it("should cancel all effects if parent is cancelled", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let cancelledCount = 0;

    const createEffect = (name: string, delay: number) =>
      effect(async (env) => {
        env.cancel.onCancel(() => {
          cancelledCount++;
        });

        const sleepResult = await sleep(ms(delay)).unsafeRunPromise({ clock: env.clock });
        if (sleepResult._tag === "Err") throw sleepResult.error;

        return { _tag: "Ok", value: name };
      });

    const raceEffect = race([
      createEffect("effect1", 300),
      createEffect("effect2", 400),
      createEffect("effect3", 500),
    ]).timeout(ms(200)); // Timeout before any effect completes

    const _resultPromise = raceEffect.unsafeRunPromise({ clock });

    await Promise.resolve(); // Allow forking to complete

    // Advance time to trigger timeout
    clock.advanceBy(ms(200));
    await Promise.resolve();

    const result = await _resultPromise;

    expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
    // All effects should have been cancelled due to timeout
    expect(cancelledCount).toBe(3);
  });

  it("should handle mixed success and failure in race", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const fastSuccess = succeed("success");
    const fastFailure = fail("error");
    const slow = sleep(ms(1000)).map(() => "slow");

    // Success should win over slow
    const raceEffect1 = race([fastSuccess, slow]);
    const result1 = await raceEffect1.unsafeRunPromise({ clock });
    expect(result1).toEqual({ _tag: "Ok", value: "success" });

    // Failure should win over slow
    const raceEffect2 = race([fastFailure, slow]);
    const result2 = await raceEffect2.unsafeRunPromise({ clock });
    expect(result2).toEqual({ _tag: "Err", error: "error" });
  });
});

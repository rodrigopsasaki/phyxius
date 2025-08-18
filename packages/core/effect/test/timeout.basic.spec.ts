import { describe, it, expect } from "vitest";
import { effect, sleep, succeed } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Effect Timeout Basic", () => {
  it("should timeout when effect takes longer than specified duration", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    // Create effect that sleeps for 1000ms with 500ms timeout
    const timeoutEffect = sleep(ms(1000)).timeout(ms(500));

    const resultPromise = timeoutEffect.unsafeRunPromise({ clock });

    // Allow execution to start
    await new Promise((resolve) => setImmediate(resolve));

    // Advance to timeout
    clock.advanceBy(ms(500));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
  });

  it("should not timeout when effect completes before timeout", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    // Create effect that completes quickly with longer timeout
    const quickEffect = succeed("fast").timeout(ms(1000));

    const result = await quickEffect.unsafeRunPromise({ clock });

    expect(result).toEqual({ _tag: "Ok", value: "fast" });
  });

  it("should handle timeout with effect chains", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    // Create effect chain that includes a slow operation
    const chainedEffect = succeed("start")
      .flatMap(() => sleep(ms(800)))
      .map(() => "completed")
      .timeout(ms(500));

    const resultPromise = chainedEffect.unsafeRunPromise({ clock });

    // Allow execution to start
    await new Promise((resolve) => setImmediate(resolve));

    // Advance to timeout (before sleep completes)
    clock.advanceBy(ms(500));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
  });

  it("should properly clean up when timeout occurs", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let cleanupCalled = false;

    const effectWithCleanup = effect(async (env) => {
      // Register cleanup
      env.scope.push(() => {
        cleanupCalled = true;
      });

      // Sleep longer than timeout
      const sleepResult = await sleep(ms(1000)).unsafeRunPromise({ clock: env.clock });
      if (sleepResult._tag === "Err") throw sleepResult.error;

      return { _tag: "Ok", value: "completed" };
    }).timeout(ms(500));

    const resultPromise = effectWithCleanup.unsafeRunPromise({ clock });

    // Allow execution to start
    await new Promise((resolve) => setImmediate(resolve));

    // Advance to timeout
    clock.advanceBy(ms(500));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
    expect(cleanupCalled).toBe(true);
  });
});

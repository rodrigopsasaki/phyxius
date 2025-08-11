import { describe, it, expect } from "vitest";
import { effect, sleep } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Effect Sleep Deterministic", () => {
  it("should use ControlledClock and not perform real waiting", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const startTime = Date.now();

    // Create effect that sleeps for 1 second using controlled clock
    const sleepEffect = sleep(ms(1000)).withContext("clock", clock);

    // Start the sleep in background
    const sleepPromise = sleepEffect.run();

    // Advance clock immediately - no real waiting should occur
    clock.advanceBy(ms(1000));

    // Sleep should complete immediately after clock advance
    await sleepPromise;

    const endTime = Date.now();
    const realTimeElapsed = endTime - startTime;

    // Should complete in much less than 1 second (no real waiting)
    expect(realTimeElapsed).toBeLessThan(100); // Allow for test overhead
  });

  it("should respect sleep duration with controlled time", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: Array<{ type: string; time: number }> = [];

    const testEffect = effect(async (context) => {
      const clockFromContext = context.get<typeof clock>("clock");
      events.push({ type: "start", time: clockFromContext?.now().monoMs ?? 0 });

      await sleep(ms(500)).withContext("clock", clock).run(context);
      events.push({ type: "after-500ms", time: clockFromContext?.now().monoMs ?? 0 });

      await sleep(ms(300)).withContext("clock", clock).run(context);
      events.push({ type: "after-800ms", time: clockFromContext?.now().monoMs ?? 0 });

      return "done";
    }).withContext("clock", clock);

    // Start the effect
    const resultPromise = testEffect.run();

    // Allow initial execution to start
    await new Promise((resolve) => setImmediate(resolve));

    // Advance time in steps
    clock.advanceBy(ms(500));
    await new Promise((resolve) => setImmediate(resolve));

    clock.advanceBy(ms(300));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("done");
    expect(events).toEqual([
      { type: "start", time: 0 },
      { type: "after-500ms", time: 500 },
      { type: "after-800ms", time: 800 },
    ]);
  });

  it("should handle concurrent sleeps with different durations", async () => {
    const clock = createControlledClock({ initialTime: 100 });
    const completionOrder: number[] = [];

    const sleepEffects = [
      sleep(ms(200))
        .map(() => {
          completionOrder.push(1);
          return 1;
        })
        .withContext("clock", clock),
      sleep(ms(100))
        .map(() => {
          completionOrder.push(2);
          return 2;
        })
        .withContext("clock", clock),
      sleep(ms(300))
        .map(() => {
          completionOrder.push(3);
          return 3;
        })
        .withContext("clock", clock),
    ];

    // Start all sleeps
    const promises = sleepEffects.map((effect) => effect.run());

    // Advance time incrementally
    clock.advanceBy(ms(100));
    await Promise.resolve();

    clock.advanceBy(ms(100));
    await Promise.resolve();

    clock.advanceBy(ms(100));
    await Promise.resolve();

    await Promise.all(promises);

    // Should complete in order of duration: 100ms, 200ms, 300ms
    expect(completionOrder).toEqual([2, 1, 3]);
  });

  it("should integrate with effect cancellation", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let sleepCompleted = false;

    const cancellableEffect = effect(async (context) => {
      try {
        await sleep(ms(1000)).withContext("clock", clock).run(context);
        sleepCompleted = true;
        return "completed";
      } catch (error) {
        if (error instanceof Error && error.message.includes("cancelled")) {
          return "cancelled";
        }
        throw error;
      }
    })
      .withContext("clock", clock)
      .timeout(500);

    // Start effect with timeout shorter than sleep
    const resultPromise = cancellableEffect.run();

    // Advance time to trigger timeout (but not complete sleep)
    clock.advanceBy(ms(500));

    const result = await resultPromise.catch(() => "timed-out");

    expect(sleepCompleted).toBe(false);
    expect(result).toBe("timed-out");
  });

  it("should maintain monotonic sleep ordering", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const sleepTimes: Array<{ requested: number; actual: number }> = [];

    const testEffect = effect(async (context) => {
      const clockFromContext = context.get<typeof clock>("clock");

      const durations = [100, 50, 200, 25];

      for (const duration of durations) {
        const startTime = clockFromContext?.now().monoMs ?? 0;
        await sleep(ms(duration)).withContext("clock", clock).run(context);
        const endTime = clockFromContext?.now().monoMs ?? 0;

        sleepTimes.push({
          requested: duration,
          actual: endTime - startTime,
        });
      }

      return sleepTimes;
    }).withContext("clock", clock);

    // Run with automatic time advancement
    const resultPromise = testEffect.run();

    // Allow initial execution to start
    await new Promise((resolve) => setImmediate(resolve));

    // Advance time to cover all sleeps
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    clock.advanceBy(ms(200));
    await new Promise((resolve) => setImmediate(resolve));

    clock.advanceBy(ms(25));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toEqual([
      { requested: 100, actual: 100 },
      { requested: 50, actual: 50 },
      { requested: 200, actual: 200 },
      { requested: 25, actual: 25 },
    ]);
  });
});

import { describe, it, expect } from "vitest";
import { effect, sleep, fail } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Effect Cancellation Basic", () => {
  it("should cancel effect when timeout is reached", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let effectCompleted = false;

    const longRunningEffect = effect(async (context) => {
      await sleep(ms(1000)).withContext("clock", clock).run(context);
      effectCompleted = true;
      return "completed";
    })
      .withContext("clock", clock)
      .timeout(500);

    const resultPromise = longRunningEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Advance time to trigger timeout (500ms)
    clock.advanceBy(ms(500));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Effect should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 500ms/i);
    }

    expect(effectCompleted).toBe(false);
  });

  it("should propagate cancellation through nested effects", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const executionOrder: string[] = [];

    const innerEffect = effect(async (context) => {
      executionOrder.push("inner-start");
      await sleep(ms(800)).withContext("clock", clock).run(context);
      executionOrder.push("inner-end");
      return "inner-done";
    }).withContext("clock", clock);

    const outerEffect = effect(async (context) => {
      executionOrder.push("outer-start");
      const result = await innerEffect.run(context);
      executionOrder.push("outer-end");
      return result;
    })
      .withContext("clock", clock)
      .timeout(400);

    const resultPromise = outerEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Advance time to trigger timeout before inner effect completes
    clock.advanceBy(ms(400));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Effect should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 400ms/i);
    }

    // Neither inner nor outer effect should complete
    expect(executionOrder).toEqual(["outer-start", "inner-start"]);
  });

  it("should handle cancellation during effect chain", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const steps: string[] = [];

    const slowEffect = effect(async (context) => {
      steps.push("step1");
      await sleep(ms(200)).withContext("clock", clock).run(context);
      steps.push("step2");
      return "intermediate";
    }).withContext("clock", clock);

    const chainedEffect = slowEffect
      .map(() => {
        steps.push("step3");
        return "mapped";
      })
      .timeout(100);

    const resultPromise = chainedEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Advance time to trigger timeout before step2
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Effect should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 100ms/i);
    }

    // Should only complete step1, not step2 or step3
    expect(steps).toEqual(["step1"]);
  });

  it("should timeout when effect takes longer than specified duration", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let effectStarted = false;
    let effectFinished = false;

    const cancellableEffect = effect(async (context) => {
      effectStarted = true;
      // Long-running operation that will be timed out
      await sleep(ms(1000)).withContext("clock", clock).run(context);
      effectFinished = true;
      return "success";
    })
      .withContext("clock", clock)
      .timeout(300);

    const resultPromise = cancellableEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Trigger timeout
    clock.advanceBy(ms(300));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Effect should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 300ms/i);
    }

    expect(effectStarted).toBe(true);
    expect(effectFinished).toBe(false);
  });

  it("should not cancel already completed effects", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const fastEffect = effect(async (context) => {
      await sleep(ms(50)).withContext("clock", clock).run(context);
      return "fast-result";
    })
      .withContext("clock", clock)
      .timeout(200);

    const resultPromise = fastEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete the effect before timeout
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;
    expect(result).toBe("fast-result");

    // Continue advancing time past timeout - should not affect result
    clock.advanceBy(ms(200));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("should handle cancellation in flatMap chains", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const executionSteps: string[] = [];

    const firstEffect = effect(async (context) => {
      executionSteps.push("first");
      await sleep(ms(100)).withContext("clock", clock).run(context);
      return 42;
    }).withContext("clock", clock);

    const secondEffect = (value: number) =>
      effect(async (context) => {
        executionSteps.push(`second-${value}`);
        await sleep(ms(300)).withContext("clock", clock).run(context);
        return `result-${value}`;
      }).withContext("clock", clock);

    const chainedEffect = firstEffect.flatMap(secondEffect).timeout(250);

    const resultPromise = chainedEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete first effect
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    // Trigger timeout during second effect
    clock.advanceBy(ms(150));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Effect should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 250ms/i);
    }

    // First effect completes, second starts but doesn't finish
    expect(executionSteps).toEqual(["first", "second-42"]);
  });

  it("should handle cancellation with error recovery", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const steps: string[] = [];

    const failingEffect = fail(new Error("planned failure"));

    const recoveringEffect = failingEffect
      .catch((_error) => {
        steps.push("error-caught");
        return effect(async (context) => {
          steps.push("recovery-start");
          await sleep(ms(500)).withContext("clock", clock).run(context);
          steps.push("recovery-end");
          return "recovered";
        }).withContext("clock", clock);
      })
      .timeout(200);

    const resultPromise = recoveringEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Trigger timeout during recovery
    clock.advanceBy(ms(200));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Effect should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 200ms/i);
    }

    // Recovery starts but doesn't complete
    expect(steps).toEqual(["error-caught", "recovery-start"]);
  });

  it("should maintain cancellation semantics across effect combinators", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let effect1Completed = false;
    let effect2Completed = false;

    const effect1 = effect(async (context) => {
      await sleep(ms(400)).withContext("clock", clock).run(context);
      effect1Completed = true;
      return "effect1";
    }).withContext("clock", clock);

    const _effect2 = effect(async (context) => {
      await sleep(ms(600)).withContext("clock", clock).run(context);
      effect2Completed = true;
      return "effect2";
    }).withContext("clock", clock);

    // Use timeout shorter than both effects
    const combinedEffect = effect1.map((result) => result.toUpperCase()).timeout(200);

    const resultPromise = combinedEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Trigger timeout
    clock.advanceBy(ms(200));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Effect should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 200ms/i);
    }

    expect(effect1Completed).toBe(false);
    expect(effect2Completed).toBe(false);
  });
});

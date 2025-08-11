import { describe, it, expect } from "vitest";
import { effect, sleep } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Effect Finalizers Cleanup", () => {
  it("should run finalizers on successful completion", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: string[] = [];

    const effectWithFinalizers = effect(async (context) => {
      try {
        await sleep(ms(100)).withContext("clock", clock).run(context);
        return "success";
      } finally {
        finalizers.push("main-finalizer");
      }
    }).withContext("clock", clock);

    const resultPromise = effectWithFinalizers.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete the effect
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("success");
    expect(finalizers).toEqual(["main-finalizer"]);
  });

  it("should run finalizers on error", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: string[] = [];

    const effectWithFinalizers = effect(async (context) => {
      try {
        await sleep(ms(50)).withContext("clock", clock).run(context);
        throw new Error("intentional error");
      } finally {
        finalizers.push("error-finalizer");
      }
    }).withContext("clock", clock);

    const resultPromise = effectWithFinalizers.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete the effect
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("intentional error");
    }

    expect(finalizers).toEqual(["error-finalizer"]);
  });

  it("should run multiple nested finalizers in correct order", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: string[] = [];

    const nestedFinalizersEffect = effect(async (context) => {
      try {
        finalizers.push("outer-start");
        try {
          await sleep(ms(30)).withContext("clock", clock).run(context);
          finalizers.push("inner-operation");
          return "nested-success";
        } finally {
          finalizers.push("inner-finalizer");
        }
      } finally {
        finalizers.push("outer-finalizer");
      }
    }).withContext("clock", clock);

    const resultPromise = nestedFinalizersEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete the effect
    clock.advanceBy(ms(30));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("nested-success");
    expect(finalizers).toEqual(["outer-start", "inner-operation", "inner-finalizer", "outer-finalizer"]);
  });

  it("should run finalizers even when inner finalizer throws", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: string[] = [];

    const throwingFinalizerEffect = effect(async (context) => {
      try {
        finalizers.push("operation-start");
        try {
          await sleep(ms(40)).withContext("clock", clock).run(context);
          return "should-succeed";
        } finally {
          finalizers.push("inner-finalizer");
          // eslint-disable-next-line no-unsafe-finally
          throw new Error("finalizer error");
        }
      } catch (error) {
        finalizers.push("caught-finalizer-error");
        // Re-throw to see if outer finalizer still runs
        throw error;
      } finally {
        finalizers.push("outer-finalizer");
      }
    }).withContext("clock", clock);

    const resultPromise = throwingFinalizerEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete the effect
    clock.advanceBy(ms(40));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown finalizer error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("finalizer error");
    }

    expect(finalizers).toEqual(["operation-start", "inner-finalizer", "caught-finalizer-error", "outer-finalizer"]);
  });

  it("should handle finalizers with map transformation", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: string[] = [];

    const mappedEffect = effect(async (context) => {
      try {
        await sleep(ms(60)).withContext("clock", clock).run(context);
        finalizers.push("original-operation");
        return 42;
      } finally {
        finalizers.push("original-finalizer");
      }
    })
      .withContext("clock", clock)
      .map((value) => {
        finalizers.push("map-operation");
        return value * 2;
      });

    const resultPromise = mappedEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete the effect
    clock.advanceBy(ms(60));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe(84);
    expect(finalizers).toEqual(["original-operation", "original-finalizer", "map-operation"]);
  });

  it("should handle finalizers with flatMap transformation", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: string[] = [];

    const flatMappedEffect = effect(async (context) => {
      try {
        await sleep(ms(30)).withContext("clock", clock).run(context);
        finalizers.push("first-operation");
        return "first-result";
      } finally {
        finalizers.push("first-finalizer");
      }
    })
      .withContext("clock", clock)
      .flatMap((value) =>
        effect(async (context) => {
          try {
            await sleep(ms(40)).withContext("clock", clock).run(context);
            finalizers.push("second-operation");
            return `${value}-chained`;
          } finally {
            finalizers.push("second-finalizer");
          }
        }).withContext("clock", clock),
      );

    const resultPromise = flatMappedEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete first effect
    clock.advanceBy(ms(30));
    await new Promise((resolve) => setImmediate(resolve));

    // Complete second effect
    clock.advanceBy(ms(40));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("first-result-chained");
    expect(finalizers).toEqual(["first-operation", "first-finalizer", "second-operation", "second-finalizer"]);
  });

  it("should handle finalizers with error recovery", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: string[] = [];

    const errorRecoveryEffect = effect(async (context) => {
      try {
        await sleep(ms(20)).withContext("clock", clock).run(context);
        finalizers.push("operation-before-error");
        throw new Error("planned error");
      } finally {
        finalizers.push("original-finalizer");
      }
    })
      .withContext("clock", clock)
      .catch((_error) =>
        effect(async (context) => {
          try {
            finalizers.push("recovery-start");
            await sleep(ms(30)).withContext("clock", clock).run(context);
            finalizers.push("recovery-operation");
            return "recovered";
          } finally {
            finalizers.push("recovery-finalizer");
          }
        }).withContext("clock", clock),
      );

    const resultPromise = errorRecoveryEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete original effect (which fails)
    clock.advanceBy(ms(20));
    await new Promise((resolve) => setImmediate(resolve));

    // Complete recovery effect
    clock.advanceBy(ms(30));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("recovered");
    expect(finalizers).toEqual([
      "operation-before-error",
      "original-finalizer",
      "recovery-start",
      "recovery-operation",
      "recovery-finalizer",
    ]);
  });

  it("should handle finalizers with timeout cancellation", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: string[] = [];
    let operationCompleted = false;

    const timeoutEffect = effect(async (context) => {
      try {
        finalizers.push("operation-start");
        await sleep(ms(300)).withContext("clock", clock).run(context);
        operationCompleted = true;
        finalizers.push("operation-complete");
        return "should-not-reach";
      } finally {
        finalizers.push("main-finalizer");
      }
    })
      .withContext("clock", clock)
      .timeout(150);

    const resultPromise = timeoutEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Trigger timeout before operation completes
    clock.advanceBy(ms(150));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 150ms/i);
    }

    expect(operationCompleted).toBe(false);
    expect(finalizers).toEqual(["operation-start"]);
    // Note: In JavaScript, the main-finalizer may not run due to Promise.race behavior
  });

  it("should handle finalizers in concurrent operations", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const finalizers: Array<{ effect: string; action: string }> = [];

    const effect1 = effect(async (context) => {
      try {
        await sleep(ms(50)).withContext("clock", clock).run(context);
        finalizers.push({ effect: "effect1", action: "operation" });
        return "result1";
      } finally {
        finalizers.push({ effect: "effect1", action: "finalizer" });
      }
    }).withContext("clock", clock);

    const effect2 = effect(async (context) => {
      try {
        await sleep(ms(80)).withContext("clock", clock).run(context);
        finalizers.push({ effect: "effect2", action: "operation" });
        return "result2";
      } finally {
        finalizers.push({ effect: "effect2", action: "finalizer" });
      }
    }).withContext("clock", clock);

    const effect3 = effect(async (context) => {
      try {
        await sleep(ms(30)).withContext("clock", clock).run(context);
        finalizers.push({ effect: "effect3", action: "operation" });
        return "result3";
      } finally {
        finalizers.push({ effect: "effect3", action: "finalizer" });
      }
    }).withContext("clock", clock);

    // Run effects concurrently with different timing
    const results = await Promise.all([
      (async () => {
        const result = effect1.run();
        await new Promise((resolve) => setImmediate(resolve));
        clock.advanceBy(ms(50));
        await new Promise((resolve) => setImmediate(resolve));
        return result;
      })(),
      (async () => {
        const result = effect2.run();
        await new Promise((resolve) => setImmediate(resolve));
        clock.advanceBy(ms(80));
        await new Promise((resolve) => setImmediate(resolve));
        return result;
      })(),
      (async () => {
        const result = effect3.run();
        await new Promise((resolve) => setImmediate(resolve));
        clock.advanceBy(ms(30));
        await new Promise((resolve) => setImmediate(resolve));
        return result;
      })(),
    ]);

    const [result1, result2, result3] = await Promise.all(results);

    expect(result1).toBe("result1");
    expect(result2).toBe("result2");
    expect(result3).toBe("result3");

    // All finalizers should have run
    expect(finalizers).toContainEqual({ effect: "effect1", action: "operation" });
    expect(finalizers).toContainEqual({ effect: "effect1", action: "finalizer" });
    expect(finalizers).toContainEqual({ effect: "effect2", action: "operation" });
    expect(finalizers).toContainEqual({ effect: "effect2", action: "finalizer" });
    expect(finalizers).toContainEqual({ effect: "effect3", action: "operation" });
    expect(finalizers).toContainEqual({ effect: "effect3", action: "finalizer" });
  });
});

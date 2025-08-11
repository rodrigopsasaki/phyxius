import { describe, it, expect } from "vitest";
import { effect, sleep, succeed, all, race } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Effect Structured Concurrency", () => {
  it("should run all effects concurrently with all()", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const startTime = clock.now().monoMs;
    const executionOrder: string[] = [];

    const effect1 = effect(async (context) => {
      executionOrder.push("effect1-start");
      await sleep(ms(100)).withContext("clock", clock).run(context);
      executionOrder.push("effect1-end");
      return "result1";
    }).withContext("clock", clock);

    const effect2 = effect(async (context) => {
      executionOrder.push("effect2-start");
      await sleep(ms(150)).withContext("clock", clock).run(context);
      executionOrder.push("effect2-end");
      return "result2";
    }).withContext("clock", clock);

    const effect3 = effect(async (context) => {
      executionOrder.push("effect3-start");
      await sleep(ms(200)).withContext("clock", clock).run(context);
      executionOrder.push("effect3-end");
      return "result3";
    }).withContext("clock", clock);

    const combinedEffect = all([effect1, effect2, effect3]);
    const resultPromise = combinedEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // All effects should start concurrently
    expect(executionOrder).toEqual(["effect1-start", "effect2-start", "effect3-start"]);

    // Advance to complete effect1
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    // Advance to complete effect2
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    // Advance to complete effect3
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    const results = await resultPromise;
    const endTime = clock.now().monoMs;

    expect(results).toEqual(["result1", "result2", "result3"]);
    expect(endTime - startTime).toBe(200); // Longest duration, not sum
    expect(executionOrder).toEqual([
      "effect1-start",
      "effect2-start",
      "effect3-start",
      "effect1-end",
      "effect2-end",
      "effect3-end",
    ]);
  });

  it("should fail fast in all() when any effect fails", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const executionOrder: string[] = [];

    const successEffect = effect(async (context) => {
      executionOrder.push("success-start");
      await sleep(ms(300)).withContext("clock", clock).run(context);
      executionOrder.push("success-end");
      return "success";
    }).withContext("clock", clock);

    const failingEffect = effect(async (context) => {
      executionOrder.push("failing-start");
      await sleep(ms(100)).withContext("clock", clock).run(context);
      executionOrder.push("failing-end");
      throw new Error("planned failure");
    }).withContext("clock", clock);

    const slowEffect = effect(async (context) => {
      executionOrder.push("slow-start");
      await sleep(ms(500)).withContext("clock", clock).run(context);
      executionOrder.push("slow-end");
      return "slow";
    }).withContext("clock", clock);

    const combinedEffect = all([successEffect, failingEffect, slowEffect]);
    const resultPromise = combinedEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Advance to trigger failure
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("planned failure");
    }

    // All effects start, failing effect completes and fails
    // Other effects don't complete due to failure
    expect(executionOrder).toEqual(["success-start", "failing-start", "slow-start", "failing-end"]);
  });

  it("should return first successful result with race()", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const executionOrder: string[] = [];

    const fastEffect = effect(async (context) => {
      executionOrder.push("fast-start");
      await sleep(ms(100)).withContext("clock", clock).run(context);
      executionOrder.push("fast-end");
      return "fast-result";
    }).withContext("clock", clock);

    const mediumEffect = effect(async (context) => {
      executionOrder.push("medium-start");
      await sleep(ms(200)).withContext("clock", clock).run(context);
      executionOrder.push("medium-end");
      return "medium-result";
    }).withContext("clock", clock);

    const slowEffect = effect(async (context) => {
      executionOrder.push("slow-start");
      await sleep(ms(300)).withContext("clock", clock).run(context);
      executionOrder.push("slow-end");
      return "slow-result";
    }).withContext("clock", clock);

    const racingEffect = race([fastEffect, mediumEffect, slowEffect]);
    const resultPromise = racingEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // All effects should start
    expect(executionOrder).toEqual(["fast-start", "medium-start", "slow-start"]);

    // Advance to complete the fastest effect
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("fast-result");
    expect(executionOrder).toEqual(["fast-start", "medium-start", "slow-start", "fast-end"]);
  });

  it("should handle race() with first failure", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const executionOrder: string[] = [];

    const failingEffect = effect(async (context) => {
      executionOrder.push("failing-start");
      await sleep(ms(50)).withContext("clock", clock).run(context);
      executionOrder.push("failing-end");
      throw new Error("first failure");
    }).withContext("clock", clock);

    const successEffect = effect(async (context) => {
      executionOrder.push("success-start");
      await sleep(ms(100)).withContext("clock", clock).run(context);
      executionOrder.push("success-end");
      return "success";
    }).withContext("clock", clock);

    const racingEffect = race([failingEffect, successEffect]);
    const resultPromise = racingEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Advance to trigger first failure
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("first failure");
    }

    expect(executionOrder).toEqual(["failing-start", "success-start", "failing-end"]);
  });

  it("should support nested structured concurrency", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const results: Array<{ phase: string; result: any }> = [];

    const nestedEffect = effect(async (context) => {
      // Phase 1: Concurrent operations
      const phase1 = all([
        succeed("a").withContext("clock", clock),
        succeed("b").withContext("clock", clock),
        succeed("c").withContext("clock", clock),
      ]);

      const phase1Results = await phase1.run(context);
      results.push({ phase: "phase1", result: phase1Results });

      // Phase 2: Race between operations
      const phase2 = race([
        effect(async (ctx) => {
          await sleep(ms(100)).withContext("clock", clock).run(ctx);
          return "race-winner";
        }).withContext("clock", clock),
        effect(async (ctx) => {
          await sleep(ms(200)).withContext("clock", clock).run(ctx);
          return "race-loser";
        }).withContext("clock", clock),
      ]);

      const phase2Result = await phase2.run(context);
      results.push({ phase: "phase2", result: phase2Result });

      return "nested-complete";
    }).withContext("clock", clock);

    const resultPromise = nestedEffect.run();

    // Allow execution
    await new Promise((resolve) => setImmediate(resolve));

    // Advance for phase 2 race
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("nested-complete");
    expect(results).toEqual([
      { phase: "phase1", result: ["a", "b", "c"] },
      { phase: "phase2", result: "race-winner" },
    ]);
  });

  it("should maintain context across concurrent operations", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const contextValues: Array<{ effect: string; userId: string; requestId: string }> = [];

    const sharedContextEffect = effect(async (context) => {
      const _userId = context.get<string>("userId") ?? "unknown";
      const _requestId = context.get<string>("requestId") ?? "unknown";

      const concurrentOps = all([
        effect(async (ctx) => {
          const uid = ctx.get<string>("userId") ?? "unknown";
          const rid = ctx.get<string>("requestId") ?? "unknown";
          contextValues.push({ effect: "op1", userId: uid, requestId: rid });
          await sleep(ms(50)).withContext("clock", clock).run(ctx);
          return "op1-result";
        }).withContext("clock", clock),

        effect(async (ctx) => {
          const uid = ctx.get<string>("userId") ?? "unknown";
          const rid = ctx.get<string>("requestId") ?? "unknown";
          contextValues.push({ effect: "op2", userId: uid, requestId: rid });
          await sleep(ms(75)).withContext("clock", clock).run(ctx);
          return "op2-result";
        }).withContext("clock", clock),

        effect(async (ctx) => {
          const uid = ctx.get<string>("userId") ?? "unknown";
          const rid = ctx.get<string>("requestId") ?? "unknown";
          contextValues.push({ effect: "op3", userId: uid, requestId: rid });
          await sleep(ms(25)).withContext("clock", clock).run(ctx);
          return "op3-result";
        }).withContext("clock", clock),
      ]);

      return concurrentOps.run(context);
    })
      .withContext("userId", "user-123")
      .withContext("requestId", "req-456")
      .withContext("clock", clock);

    const resultPromise = sharedContextEffect.run();

    // Allow execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete all operations
    clock.advanceBy(ms(75));
    await new Promise((resolve) => setImmediate(resolve));

    const results = await resultPromise;

    expect(results).toEqual(["op1-result", "op2-result", "op3-result"]);
    expect(contextValues).toEqual([
      { effect: "op1", userId: "user-123", requestId: "req-456" },
      { effect: "op2", userId: "user-123", requestId: "req-456" },
      { effect: "op3", userId: "user-123", requestId: "req-456" },
    ]);
  });

  it("should support timeout in structured concurrency", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const executionOrder: string[] = [];

    const timedConcurrentEffect = all([
      effect(async (context) => {
        executionOrder.push("fast-start");
        await sleep(ms(100)).withContext("clock", clock).run(context);
        executionOrder.push("fast-end");
        return "fast";
      }).withContext("clock", clock),

      effect(async (context) => {
        executionOrder.push("slow-start");
        await sleep(ms(500)).withContext("clock", clock).run(context);
        executionOrder.push("slow-end");
        return "slow";
      }).withContext("clock", clock),
    ]).timeout(200);

    const resultPromise = timedConcurrentEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Trigger timeout before slow effect completes
    clock.advanceBy(ms(200));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 200ms/i);
    }

    // Fast effect completes, slow effect starts but doesn't complete
    expect(executionOrder).toEqual(["fast-start", "slow-start", "fast-end"]);
  });

  it("should handle complex concurrent workflows", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const workflow: Array<{ step: string; timestamp: number; data?: any }> = [];

    const complexWorkflow = effect(async (context) => {
      // Step 1: Initial setup (concurrent)
      workflow.push({ step: "setup-start", timestamp: clock.now().monoMs });

      const setupResults = await all([
        effect(async (ctx) => {
          await sleep(ms(50)).withContext("clock", clock).run(ctx);
          return "config-loaded";
        }).withContext("clock", clock),
        effect(async (ctx) => {
          await sleep(ms(30)).withContext("clock", clock).run(ctx);
          return "auth-verified";
        }).withContext("clock", clock),
      ]).run(context);

      workflow.push({
        step: "setup-complete",
        timestamp: clock.now().monoMs,
        data: setupResults,
      });

      // Step 2: Race to find fastest data source
      const dataResult = await race([
        effect(async (ctx) => {
          await sleep(ms(30)).withContext("clock", clock).run(ctx);
          return "cache-hit";
        }).withContext("clock", clock),
        effect(async (ctx) => {
          await sleep(ms(100)).withContext("clock", clock).run(ctx);
          return "db-query";
        }).withContext("clock", clock),
      ]).run(context);

      workflow.push({
        step: "data-retrieved",
        timestamp: clock.now().monoMs,
        data: dataResult,
      });

      // Step 3: Final processing (concurrent)
      const finalResults = await all([
        succeed("validation-passed"),
        succeed("audit-logged"),
        succeed("metrics-updated"),
      ]).run(context);

      workflow.push({
        step: "workflow-complete",
        timestamp: clock.now().monoMs,
        data: finalResults,
      });

      return "workflow-success";
    }).withContext("clock", clock);

    const resultPromise = complexWorkflow.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete setup phase (longest: 50ms)
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    // Complete data race (cache wins at additional 30ms after setup)
    clock.advanceBy(ms(30));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("workflow-success");
    expect(workflow).toEqual([
      { step: "setup-start", timestamp: 0 },
      { step: "setup-complete", timestamp: 50, data: ["config-loaded", "auth-verified"] },
      { step: "data-retrieved", timestamp: 80, data: "cache-hit" },
      { step: "workflow-complete", timestamp: 80, data: ["validation-passed", "audit-logged", "metrics-updated"] },
    ]);
  });
});

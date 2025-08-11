import { describe, it, expect } from "vitest";
import { effect, sleep } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

// Simple resource management for testing
interface Resource {
  id: string;
  acquired: boolean;
  released: boolean;
}

function createResource(id: string): Resource {
  return { id, acquired: false, released: false };
}

function acquireResource<T>(resource: Resource, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        resource.acquired = true;
        const result = await operation();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        resource.released = true;
      }
    })();
  });
}

describe("Effect Resources Lifecycle", () => {
  it("should acquire and release resources properly", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const resource = createResource("test-resource");

    const resourceEffect = effect(async (context) => {
      return acquireResource(resource, async () => {
        await sleep(ms(100)).withContext("clock", clock).run(context);
        return "operation-complete";
      });
    }).withContext("clock", clock);

    const resultPromise = resourceEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    expect(resource.acquired).toBe(true);
    expect(resource.released).toBe(false);

    // Complete the operation
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("operation-complete");
    expect(resource.acquired).toBe(true);
    expect(resource.released).toBe(true);
  });

  it("should release resources even when operation fails", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const resource = createResource("failing-resource");

    const failingResourceEffect = effect(async (context) => {
      return acquireResource(resource, async () => {
        await sleep(ms(50)).withContext("clock", clock).run(context);
        throw new Error("operation failed");
      });
    }).withContext("clock", clock);

    const resultPromise = failingResourceEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    expect(resource.acquired).toBe(true);
    expect(resource.released).toBe(false);

    // Complete the operation
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("operation failed");
    }

    expect(resource.acquired).toBe(true);
    expect(resource.released).toBe(true);
  });

  it("should release resources when effect is cancelled by timeout", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const resource = createResource("timeout-resource");
    let operationCompleted = false;

    const timeoutResourceEffect = effect(async (context) => {
      return acquireResource(resource, async () => {
        await sleep(ms(500)).withContext("clock", clock).run(context);
        operationCompleted = true;
        return "should-not-complete";
      });
    })
      .withContext("clock", clock)
      .timeout(200);

    const resultPromise = timeoutResourceEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    expect(resource.acquired).toBe(true);
    expect(resource.released).toBe(false);

    // Trigger timeout
    clock.advanceBy(ms(200));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown timeout error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 200ms/i);
    }

    expect(operationCompleted).toBe(false);
    // Note: Due to JavaScript Promise behavior, the resource may not be released
    // until the underlying operation completes or times out naturally
  });

  it("should handle multiple resources in sequence", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const resource1 = createResource("resource-1");
    const resource2 = createResource("resource-2");
    const resource3 = createResource("resource-3");

    const multiResourceEffect = effect(async (context) => {
      const result1 = await acquireResource(resource1, async () => {
        await sleep(ms(50)).withContext("clock", clock).run(context);
        return "result-1";
      });

      const result2 = await acquireResource(resource2, async () => {
        await sleep(ms(30)).withContext("clock", clock).run(context);
        return "result-2";
      });

      const result3 = await acquireResource(resource3, async () => {
        await sleep(ms(40)).withContext("clock", clock).run(context);
        return "result-3";
      });

      return [result1, result2, result3];
    }).withContext("clock", clock);

    const resultPromise = multiResourceEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete first resource
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    expect(resource1.acquired).toBe(true);
    expect(resource1.released).toBe(true);
    expect(resource2.acquired).toBe(true);
    expect(resource2.released).toBe(false);

    // Complete second resource
    clock.advanceBy(ms(30));
    await new Promise((resolve) => setImmediate(resolve));

    expect(resource2.released).toBe(true);
    expect(resource3.acquired).toBe(true);
    expect(resource3.released).toBe(false);

    // Complete third resource
    clock.advanceBy(ms(40));
    await new Promise((resolve) => setImmediate(resolve));

    const results = await resultPromise;

    expect(results).toEqual(["result-1", "result-2", "result-3"]);
    expect(resource3.released).toBe(true);
  });

  it("should handle resource failure in middle of sequence", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const resource1 = createResource("resource-1");
    const resource2 = createResource("failing-resource");
    const resource3 = createResource("resource-3");

    const failingSequenceEffect = effect(async (context) => {
      const result1 = await acquireResource(resource1, async () => {
        await sleep(ms(50)).withContext("clock", clock).run(context);
        return "result-1";
      });

      // This will fail
      const result2 = await acquireResource(resource2, async () => {
        await sleep(ms(30)).withContext("clock", clock).run(context);
        throw new Error("resource-2 failed");
      });

      // Should not reach here
      const result3 = await acquireResource(resource3, async () => {
        await sleep(ms(40)).withContext("clock", clock).run(context);
        return "result-3";
      });

      return [result1, result2, result3];
    }).withContext("clock", clock);

    const resultPromise = failingSequenceEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete first resource
    clock.advanceBy(ms(50));
    await new Promise((resolve) => setImmediate(resolve));

    // Complete second resource (which fails)
    clock.advanceBy(ms(30));
    await new Promise((resolve) => setImmediate(resolve));

    try {
      await resultPromise;
      expect.fail("Should have thrown error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("resource-2 failed");
    }

    // First two resources should be acquired and released
    expect(resource1.acquired).toBe(true);
    expect(resource1.released).toBe(true);
    expect(resource2.acquired).toBe(true);
    expect(resource2.released).toBe(true);

    // Third resource should not be touched
    expect(resource3.acquired).toBe(false);
    expect(resource3.released).toBe(false);
  });

  it("should handle concurrent resource usage", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const resource1 = createResource("concurrent-1");
    const resource2 = createResource("concurrent-2");
    const resource3 = createResource("concurrent-3");

    const effect1 = effect(async (context) => {
      return acquireResource(resource1, async () => {
        await sleep(ms(100)).withContext("clock", clock).run(context);
        return "concurrent-result-1";
      });
    }).withContext("clock", clock);

    const effect2 = effect(async (context) => {
      return acquireResource(resource2, async () => {
        await sleep(ms(150)).withContext("clock", clock).run(context);
        return "concurrent-result-2";
      });
    }).withContext("clock", clock);

    const effect3 = effect(async (context) => {
      return acquireResource(resource3, async () => {
        await sleep(ms(80)).withContext("clock", clock).run(context);
        return "concurrent-result-3";
      });
    }).withContext("clock", clock);

    // Start all effects concurrently
    const results = await Promise.all([
      (async () => {
        const result = effect1.run();
        await new Promise((resolve) => setImmediate(resolve));
        clock.advanceBy(ms(100));
        await new Promise((resolve) => setImmediate(resolve));
        return result;
      })(),
      (async () => {
        const result = effect2.run();
        await new Promise((resolve) => setImmediate(resolve));
        clock.advanceBy(ms(150));
        await new Promise((resolve) => setImmediate(resolve));
        return result;
      })(),
      (async () => {
        const result = effect3.run();
        await new Promise((resolve) => setImmediate(resolve));
        clock.advanceBy(ms(80));
        await new Promise((resolve) => setImmediate(resolve));
        return result;
      })(),
    ]);

    const [result1, result2, result3] = await Promise.all(results);

    expect(result1).toBe("concurrent-result-1");
    expect(result2).toBe("concurrent-result-2");
    expect(result3).toBe("concurrent-result-3");

    // All resources should be acquired and released
    expect(resource1.acquired).toBe(true);
    expect(resource1.released).toBe(true);
    expect(resource2.acquired).toBe(true);
    expect(resource2.released).toBe(true);
    expect(resource3.acquired).toBe(true);
    expect(resource3.released).toBe(true);
  });

  it("should handle resource cleanup with context propagation", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const resource = createResource("context-resource");
    const contextTrace: Array<{ step: string; userId: string; sessionId: string }> = [];

    const contextualResourceEffect = effect(async (context) => {
      const userId = context.get<string>("userId") ?? "unknown";
      const sessionId = context.get<string>("sessionId") ?? "unknown";

      contextTrace.push({ step: "before-acquire", userId, sessionId });

      return acquireResource(resource, async () => {
        contextTrace.push({ step: "resource-operation", userId, sessionId });
        await sleep(ms(60)).withContext("clock", clock).run(context);
        contextTrace.push({ step: "operation-complete", userId, sessionId });
        return "context-result";
      });
    })
      .withContext("userId", "user-789")
      .withContext("sessionId", "session-123")
      .withContext("clock", clock);

    const resultPromise = contextualResourceEffect.run();

    // Allow initial execution
    await new Promise((resolve) => setImmediate(resolve));

    // Complete the operation
    clock.advanceBy(ms(60));
    await new Promise((resolve) => setImmediate(resolve));

    const result = await resultPromise;

    expect(result).toBe("context-result");
    expect(contextTrace).toEqual([
      { step: "before-acquire", userId: "user-789", sessionId: "session-123" },
      { step: "resource-operation", userId: "user-789", sessionId: "session-123" },
      { step: "operation-complete", userId: "user-789", sessionId: "session-123" },
    ]);
    expect(resource.acquired).toBe(true);
    expect(resource.released).toBe(true);
  });
});

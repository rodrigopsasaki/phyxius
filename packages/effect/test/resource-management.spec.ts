import { describe, it, expect } from "vitest";
import { effect, succeed, fail, sleep, acquireUseRelease } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Resource Management", () => {
  describe("onInterrupt", () => {
    it("should run cleanup when effect is interrupted", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let cleanupCalled = false;

      const interruptibleEffect = sleep(ms(1000))
        .onInterrupt(() =>
          effect(async () => {
            cleanupCalled = true;
            return { _tag: "Ok", value: undefined };
          }),
        )
        .timeout(ms(500));

      const resultPromise = interruptibleEffect.unsafeRunPromise({ clock });

      await Promise.resolve();

      // Advance time to trigger timeout (interrupt)
      clock.advanceBy(ms(500));
      await Promise.resolve();

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
      expect(cleanupCalled).toBe(true);
    });

    it("should not run cleanup when effect completes normally", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let cleanupCalled = false;

      const normalEffect = succeed("completed").onInterrupt(() =>
        effect(async () => {
          cleanupCalled = true;
          return { _tag: "Ok", value: undefined };
        }),
      );

      const result = await normalEffect.unsafeRunPromise({ clock });

      expect(result).toEqual({ _tag: "Ok", value: "completed" });
      expect(cleanupCalled).toBe(false);
    });

    it("should not run cleanup when effect fails normally", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      let cleanupCalled = false;

      const failingEffect = fail("test error").onInterrupt(() =>
        effect(async () => {
          cleanupCalled = true;
          return { _tag: "Ok", value: undefined };
        }),
      );

      const result = await failingEffect.unsafeRunPromise({ clock });

      expect(result).toEqual({ _tag: "Err", error: "test error" });
      expect(cleanupCalled).toBe(false);
    });

    it("should handle multiple onInterrupt handlers", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const cleanupCalls: string[] = [];

      const multiInterruptEffect = sleep(ms(1000))
        .onInterrupt(() =>
          effect(async () => {
            cleanupCalls.push("cleanup1");
            return { _tag: "Ok", value: undefined };
          }),
        )
        .onInterrupt(() =>
          effect(async () => {
            cleanupCalls.push("cleanup2");
            return { _tag: "Ok", value: undefined };
          }),
        )
        .timeout(ms(500));

      const resultPromise = multiInterruptEffect.unsafeRunPromise({ clock });

      await Promise.resolve();

      // Advance time to trigger timeout (interrupt)
      clock.advanceBy(ms(500));
      await Promise.resolve();

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
      expect(cleanupCalls).toContain("cleanup1");
      expect(cleanupCalls).toContain("cleanup2");
    });
  });

  describe("acquireUseRelease", () => {
    it("should acquire resource, use it, and release it on success", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const events: string[] = [];

      const resource = acquireUseRelease(
        // Acquire
        effect(async () => {
          events.push("acquire");
          return { _tag: "Ok", value: "resource" };
        }),
        // Use
        (res) =>
          effect(async () => {
            events.push(`use-${res}`);
            return { _tag: "Ok", value: "result" };
          }),
        // Release
        (res, cause) =>
          effect(async () => {
            events.push(`release-${res}-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await resource.unsafeRunPromise({ clock });

      expect(result).toEqual({ _tag: "Ok", value: "result" });
      expect(events).toEqual(["acquire", "use-resource", "release-resource-ok"]);
    });

    it("should release resource even when use fails", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const events: string[] = [];

      const resource = acquireUseRelease(
        // Acquire
        effect(async () => {
          events.push("acquire");
          return { _tag: "Ok", value: "resource" };
        }),
        // Use (fails)
        (res) =>
          effect(async () => {
            events.push(`use-${res}`);
            return { _tag: "Err", error: "use-failed" };
          }),
        // Release
        (res, cause) =>
          effect(async () => {
            events.push(`release-${res}-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await resource.unsafeRunPromise({ clock });

      expect(result).toEqual({ _tag: "Err", error: "use-failed" });
      expect(events).toEqual(["acquire", "use-resource", "release-resource-error"]);
    });

    it("should not call use or release if acquire fails", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const events: string[] = [];

      const resource = acquireUseRelease(
        // Acquire (fails)
        effect(async () => {
          events.push("acquire-failed");
          return { _tag: "Err", error: "acquire-failed" };
        }),
        // Use
        (res) =>
          effect(async () => {
            events.push(`use-${res}`);
            return { _tag: "Ok", value: "result" };
          }),
        // Release
        (res, cause) =>
          effect(async () => {
            events.push(`release-${res}-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await resource.unsafeRunPromise({ clock });

      expect(result).toEqual({ _tag: "Err", error: "acquire-failed" });
      expect(events).toEqual(["acquire-failed"]);
    });

    it("should release resource when interrupted", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const events: string[] = [];

      const resource = acquireUseRelease(
        // Acquire
        effect(async () => {
          events.push("acquire");
          return { _tag: "Ok", value: "resource" };
        }),
        // Use (takes longer than timeout)
        (res) =>
          effect(async (env) => {
            events.push(`use-${res}-start`);
            const sleepResult = await sleep(ms(1000)).unsafeRunPromise({ clock: env.clock });
            if (sleepResult._tag === "Err") throw sleepResult.error;
            events.push(`use-${res}-end`);
            return { _tag: "Ok", value: "result" };
          }),
        // Release
        (res, cause) =>
          effect(async () => {
            events.push(`release-${res}-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      ).timeout(ms(500));

      const resultPromise = resource.unsafeRunPromise({ clock });

      await Promise.resolve();

      // Advance time to trigger timeout
      clock.advanceBy(ms(500));
      await Promise.resolve();

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
      expect(events).toEqual([
        "acquire",
        "use-resource-start",
        "release-resource-interrupted", // Should be called even though interrupted
      ]);
    });

    it("should handle nested resource management", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const events: string[] = [];

      const nestedResource = acquireUseRelease(
        // Acquire outer
        effect(async () => {
          events.push("acquire-outer");
          return { _tag: "Ok", value: "outer" };
        }),
        // Use outer (acquires inner resource)
        (outer) =>
          acquireUseRelease(
            // Acquire inner
            effect(async () => {
              events.push("acquire-inner");
              return { _tag: "Ok", value: "inner" };
            }),
            // Use inner
            (inner) =>
              effect(async () => {
                events.push(`use-${outer}-${inner}`);
                return { _tag: "Ok", value: "nested-result" };
              }),
            // Release inner
            (inner, cause) =>
              effect(async () => {
                events.push(`release-${inner}-${cause}`);
                return { _tag: "Ok", value: undefined };
              }),
          ),
        // Release outer
        (outer, cause) =>
          effect(async () => {
            events.push(`release-${outer}-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await nestedResource.unsafeRunPromise({ clock });

      expect(result).toEqual({ _tag: "Ok", value: "nested-result" });
      expect(events).toEqual([
        "acquire-outer",
        "acquire-inner",
        "use-outer-inner",
        "release-inner-ok", // Inner resource released first (LIFO)
        "release-outer-ok", // Outer resource released last
      ]);
    });
  });
});

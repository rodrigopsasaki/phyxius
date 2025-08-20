import { describe, it, expect, beforeEach } from "vitest";
import { effect, succeed, fail, fromPromise } from "../src/index.js";
import { createControlledClock } from "@phyxiusjs/clock";

interface EffectEvent {
  type: string;
  [key: string]: unknown;
}

describe("Effect Kernel - IO Monad Fundamentals", () => {
  let events: unknown[] = [];
  const emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("Core Philosophy: Effects are descriptions, not executions", () => {
    it("should not execute until unsafeRunPromise is called", async () => {
      let executed = false;

      // Creating an effect should not execute it
      const eff = effect(async () => {
        executed = true;
        return { _tag: "Ok", value: 42 };
      });

      expect(executed).toBe(false);

      // Only when we run it should it execute
      const result = await eff.unsafeRunPromise();
      expect(executed).toBe(true);
      expect(result).toEqual({ _tag: "Ok", value: 42 });
    });

    it("should create reusable blueprints", async () => {
      let counter = 0;

      const eff = effect(async () => {
        counter++;
        return { _tag: "Ok", value: counter };
      });

      // Same effect can be run multiple times
      const result1 = await eff.unsafeRunPromise();
      const result2 = await eff.unsafeRunPromise();

      expect(result1).toEqual({ _tag: "Ok", value: 1 });
      expect(result2).toEqual({ _tag: "Ok", value: 2 });
    });
  });

  describe("Result Types: Explicit error handling", () => {
    it("should return Success result for successful computation", async () => {
      const eff = succeed(42);
      const result = await eff.unsafeRunPromise();

      expect(result._tag).toBe("Ok");
      expect(result.value).toBe(42);
    });

    it("should return Error result for failed computation", async () => {
      const eff = fail("computation failed");
      const result = await eff.unsafeRunPromise();

      expect(result._tag).toBe("Err");
      expect(result.error).toBe("computation failed");
    });

    it("should catch thrown exceptions and convert to Error result", async () => {
      const eff = effect(async () => {
        throw new Error("unexpected error");
      });

      const result = await eff.unsafeRunPromise();

      expect(result._tag).toBe("Err");
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("unexpected error");
    });

    it("should handle Promise rejections", async () => {
      const rejectedPromise = Promise.reject(new Error("promise failed"));
      const eff = fromPromise(rejectedPromise);

      const result = await eff.unsafeRunPromise();

      expect(result._tag).toBe("Err");
      expect((result.error as Error).message).toBe("promise failed");
    });
  });

  describe("Environment: Clock, Cancel, Scope", () => {
    it("should provide clock in environment", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      const eff = effect(async (env) => {
        const time = env.clock?.now().wallMs ?? 0;
        return { _tag: "Ok", value: time };
      });

      const result = await eff.unsafeRunPromise({ clock });
      expect(result).toEqual({ _tag: "Ok", value: 1000 });
    });

    it("should provide cancel token in environment", async () => {
      const eff = effect(async (env) => {
        expect(env.cancel).toBeDefined();
        expect(typeof env.cancel.isCanceled).toBe("function");
        return { _tag: "Ok", value: "tested" };
      });

      await eff.unsafeRunPromise();
    });

    it("should provide scope for resource management in environment", async () => {
      const eff = effect(async (env) => {
        expect(env.scope).toBeDefined();
        expect(typeof env.scope.push).toBe("function");
        return { _tag: "Ok", value: "tested" };
      });

      await eff.unsafeRunPromise();
    });
  });

  describe("Observability: Event emission", () => {
    it("should emit start and success events", async () => {
      const eff = effect(async () => ({ _tag: "Ok", value: 42 }), { emit });

      await eff.unsafeRunPromise();

      const startEvents = events.filter((e: EffectEvent) => e.type === "effect:start");
      const successEvents = events.filter((e: EffectEvent) => e.type === "effect:success");

      expect(startEvents).toHaveLength(1);
      expect(successEvents).toHaveLength(1);
      expect(startEvents[0]).toMatchObject({ type: "effect:start" });
      expect(successEvents[0]).toMatchObject({ type: "effect:success" });
    });

    it("should emit error events on failure", async () => {
      const eff = effect(
        async () => {
          throw new Error("test error");
        },
        { emit },
      );

      await eff.unsafeRunPromise();

      const errorEvents = events.filter((e: EffectEvent) => e.type === "effect:error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: "effect:error",
        error: expect.any(Error),
      });
    });

    it("should include timestamps in events when clock is provided", async () => {
      const clock = createControlledClock({ initialTime: 5000 });

      const eff = effect(async () => ({ _tag: "Ok", value: 42 }), { emit });

      await eff.unsafeRunPromise({ clock });

      const startEvent = events.find((e: EffectEvent) => e.type === "effect:start") as EffectEvent;
      expect(startEvent.timestamp).toBe(5000);
    });
  });

  describe("Edge Cases and Error Conditions", () => {
    it("should handle effects that return malformed results", async () => {
      const eff = effect(async () => {
        // Return something that's not a proper Result
        return "not a result" as unknown;
      });

      const result = await eff.unsafeRunPromise();
      // The effect system should still work, returning the malformed result
      expect(result).toBe("not a result");
    });

    it("should handle effects with no environment", async () => {
      const eff = effect(async () => ({ _tag: "Ok", value: "works" }));

      const result = await eff.unsafeRunPromise();
      expect(result).toEqual({ _tag: "Ok", value: "works" });
    });

    it("should handle synchronous effects", async () => {
      const eff = effect(async () => {
        // Synchronous computation wrapped in async
        return { _tag: "Ok", value: 2 + 2 };
      });

      const result = await eff.unsafeRunPromise();
      expect(result).toEqual({ _tag: "Ok", value: 4 });
    });
  });
});

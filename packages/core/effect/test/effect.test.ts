import { describe, it, expect, beforeEach } from "vitest";
import { effect, succeed, fail, fromPromise, all, race, createContext } from "../src/index.js";

describe("Effect", () => {
  let events: unknown[] = [];
  const emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("basic effect operations", () => {
    it("should run a simple effect", async () => {
      const eff = effect(async () => 42, { emit });
      const result = await eff.run();

      expect(result).toBe(42);
    });

    it("should emit start and success events", async () => {
      const eff = effect(async () => 42, { emit });
      await eff.run();

      const startEvents = events.filter((e: any) => e.type === "effect:start");
      const successEvents = events.filter((e: any) => e.type === "effect:success");

      expect(startEvents).toHaveLength(1);
      expect(successEvents).toHaveLength(1);
    });

    it("should emit error events on failure", async () => {
      const eff = effect(
        async () => {
          throw new Error("test error");
        },
        { emit },
      );

      await expect(eff.run()).rejects.toThrow("test error");

      const errorEvents = events.filter((e: any) => e.type === "effect:error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: "effect:error",
      });
    });

    it("should work without emit function", async () => {
      const eff = effect(async () => 42);
      const result = await eff.run();

      expect(result).toBe(42);
    });
  });

  describe("context operations", () => {
    it("should pass context to effect function", async () => {
      const context = createContext();
      context.values.set("test", "value");

      const eff = effect(async (ctx) => ctx.get<string>("test"), { emit });
      const result = await eff.run(context);

      expect(result).toBe("value");
    });

    it("should create empty context when none provided", async () => {
      const eff = effect(async (ctx) => ctx.values.size, { emit });
      const result = await eff.run();

      expect(result).toBe(0);
    });

    it("should support withContext", async () => {
      const eff = effect(
        async (ctx) => ({
          key: ctx.get<string>("key"),
          size: ctx.values.size,
        }),
        { emit },
      ).withContext("key", "value");

      const result = await eff.run();
      expect(result.key).toBe("value");
      expect(result.size).toBe(1);
    });
  });

  describe("map operation", () => {
    it("should transform effect result", async () => {
      const eff = effect(async () => 42, { emit }).map((x) => x * 2);

      const result = await eff.run();
      expect(result).toBe(84);
    });

    it("should chain multiple maps", async () => {
      const eff = effect(async () => 10, { emit })
        .map((x) => x + 5)
        .map((x) => x * 2);

      const result = await eff.run();
      expect(result).toBe(30);
    });
  });

  describe("flatMap operation", () => {
    it("should chain effects", async () => {
      const eff1 = effect(async () => 42, { emit });
      const eff2 = (n: number) => effect(async () => n * 2, { emit });

      const result = await eff1.flatMap(eff2).run();
      expect(result).toBe(84);
    });

    it("should pass context through flatMap", async () => {
      const context = createContext().with("multiplier", 3);

      const eff = effect(async () => 10, { emit }).flatMap((n) =>
        effect(async (ctx) => n * (ctx.get<number>("multiplier") ?? 1), { emit }),
      );

      const result = await eff.run(context);
      expect(result).toBe(30);
    });
  });

  describe("error handling", () => {
    it("should catch and recover from errors", async () => {
      const eff = effect(
        async () => {
          throw new Error("test error");
        },
        { emit },
      ).catch(() => succeed(42, { emit }));

      const result = await eff.run();
      expect(result).toBe(42);
    });

    it("should pass error to catch handler", async () => {
      let caughtError: Error | undefined;

      const eff = effect(
        async () => {
          throw new Error("test error");
        },
        { emit },
      ).catch((error) => {
        caughtError = error;
        return succeed("recovered", { emit });
      });

      const result = await eff.run();
      expect(result).toBe("recovered");
      expect(caughtError?.message).toBe("test error");
    });
  });

  describe("timeout operation", () => {
    it("should complete before timeout", async () => {
      const eff = effect(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 42;
        },
        { emit },
      ).timeout(100);

      const result = await eff.run();
      expect(result).toBe(42);
    });

    it("should timeout on slow operations", async () => {
      const eff = effect(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return 42;
        },
        { emit },
      ).timeout(10);

      await expect(eff.run()).rejects.toThrow("Effect timed out after 10ms");
    });

    it("should emit timeout events", async () => {
      const eff = effect(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return 42;
        },
        { emit },
      ).timeout(10);

      await expect(eff.run()).rejects.toThrow();

      const timeoutStartEvents = events.filter((e: any) => e.type === "effect:timeout:start");
      const timeoutTriggeredEvents = events.filter((e: any) => e.type === "effect:timeout:triggered");

      expect(timeoutStartEvents).toHaveLength(1);
      expect(timeoutTriggeredEvents).toHaveLength(1);
    });
  });

  describe("utility functions", () => {
    it("should create successful effect with succeed", async () => {
      const eff = succeed(42, { emit });
      const result = await eff.run();

      expect(result).toBe(42);
    });

    it("should create failing effect with fail", async () => {
      const error = new Error("test error");
      const eff = fail(error, { emit });

      await expect(eff.run()).rejects.toBe(error);
    });

    it("should convert promise with fromPromise", async () => {
      const promise = Promise.resolve(42);
      const eff = fromPromise(promise, { emit });

      const result = await eff.run();
      expect(result).toBe(42);
    });

    it("should handle rejected promise with fromPromise", async () => {
      const promise = Promise.reject(new Error("test error"));
      const eff = fromPromise(promise, { emit });

      await expect(eff.run()).rejects.toThrow("test error");
    });
  });

  describe("concurrent operations", () => {
    it("should run all effects in parallel", async () => {
      const eff1 = effect(async () => 1, { emit });
      const eff2 = effect(async () => 2, { emit });
      const eff3 = effect(async () => 3, { emit });

      const result = await all([eff1, eff2, eff3], { emit }).run();
      expect(result).toEqual([1, 2, 3]);
    });

    it("should fail all if one fails", async () => {
      const eff1 = succeed(1, { emit });
      const eff2 = fail(new Error("test error"), { emit });
      const eff3 = succeed(3, { emit });

      await expect(all([eff1, eff2, eff3], { emit }).run()).rejects.toThrow("test error");
    });

    it("should race effects and return first result", async () => {
      const slow = effect(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return "slow";
        },
        { emit },
      );

      const fast = effect(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return "fast";
        },
        { emit },
      );

      const result = await race([slow, fast], { emit }).run();
      expect(result).toBe("fast");
    });
  });

  describe("complex scenarios", () => {
    it("should handle nested effect compositions", async () => {
      const context = createContext().with("base", 10);

      const eff = effect(async (ctx) => ctx.get<number>("base") ?? 0, { emit })
        .map((x) => x + 5)
        .flatMap((x) => effect(async () => x * 2, { emit }))
        .map((x) => x + 1)
        .catch(() => succeed(0, { emit }));

      const result = await eff.run(context);
      expect(result).toBe(31); // (10 + 5) * 2 + 1
    });

    it("should support effect pipelines with error recovery", async () => {
      let step = 0;

      const pipeline = effect(
        async () => {
          step = 1;
          return 10;
        },
        { emit },
      )
        .flatMap((x) =>
          effect(
            async () => {
              step = 2;
              if (x < 20) throw new Error("too small");
              return x * 2;
            },
            { emit },
          ),
        )
        .catch(() =>
          effect(
            async () => {
              step = 3;
              return 100;
            },
            { emit },
          ),
        )
        .map((x) => {
          step = 4;
          return x + 1;
        });

      const result = await pipeline.run();
      expect(result).toBe(101);
      expect(step).toBe(4);
    });

    it("should handle context propagation through complex chains", async () => {
      // Context modifications should be scoped to the effect chain
      const baseContext = createContext().with("base", "baseValue");

      const eff = effect(
        async (ctx) => ({
          base: ctx.get<string>("base"),
          added: ctx.get<string>("added"),
        }),
        { emit },
      ).withContext("added", "addedValue");

      const result = await eff.run(baseContext);
      expect(result.base).toBe("baseValue");
      expect(result.added).toBe("addedValue");
    });

    it("should support resource management patterns", async () => {
      const resources: string[] = [];

      const acquireResource = (name: string) =>
        effect(
          async () => {
            resources.push(`acquire:${name}`);
            return name;
          },
          { emit },
        );

      const useResource = (name: string) =>
        effect(
          async () => {
            resources.push(`use:${name}`);
            return `result:${name}`;
          },
          { emit },
        );

      const releaseResource = (name: string) =>
        effect(
          async () => {
            resources.push(`release:${name}`);
          },
          { emit },
        );

      const managedEffect = acquireResource("db").flatMap((name) =>
        useResource(name)
          .map((result) => ({ name, result }))
          .flatMap(({ name, result }) => releaseResource(name).map(() => result)),
      );

      const result = await managedEffect.run();
      expect(result).toBe("result:db");
      expect(resources).toEqual(["acquire:db", "use:db", "release:db"]);
    });
  });

  describe("context operations detailed", () => {
    it("should support nested context modifications", async () => {
      const eff = effect(async (ctx) => ctx.get<string>("level1"), { emit })
        .withContext("level1", "value1")
        .flatMap((v1) =>
          effect(async (ctx) => `${v1}-${ctx.get<string>("level2")}`, { emit }).withContext("level2", "value2"),
        );

      const result = await eff.run();
      expect(result).toBe("value1-value2");
    });

    it("should preserve context across effect boundaries", async () => {
      const baseContext = createContext().with("shared", "global");

      const eff1 = effect(async (ctx) => ctx.get<string>("shared"), { emit }).withContext("local1", "local");

      const eff2 = effect(
        async (ctx) => ({
          shared: ctx.get<string>("shared"),
          local1: ctx.get<string>("local1"), // Should be undefined
          local2: ctx.get<string>("local2"),
        }),
        { emit },
      ).withContext("local2", "another");

      const combined = all([eff1, eff2], { emit });
      const [result1, result2] = await combined.run(baseContext);

      expect(result1).toBe("global");
      expect(result2.shared).toBe("global");
      expect(result2.local1).toBeUndefined();
      expect(result2.local2).toBe("another");
    });
  });
});

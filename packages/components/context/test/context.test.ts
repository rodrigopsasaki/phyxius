import { describe, it, expect, beforeEach } from "vitest";
import { context } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Context", () => {
  beforeEach(() => {
    // Clear any global context before each test by accessing the global runtime directly
    // @ts-expect-error - accessing internal state for testing purposes
    if (globalThis.__phyxius_context_runtime__) {
      // @ts-expect-error - accessing internal state for testing purposes
      globalThis.__phyxius_context_runtime__.globalContext = undefined;
      // @ts-expect-error - accessing internal state for testing purposes
      globalThis.__phyxius_context_runtime__.contextStore = undefined;
    }
  });

  describe("global context", () => {
    it("should set and get global context", () => {
      const clock = createControlledClock({ initialTime: 1000 });

      const globalCtx = context.global({
        name: "test.global",
        clock,
        initial: { service: "test" },
      });

      expect(globalCtx.name).toBe("test.global");
      expect(globalCtx.clock).toBe(clock);
      expect(globalCtx.data.get("service")).toBe("test");

      const retrieved = context.globalContext();
      expect(retrieved).toBe(globalCtx);
    });
  });

  describe("observe", () => {
    it("should create context and execute callback", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      const result = await context.observe(
        {
          name: "test.operation",
          clock,
          initial: { test: "data" },
        },
        async () => {
          const ctx = context.require();
          expect(ctx.name).toBe("test.operation");
          expect(ctx.clock).toBe(clock);
          expect(ctx.data.get("test")).toBe("data");
          return "success";
        },
      );

      expect(result).toBe("success");
    });

    it("should inherit from global context", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      context.global({
        name: "global",
        clock,
        initial: { global: "value" },
      });

      await context.observe("test.operation", async () => {
        const ctx = context.require();
        expect(ctx.clock).toBe(clock);
        expect(ctx.data.get("global")).toBe("value");
      });
    });

    it("should inherit from parent context", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      await context.observe(
        {
          name: "parent",
          clock,
          initial: { parent: "data" },
        },
        async () => {
          context.set("runtime", "added");

          await context.observe("child", async () => {
            const ctx = context.require();
            expect(ctx.parentId).toBeDefined();
            expect(ctx.data.get("parent")).toBe("data");
            expect(ctx.data.get("runtime")).toBe("added");
          });
        },
      );
    });

    it("should not inherit when inherit is false", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      await context.observe(
        {
          name: "parent",
          clock,
          initial: { parent: "data" },
        },
        async () => {
          await context.observe(
            {
              name: "child",
              inherit: false,
              initial: { child: "only" },
            },
            async () => {
              const ctx = context.require();
              expect(ctx.data.get("parent")).toBeUndefined();
              expect(ctx.data.get("child")).toBe("only");
            },
          );
        },
      );
    });
  });

  describe("data manipulation", () => {
    it("should set and get data", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      await context.observe({ name: "test", clock }, async () => {
        context.set("key1", "value1");
        context.set("key2", 42);

        expect(context.get("key1")).toBe("value1");
        expect(context.get("key2")).toBe(42);
        expect(context.get("nonexistent")).toBeUndefined();
      });
    });

    it("should push to arrays", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      await context.observe({ name: "test", clock }, async () => {
        context.push("events", "event1");
        context.push("events", "event2");

        const events = context.get<string[]>("events");
        expect(events).toEqual(["event1", "event2"]);
      });
    });

    it("should merge objects", async () => {
      const clock = createControlledClock({ initialTime: 1000 });

      await context.observe({ name: "test", clock }, async () => {
        context.merge("metadata", { key1: "value1" });
        context.merge("metadata", { key2: "value2" });

        const metadata = context.get("metadata");
        expect(metadata).toEqual({ key1: "value1", key2: "value2" });
      });
    });
  });

  describe("error handling", () => {
    it("should throw when no context is available", () => {
      expect(() => context.require()).toThrow("No active context available");
    });

    it("should throw when no clock is available", async () => {
      await expect(
        context.observe("test", async () => {
          // This should fail because no clock is provided and no global context
        }),
      ).rejects.toThrow("No clock available");
    });
  });
});

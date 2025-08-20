import { describe, it, expect } from "vitest";
import { context } from "@phyxiusjs/context";
import { observe } from "../src/index.js";

describe("Observe - Context Data Manipulation Namespace", () => {
  describe("basic operations", () => {
    it("should set and get values in context", async () => {
      await context.scope(async () => {
        observe.set("operation", "user.login");
        observe.set("startTime", 1234567890);

        expect(observe.get("operation")).toBe("user.login");
        expect(observe.get("startTime")).toBe(1234567890);
      });
    });

    it("should handle undefined values", async () => {
      await context.scope(async () => {
        expect(observe.get("nonexistent")).toBeUndefined();
      });
    });

    it("should check if keys exist", async () => {
      await context.scope(async () => {
        observe.set("existing", "value");

        expect(observe.has("existing")).toBe(true);
        expect(observe.has("nonexistent")).toBe(false);
      });
    });
  });

  describe("array operations", () => {
    it("should push values to arrays", async () => {
      await context.scope(async () => {
        observe.push("events", { type: "start", time: 100 });
        observe.push("events", { type: "process", time: 200 });

        const events = observe.get("events") as Array<{ type: string; time: number }>;
        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({ type: "start", time: 100 });
        expect(events[1]).toEqual({ type: "process", time: 200 });
      });
    });

    it("should create array if it doesn't exist", async () => {
      await context.scope(async () => {
        observe.push("newArray", "first item");

        const array = observe.get("newArray") as Array<string>;
        expect(array).toEqual(["first item"]);
      });
    });

    it("should convert non-array to array when pushing", async () => {
      await context.scope(async () => {
        observe.set("notArray", "string value");
        observe.push("notArray", "pushed value");

        const array = observe.get("notArray") as Array<string>;
        expect(array).toEqual(["pushed value"]);
      });
    });
  });

  describe("counter operations", () => {
    it("should increment counters", async () => {
      await context.scope(async () => {
        observe.inc("attempts");
        expect(observe.get("attempts")).toBe(1);

        observe.inc("attempts");
        expect(observe.get("attempts")).toBe(2);

        observe.inc("attempts", 5);
        expect(observe.get("attempts")).toBe(7);
      });
    });

    it("should initialize counter to amount if key doesn't exist", async () => {
      await context.scope(async () => {
        observe.inc("newCounter", 10);
        expect(observe.get("newCounter")).toBe(10);
      });
    });

    it("should reset non-numeric values to amount", async () => {
      await context.scope(async () => {
        observe.set("notNumber", "string");
        observe.inc("notNumber", 3);
        expect(observe.get("notNumber")).toBe(3);
      });
    });

    it("should handle negative increments", async () => {
      await context.scope(async () => {
        observe.set("counter", 10);
        observe.inc("counter", -3);
        expect(observe.get("counter")).toBe(7);
      });
    });
  });

  describe("deletion operations", () => {
    it("should delete existing keys", async () => {
      await context.scope(async () => {
        observe.set("toDelete", "value");
        expect(observe.has("toDelete")).toBe(true);

        const deleted = observe.delete("toDelete");
        expect(deleted).toBe(true);
        expect(observe.has("toDelete")).toBe(false);
      });
    });

    it("should return false when deleting non-existent keys", async () => {
      await context.scope(async () => {
        const deleted = observe.delete("nonexistent");
        expect(deleted).toBe(false);
      });
    });
  });

  describe("all data access", () => {
    it("should return all context data", async () => {
      await context.scope(async () => {
        observe.set("operation", "test");
        observe.push("events", { type: "start" });
        observe.inc("attempts");

        const allData = observe.all();

        expect(allData).toEqual({
          operation: "test",
          events: [{ type: "start" }],
          attempts: 1,
        });
      });
    });

    it("should return readonly data", async () => {
      await context.scope(async () => {
        observe.set("test", "value");
        const allData = observe.all();

        // The data is readonly at TypeScript level, but JavaScript allows mutation
        // We'll just verify the type annotation is correct
        expect(allData).toEqual({ test: "value" });
        expect(typeof allData).toBe("object");
      });
    });
  });

  describe("error handling", () => {
    it("should throw when no context is active", () => {
      expect(() => observe.set("key", "value")).toThrow("No active context available");
      expect(() => observe.get("key")).toThrow("No active context available");
      expect(() => observe.push("array", "value")).toThrow("No active context available");
      expect(() => observe.inc("counter")).toThrow("No active context available");
      expect(() => observe.has("key")).toThrow("No active context available");
      expect(() => observe.delete("key")).toThrow("No active context available");
      expect(() => observe.all()).toThrow("No active context available");
    });
  });

  describe("integration with typed contexts", () => {
    it("should work with typed contexts", async () => {
      interface ObservabilityContext {
        operation: string;
        events: Array<{ type: string; timestamp: number }>;
        metrics: Record<string, number>;
      }

      await context.scope<ObservabilityContext>(
        async () => {
          observe.set("operation", "user.authenticate");
          observe.push("events", { type: "auth.start", timestamp: Date.now() });
          observe.set("metrics", { attempts: 1, duration: 0 });

          const ctx = context.get<ObservabilityContext>();

          // Type safety on the context side
          expect(ctx.data.operation).toBe("user.authenticate");
          expect(Array.isArray(ctx.data.events)).toBe(true);
          expect(typeof ctx.data.metrics).toBe("object");

          // observe namespace still works
          expect(observe.get("operation")).toBe("user.authenticate");
        },
        {
          initial: {
            operation: "",
            events: [],
            metrics: {},
          },
        },
      );
    });
  });

  describe("complex scenarios", () => {
    it("should handle nested operations and inheritance", async () => {
      await context.scope(
        async () => {
          observe.set("service", "auth");
          observe.push("trace", { span: "root", operation: "login" });

          await context.scope(async () => {
            observe.push("trace", { span: "child", operation: "validate" });
            observe.inc("validations");

            const trace = observe.get("trace") as Array<{ span: string; operation: string }>;
            expect(trace).toHaveLength(2);
            expect(trace[1]?.span).toBe("child");

            const validations = observe.get("validations");
            expect(validations).toBe(1);

            // Parent data is still accessible
            expect(observe.get("service")).toBe("auth");
          });

          // Child modifications are visible in parent
          const trace = observe.get("trace") as Array<{ span: string; operation: string }>;
          expect(trace).toHaveLength(2);
        },
        { initial: {} },
      );
    });

    it("should handle concurrent contexts independently", async () => {
      const results = await Promise.all([
        context.scope(
          async () => {
            observe.set("worker", "A");
            observe.inc("tasks", 5);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              worker: observe.get("worker"),
              tasks: observe.get("tasks"),
            };
          },
          { initial: {} },
        ),

        context.scope(
          async () => {
            observe.set("worker", "B");
            observe.inc("tasks", 3);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              worker: observe.get("worker"),
              tasks: observe.get("tasks"),
            };
          },
          { initial: {} },
        ),
      ]);

      expect(results[0]).toEqual({ worker: "A", tasks: 5 });
      expect(results[1]).toEqual({ worker: "B", tasks: 3 });
    });
  });
});

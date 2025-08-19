import { describe, it, expect, beforeEach } from "vitest";
import { context } from "../src/index.js";

describe("Context - Static Data Bag", () => {
  beforeEach(() => {
    // Clear any global context before each test
    // @ts-expect-error - accessing internal state for testing purposes
    if (globalThis.__phyxius_context_runtime__) {
      // @ts-expect-error - accessing internal state for testing purposes
      globalThis.__phyxius_context_runtime__.globalContext = undefined;
      // @ts-expect-error - accessing internal state for testing purposes
      globalThis.__phyxius_context_runtime__.contextStore = undefined;
    }
  });

  describe("context.scope", () => {
    it("should create context scope and execute callback", async () => {
      const result = await context.scope(async () => {
        const ctx = context.require();
        expect(ctx.id).toBeDefined();

        context.set("test", "data");
        expect(context.get("test")).toBe("data");

        return "success";
      });

      expect(result).toBe("success");
    });

    it("should support initial data", async () => {
      await context.scope(
        async () => {
          const ctx = context.require();
          expect(ctx.data.get("initial")).toBe("value");
          expect(context.get("initial")).toBe("value");
        },
        { initial: "value" },
      );
    });

    it("should inherit from parent context", async () => {
      await context.scope(
        async () => {
          context.set("parent", "data");
          context.set("runtime", "added");

          await context.scope(async () => {
            expect(context.get("parent")).toBe("data");
            expect(context.get("runtime")).toBe("added");

            // Child context can override parent values
            context.set("runtime", "overridden");
            expect(context.get("runtime")).toBe("overridden");
          });

          // Parent context is unchanged
          expect(context.get("runtime")).toBe("added");
        },
        { initial: "parent" },
      );
    });

    it("should override inherited values with initial data", async () => {
      await context.scope(async () => {
        context.set("shared", "parent");
        context.set("unique", "parent");

        await context.scope(
          async () => {
            expect(context.get("shared")).toBe("override");
            expect(context.get("unique")).toBe("parent");
          },
          { shared: "override" },
        );
      });
    });
  });

  describe("data operations", () => {
    it("should set and get values", async () => {
      await context.scope(async () => {
        context.set("user_id", "user123");
        context.set("count", 42);
        context.set("active", true);

        expect(context.get("user_id")).toBe("user123");
        expect(context.get("count")).toBe(42);
        expect(context.get("active")).toBe(true);
        expect(context.get("nonexistent")).toBeUndefined();
      });
    });

    it("should push values to arrays", async () => {
      await context.scope(async () => {
        context.push("events", "login");
        context.push("events", "purchase");
        context.push("events", "logout");

        const events = context.get<string[]>("events");
        expect(events).toEqual(["login", "purchase", "logout"]);
      });
    });

    it("should merge objects", async () => {
      await context.scope(async () => {
        context.merge("metadata", { version: "1.0.0", env: "prod" });
        context.merge("metadata", { region: "us-east-1", debug: true });

        const metadata = context.get<Record<string, unknown>>("metadata");
        expect(metadata).toEqual({
          version: "1.0.0",
          env: "prod",
          region: "us-east-1",
          debug: true,
        });
      });
    });

    it("should handle mixed operations", async () => {
      await context.scope(async () => {
        // Set initial values
        context.set("user_id", "user123");
        context.merge("profile", { name: "Alice", role: "admin" });

        // Add events
        context.push("actions", "login");
        context.push("actions", "view_dashboard");

        // Merge more profile data
        context.merge("profile", { last_login: "2024-01-01" });

        // Verify all data
        expect(context.get("user_id")).toBe("user123");
        expect(context.get<string[]>("actions")).toEqual(["login", "view_dashboard"]);
        expect(context.get<Record<string, unknown>>("profile")).toEqual({
          name: "Alice",
          role: "admin",
          last_login: "2024-01-01",
        });
      });
    });
  });

  describe("error handling", () => {
    it("should throw when accessing context outside of scope", () => {
      expect(() => context.require()).toThrow("No active context available");
      expect(() => context.set("key", "value")).toThrow("No active context available");
      expect(() => context.get("key")).toThrow("No active context available");
    });

    it("should return undefined when no context is active", () => {
      const ctx = context.current();
      expect(ctx).toBeUndefined();
    });
  });

  describe("context isolation", () => {
    it("should isolate concurrent contexts", async () => {
      const results = await Promise.all([
        context.scope(async () => {
          context.set("worker", "A");
          await new Promise((resolve) => setTimeout(resolve, 10));
          return context.get("worker");
        }),
        context.scope(async () => {
          context.set("worker", "B");
          await new Promise((resolve) => setTimeout(resolve, 10));
          return context.get("worker");
        }),
      ]);

      expect(results).toEqual(["A", "B"]);
    });
  });
});

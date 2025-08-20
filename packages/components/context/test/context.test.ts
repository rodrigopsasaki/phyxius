import { describe, it, expect, beforeEach } from "vitest";
import { context } from "../src/index.js";

describe("Context - Pure AsyncLocalStorage Primitive", () => {
  beforeEach(() => {
    // Clear any global context state before each test
    // @ts-expect-error - accessing internal state for testing purposes
    if (globalThis.__phyxius_context_runtime__) {
      // @ts-expect-error - accessing internal state for testing purposes
      globalThis.__phyxius_context_runtime__.contextStore = undefined;
    }
  });

  describe("basic scoping", () => {
    it("should create context scope and provide access to data", async () => {
      const result = await context.scope(
        async () => {
          const ctx = context.get();
          expect(ctx.data).toBeDefined();
          expect(typeof ctx.data).toBe("object");

          return "success";
        },
        { initial: { service: "test" } },
      );

      expect(result).toBe("success");
    });

    it("should provide typed access to context data", async () => {
      interface UserSession {
        userId: string;
        permissions: string[];
      }

      await context.scope<UserSession>(
        async () => {
          const ctx = context.get<UserSession>();

          expect(ctx.data.userId).toBe("user123");
          expect(ctx.data.permissions).toEqual(["read", "write"]);
          expect(Array.isArray(ctx.data.permissions)).toBe(true);
        },
        {
          initial: {
            userId: "user123",
            permissions: ["read", "write"],
          },
        },
      );
    });

    it("should handle empty context", async () => {
      await context.scope(async () => {
        const ctx = context.get();
        expect(ctx.data).toEqual({});
      });
    });
  });

  describe("inheritance", () => {
    it("should inherit from parent context by default", async () => {
      await context.scope(
        async () => {
          await context.scope(
            async () => {
              const ctx = context.get();
              expect(ctx.data).toEqual({ parent: "data", child: "value" });
            },
            { initial: { child: "value" } },
          );
        },
        { initial: { parent: "data" } },
      );
    });

    it("should merge parent data with initial data", async () => {
      interface SessionData {
        userId: string;
        sessionId: string;
        permissions: string[];
      }

      await context.scope<SessionData>(
        async () => {
          await context.scope<SessionData>(
            async () => {
              const ctx = context.get<SessionData>();

              expect(ctx.data.userId).toBe("user123");
              expect(ctx.data.sessionId).toBe("child-session");
              expect(ctx.data.permissions).toEqual(["admin"]);
            },
            {
              initial: {
                sessionId: "child-session",
                permissions: ["admin"],
              },
            },
          );
        },
        {
          initial: {
            userId: "user123",
            sessionId: "parent-session",
            permissions: ["read"],
          },
        },
      );
    });

    it("should disable inheritance when inherit: false", async () => {
      await context.scope(
        async () => {
          await context.scope(
            async () => {
              const ctx = context.get();
              expect(ctx.data).toEqual({ child: "only" });
            },
            {
              initial: { child: "only" },
              inherit: false,
            },
          );
        },
        { initial: { parent: "data" } },
      );
    });

    it("should inherit parent data even without initial data", async () => {
      await context.scope(
        async () => {
          await context.scope(async () => {
            const ctx = context.get();
            expect(ctx.data).toEqual({ parent: "data" });
          });
        },
        { initial: { parent: "data" } },
      );
    });
  });

  describe("isolation", () => {
    it("should isolate concurrent contexts", async () => {
      interface WorkerContext {
        workerId: string;
        task: string;
      }

      const results = await Promise.all([
        context.scope<WorkerContext>(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const ctx = context.get<WorkerContext>();
            return ctx.data.workerId;
          },
          { initial: { workerId: "worker-A", task: "process" } },
        ),

        context.scope<WorkerContext>(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const ctx = context.get<WorkerContext>();
            return ctx.data.workerId;
          },
          { initial: { workerId: "worker-B", task: "process" } },
        ),
      ]);

      expect(results).toEqual(["worker-A", "worker-B"]);
    });

    it("should maintain context across async operations", async () => {
      interface AsyncContext {
        operationId: string;
        step: number;
      }

      await context.scope<AsyncContext>(
        async () => {
          const ctx1 = context.get<AsyncContext>();
          expect(ctx1.data.operationId).toBe("op-123");
          expect(ctx1.data.step).toBe(1);

          await new Promise((resolve) => setTimeout(resolve, 1));

          const ctx2 = context.get<AsyncContext>();
          expect(ctx2.data.operationId).toBe("op-123");
          expect(ctx2.data.step).toBe(1);
        },
        { initial: { operationId: "op-123", step: 1 } },
      );
    });
  });

  describe("error handling", () => {
    it("should throw when accessing context outside of scope", () => {
      expect(() => context.get()).toThrow("No active context available");
    });

    it("should return undefined when no context is active", () => {
      const ctx = context.current();
      expect(ctx).toBeUndefined();
    });

    it("should propagate errors from callback", async () => {
      await expect(async () => {
        await context.scope(async () => {
          throw new Error("Test error");
        });
      }).rejects.toThrow("Test error");
    });
  });

  describe("complex typing scenarios", () => {
    it("should support nested object types", async () => {
      interface ComplexContext {
        user: {
          id: string;
          profile: {
            name: string;
            preferences: {
              theme: "light" | "dark";
              notifications: boolean;
            };
          };
        };
        session: {
          id: string;
          expires: number;
        };
      }

      await context.scope<ComplexContext>(
        async () => {
          const ctx = context.get<ComplexContext>();

          expect(ctx.data.user.id).toBe("user123");
          expect(ctx.data.user.profile.name).toBe("Alice");
          expect(ctx.data.user.profile.preferences.theme).toBe("dark");
          expect(ctx.data.session.id).toBe("session456");
        },
        {
          initial: {
            user: {
              id: "user123",
              profile: {
                name: "Alice",
                preferences: {
                  theme: "dark",
                  notifications: true,
                },
              },
            },
            session: {
              id: "session456",
              expires: Date.now() + 3600000,
            },
          },
        },
      );
    });

    it("should support union types", async () => {
      type Status = "loading" | "success" | "error";

      interface StatusContext {
        status: Status;
        data?: unknown;
        error?: string;
      }

      await context.scope<StatusContext>(
        async () => {
          const ctx = context.get<StatusContext>();
          expect(ctx.data.status).toBe("success");
          expect(ctx.data.data).toBe("result");
          expect(ctx.data.error).toBeUndefined();
        },
        {
          initial: {
            status: "success" as Status,
            data: "result",
          },
        },
      );
    });
  });
});

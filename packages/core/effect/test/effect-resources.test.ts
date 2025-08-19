import { describe, it, expect, beforeEach } from "vitest";
import { effect, sleep, acquireUseRelease } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Effect Resources - RAII and Resource Management", () => {
  let events: unknown[] = [];
  const _emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("Resource lifecycle management", () => {
    it("should guarantee cleanup on successful completion", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const lifecycle: string[] = [];

      const resourceEffect = acquireUseRelease(
        // Acquire
        effect(async () => {
          lifecycle.push("acquired");
          return { _tag: "Ok", value: "resource" };
        }),

        // Use
        (resource: string) =>
          effect(async () => {
            lifecycle.push(`using-${resource}`);
            return { _tag: "Ok", value: undefined };
          })
            .flatMap(() => sleep(100))
            .flatMap(() =>
              effect(async () => {
                lifecycle.push("work-done");
                return { _tag: "Ok", value: "result" };
              }),
            ),

        // Release
        (resource: string, cause: "ok" | "error" | "interrupted") =>
          effect(async () => {
            lifecycle.push(`released-${resource}-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const resultPromise = resourceEffect.unsafeRunPromise({ clock });

      // Allow time for acquire and use to start
      await clock.flush();

      clock.advanceBy(100);
      await clock.flush();

      const result = await resultPromise;

      expect(result).toEqual({ _tag: "Ok", value: "result" });
      expect(lifecycle).toEqual(["acquired", "using-resource", "work-done", "released-resource-ok"]);
    }, 10000);

    it("should guarantee cleanup on error", async () => {
      const lifecycle: string[] = [];

      const resourceEffect = acquireUseRelease(
        // Acquire
        effect(async () => {
          lifecycle.push("acquired");
          return { _tag: "Ok", value: "resource" };
        }),

        // Use (fails)
        (resource: string) =>
          effect(async () => {
            lifecycle.push(`using-${resource}`);
            return { _tag: "Err", error: "use failed" };
          }),

        // Release
        (resource: string, cause: "ok" | "error" | "interrupted") =>
          effect(async () => {
            lifecycle.push(`released-${resource}-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await resourceEffect.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Err", error: "use failed" });
      expect(lifecycle).toEqual(["acquired", "using-resource", "released-resource-error"]);
    });

    it("should guarantee cleanup on interruption", async () => {
      const clock = createControlledClock({ initialTime: 0 });
      const lifecycle: string[] = [];

      const resourceEffect = acquireUseRelease(
        // Acquire
        effect(async () => {
          lifecycle.push("acquired");
          return { _tag: "Ok", value: "resource" };
        }),

        // Use (long running)
        (resource: string) =>
          effect(async (env) => {
            lifecycle.push(`using-${resource}`);

            // Long operation that checks for cancellation
            for (let i = 0; i < 10; i++) {
              if (env.cancel.isCanceled()) {
                lifecycle.push("use-cancelled");
                return { _tag: "Err", error: "cancelled" };
              }
              // Use clock.sleep directly
              if (env.clock && typeof env.clock.sleep === "function") {
                await env.clock.sleep(100);
              } else {
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }

            return { _tag: "Ok", value: "completed" };
          }),

        // Release
        (resource: string, cause: "ok" | "error" | "interrupted") =>
          effect(async () => {
            lifecycle.push(`released-${resource}-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      // Fork the resource effect
      const fiberResult = await resourceEffect.fork().unsafeRunPromise({ clock });
      const fiber = fiberResult.value;

      // Let it acquire and start using
      clock.advanceBy(150);
      await clock.flush();

      // Interrupt it
      await fiber.interrupt().unsafeRunPromise({ clock });

      // Join to see the result
      const _result = await fiber.join().unsafeRunPromise({ clock });

      expect(lifecycle).toContain("acquired");
      expect(lifecycle).toContain("using-resource");
      expect(lifecycle).toContain("released-resource-interrupted");
    });

    it("should handle acquire failure", async () => {
      const lifecycle: string[] = [];

      const resourceEffect = acquireUseRelease(
        // Acquire (fails)
        effect(async () => {
          lifecycle.push("acquire-attempted");
          return { _tag: "Err", error: "acquire failed" };
        }),

        // Use (should not be called)
        (_resource: string) =>
          effect(async () => {
            lifecycle.push("use-should-not-happen");
            return { _tag: "Ok", value: "result" };
          }),

        // Release (should not be called)
        (_resource: string, _cause: "ok" | "error" | "interrupted") =>
          effect(async () => {
            lifecycle.push("release-should-not-happen");
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await resourceEffect.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Err", error: "acquire failed" });
      expect(lifecycle).toEqual(["acquire-attempted"]);
    });
  });

  describe("Nested resource management", () => {
    it("should handle nested resource scopes correctly", async () => {
      const lifecycle: string[] = [];

      const outerResource = acquireUseRelease(
        effect(async () => {
          lifecycle.push("outer-acquired");
          return { _tag: "Ok", value: "outer" };
        }),

        (outer: string) => {
          // Nested resource inside
          const innerResource = acquireUseRelease(
            effect(async () => {
              lifecycle.push("inner-acquired");
              return { _tag: "Ok", value: "inner" };
            }),

            (inner: string) =>
              effect(async () => {
                lifecycle.push(`using-${outer}-${inner}`);
                return { _tag: "Ok", value: `${outer}-${inner}-result` };
              }),

            (inner: string, cause) =>
              effect(async () => {
                lifecycle.push(`inner-released-${cause}`);
                return { _tag: "Ok", value: undefined };
              }),
          );

          return innerResource;
        },

        (outer: string, cause) =>
          effect(async () => {
            lifecycle.push(`outer-released-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await outerResource.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Ok", value: "outer-inner-result" });
      expect(lifecycle).toEqual([
        "outer-acquired",
        "inner-acquired",
        "using-outer-inner",
        "inner-released-ok",
        "outer-released-ok",
      ]);
    });

    it("should cleanup outer resource even if inner fails", async () => {
      const lifecycle: string[] = [];

      const outerResource = acquireUseRelease(
        effect(async () => {
          lifecycle.push("outer-acquired");
          return { _tag: "Ok", value: "outer" };
        }),

        (outer: string) => {
          const innerResource = acquireUseRelease(
            effect(async () => {
              lifecycle.push("inner-acquired");
              return { _tag: "Ok", value: "inner" };
            }),

            (inner: string) =>
              effect(async () => {
                lifecycle.push(`using-${outer}-${inner}`);
                return { _tag: "Err", error: "inner use failed" };
              }),

            (inner: string, cause) =>
              effect(async () => {
                lifecycle.push(`inner-released-${cause}`);
                return { _tag: "Ok", value: undefined };
              }),
          );

          return innerResource;
        },

        (outer: string, cause) =>
          effect(async () => {
            lifecycle.push(`outer-released-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await outerResource.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Err", error: "inner use failed" });
      expect(lifecycle).toEqual([
        "outer-acquired",
        "inner-acquired",
        "using-outer-inner",
        "inner-released-error",
        "outer-released-error",
      ]);
    });
  });

  describe("Resource release error handling", () => {
    it("should ignore release errors and not fail the original result", async () => {
      const lifecycle: string[] = [];

      const resourceEffect = acquireUseRelease(
        effect(async () => {
          lifecycle.push("acquired");
          return { _tag: "Ok", value: "resource" };
        }),

        (_resource: string) =>
          effect(async () => {
            lifecycle.push("used");
            return { _tag: "Ok", value: "success" };
          }),

        (_resource: string, _cause) =>
          effect(async () => {
            lifecycle.push("release-attempted");
            throw new Error("release failed");
          }),
      );

      const result = await resourceEffect.unsafeRunPromise();

      // Original result should be preserved despite release failure
      expect(result).toEqual({ _tag: "Ok", value: "success" });
      expect(lifecycle).toEqual(["acquired", "used", "release-attempted"]);
    });

    it("should try to release even if use throws an exception", async () => {
      const lifecycle: string[] = [];

      const resourceEffect = acquireUseRelease(
        effect(async () => {
          lifecycle.push("acquired");
          return { _tag: "Ok", value: "resource" };
        }),

        (_resource: string) =>
          effect(async () => {
            lifecycle.push("use-started");
            throw new Error("use threw exception");
          }),

        (resource: string, cause) =>
          effect(async () => {
            lifecycle.push(`released-${cause}`);
            return { _tag: "Ok", value: undefined };
          }),
      );

      const result = await resourceEffect.unsafeRunPromise();

      expect(result._tag).toBe("Err");
      expect((result.error as Error).message).toBe("use threw exception");
      expect(lifecycle).toEqual(["acquired", "use-started", "released-error"]);
    });
  });
});

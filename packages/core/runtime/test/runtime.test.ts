import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { ok, err, isOk, isErr } from "@phyxiusjs/fp";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { defineFunction, ServiceError } from "@phyxiusjs/service";
import type { DataContext, DomainContext } from "@phyxiusjs/service";
import { createRuntime } from "../src/runtime.js";

describe("createRuntime", () => {
  let clock: ReturnType<typeof createControlledClock>;

  beforeEach(() => {
    clock = createControlledClock({ initialTime: 1000000 });
  });

  describe("basic execution", () => {
    it("should execute a simple function successfully", async () => {
      const runtime = createRuntime({ clock });

      const fn = defineFunction({
        layer: "data",
        name: "test.simple",
        input: z.object({ value: z.number() }),
        output: z.object({ result: z.number() }),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async (_ctx: DataContext, input) => {
          return ok({ result: input.value * 2 });
        },
      });

      const result = await runtime.execute(fn, { value: 5 });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toEqual({ result: 10 });
      }
    });

    it("should return error for handler failure", async () => {
      const runtime = createRuntime({ clock });

      const fn = defineFunction({
        layer: "data",
        name: "test.failing",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async () => {
          return err(ServiceError.notFound("Resource", "123"));
        },
      });

      const result = await runtime.execute(fn, {});

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("input validation", () => {
    it("should validate input against schema", async () => {
      const runtime = createRuntime({ clock });

      const fn = defineFunction({
        layer: "data",
        name: "test.validation",
        input: z.object({ email: z.string().email() }),
        output: z.boolean(),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async () => ok(true),
      });

      const result = await runtime.execute(fn, { email: "not-an-email" });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("Invalid input");
      }
    });
  });

  describe("output validation", () => {
    it("should validate output against schema", async () => {
      const runtime = createRuntime({ clock });

      const fn = defineFunction({
        layer: "data",
        name: "test.outputvalidation",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async () => {
          // Return wrong type
          return ok({ count: "not a number" } as never);
        },
      });

      const result = await runtime.execute(fn, {});

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("INTERNAL_ERROR");
        expect(result.error.message).toContain("Invalid output");
      }
    });
  });

  describe("timeout", () => {
    it("should timeout slow operations", async () => {
      const runtime = createRuntime({ clock });

      const fn = defineFunction({
        layer: "data",
        name: "test.slow",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: ms(1000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async () => {
          // This will be interrupted by timeout
          await clock.sleep(ms(5000));
          return ok(undefined);
        },
      });

      // Start execution
      const resultPromise = runtime.execute(fn, {});

      // Advance clock past timeout
      clock.advanceBy(ms(1001));
      await clock.flush();

      const result = await resultPromise;

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("TIMEOUT");
      }
    });

    it("should allow unlimited timeout with none", async () => {
      const runtime = createRuntime({ clock });

      const fn = defineFunction({
        layer: "data",
        name: "test.notimeout",
        input: z.object({}),
        output: z.object({ done: z.boolean() }),
        policy: {
          timeout: "none",
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async () => ok({ done: true }),
      });

      const result = await runtime.execute(fn, {});

      expect(isOk(result)).toBe(true);
    });
  });

  describe("retry", () => {
    it("should retry on retryable errors", async () => {
      const runtime = createRuntime({ clock });
      let attempts = 0;

      const fn = defineFunction({
        layer: "data",
        name: "test.retry",
        input: z.object({}),
        output: z.object({ success: z.boolean() }),
        policy: {
          timeout: ms(5000),
          retry: {
            attempts: 3,
            backoff: "fixed",
            baseDelay: ms(100),
            on: ["TIMEOUT"],
          },
          circuitBreaker: "none",
        },
        handler: async () => {
          attempts++;
          if (attempts < 3) {
            return err(ServiceError.timeout("Timeout"));
          }
          return ok({ success: true });
        },
      });

      // Start execution
      const resultPromise = runtime.execute(fn, {});

      // Let the runtime reach its first sleep (retry delay)
      // Multiple yields needed for nested async operations
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Advance clock for first retry
      clock.advanceBy(ms(101));
      await clock.flush();

      // Let runtime reach second retry sleep
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Advance clock for second retry
      clock.advanceBy(ms(101));
      await clock.flush();

      const result = await resultPromise;

      expect(isOk(result)).toBe(true);
      expect(attempts).toBe(3);
    });

    it("should not retry non-retryable errors", async () => {
      const runtime = createRuntime({ clock });
      let attempts = 0;

      const fn = defineFunction({
        layer: "data",
        name: "test.noretry",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: ms(5000),
          retry: {
            attempts: 3,
            backoff: "fixed",
            baseDelay: ms(100),
            on: ["TIMEOUT"],
          },
          circuitBreaker: "none",
        },
        handler: async () => {
          attempts++;
          return err(ServiceError.notFound("Resource", "123"));
        },
      });

      const result = await runtime.execute(fn, {});

      expect(isErr(result)).toBe(true);
      expect(attempts).toBe(1);
    });
  });

  describe("circuit breaker", () => {
    it("should open circuit after threshold failures", async () => {
      const runtime = createRuntime({ clock });

      const fn = defineFunction({
        layer: "data",
        name: "test.circuit",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: {
            threshold: 2,
            resetAfter: ms(30000),
          },
        },
        handler: async () => {
          return err(ServiceError.timeout("Timeout"));
        },
      });

      // First two failures should execute
      await runtime.execute(fn, {});
      await runtime.execute(fn, {});

      // Third call should be blocked by circuit breaker
      const result = await runtime.execute(fn, {});

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("CIRCUIT_OPEN");
      }
    });

    it("should allow bypass with skipCircuitBreaker option", async () => {
      const runtime = createRuntime({ clock });
      let callCount = 0;

      const fn = defineFunction({
        layer: "data",
        name: "test.bypasscircuit",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: {
            threshold: 2,
            resetAfter: ms(30000),
          },
        },
        handler: async () => {
          callCount++;
          return err(ServiceError.timeout("Timeout"));
        },
      });

      // Trip the circuit
      await runtime.execute(fn, {});
      await runtime.execute(fn, {});

      // This should bypass circuit breaker
      await runtime.execute(fn, {}, { skipCircuitBreaker: true });

      expect(callCount).toBe(3);
    });
  });

  describe("hooks", () => {
    it("should call onStart hook", async () => {
      const onStart = vi.fn();
      const runtime = createRuntime({ clock, hooks: { onStart } });

      const fn = defineFunction({
        layer: "data",
        name: "test.hooks",
        input: z.object({ value: z.number() }),
        output: z.number(),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async (_ctx, input) => ok(input.value),
      });

      await runtime.execute(fn, { value: 42 });

      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "test.hooks",
          layer: "data",
          input: { value: 42 },
        }),
      );
    });

    it("should call onSuccess hook on success", async () => {
      const onSuccess = vi.fn();
      const runtime = createRuntime({ clock, hooks: { onSuccess } });

      const fn = defineFunction({
        layer: "data",
        name: "test.success",
        input: z.object({}),
        output: z.object({ result: z.string() }),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async () => ok({ result: "done" }),
      });

      await runtime.execute(fn, {});

      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "test.success",
          output: { result: "done" },
          attempts: 1,
        }),
      );
    });

    it("should call onError hook on failure", async () => {
      const onError = vi.fn();
      const runtime = createRuntime({ clock, hooks: { onError } });

      const fn = defineFunction({
        layer: "data",
        name: "test.error",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async () => err(ServiceError.notFound("Test", "123")),
      });

      await runtime.execute(fn, {});

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "test.error",
          attempts: 1,
        }),
      );
    });

    it("should call onRetry hook", async () => {
      const onRetry = vi.fn();
      const runtime = createRuntime({ clock, hooks: { onRetry } });
      let attempts = 0;

      const fn = defineFunction({
        layer: "data",
        name: "test.retryhook",
        input: z.object({}),
        output: z.object({ success: z.boolean() }),
        policy: {
          timeout: ms(5000),
          retry: {
            attempts: 2,
            backoff: "fixed",
            baseDelay: ms(100),
            on: ["TIMEOUT"],
          },
          circuitBreaker: "none",
        },
        handler: async () => {
          attempts++;
          if (attempts < 2) {
            return err(ServiceError.timeout("Timeout"));
          }
          return ok({ success: true });
        },
      });

      const resultPromise = runtime.execute(fn, {});

      // Let the runtime reach its first sleep (retry delay)
      for (let i = 0; i < 10; i++) await Promise.resolve();

      clock.advanceBy(ms(101));
      await clock.flush();
      await resultPromise;

      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "test.retryhook",
          attempt: 1,
          maxAttempts: 2,
        }),
      );
    });
  });

  describe("layer contexts", () => {
    it("should provide data context for data layer functions", async () => {
      const runtime = createRuntime({ clock });
      let receivedContext: DataContext | undefined;

      const fn = defineFunction({
        layer: "data",
        name: "test.datacontext",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async (ctx: DataContext) => {
          receivedContext = ctx;
          return ok(undefined);
        },
      });

      await runtime.execute(fn, {});

      expect(receivedContext?._layer).toBe("data");
      expect(receivedContext?.clock).toBeDefined();
      expect(receivedContext?.observe).toBeDefined();
      expect(receivedContext?.execution).toBeDefined();
    });

    it("should provide domain context with call capability", async () => {
      const runtime = createRuntime({ clock });
      let receivedContext: DomainContext | undefined;

      const fn = defineFunction({
        layer: "domain",
        name: "test.domaincontext",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async (ctx: DomainContext) => {
          receivedContext = ctx;
          return ok(undefined);
        },
      });

      await runtime.execute(fn, {});

      expect(receivedContext?._layer).toBe("domain");
      expect(receivedContext?.call).toBeDefined();
    });

    it("should allow domain layer to call data layer", async () => {
      const runtime = createRuntime({ clock });

      const dataFn = defineFunction({
        layer: "data",
        name: "test.data",
        input: z.object({ id: z.string() }),
        output: z.object({ name: z.string() }),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async (_ctx, input) => ok({ name: `User ${input.id}` }),
      });

      const domainFn = defineFunction({
        layer: "domain",
        name: "test.domain",
        input: z.object({ userId: z.string() }),
        output: z.object({ greeting: z.string() }),
        policy: {
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async (ctx: DomainContext, input) => {
          const userResult = await ctx.call(dataFn, { id: input.userId });
          if (isErr(userResult)) {
            return err(userResult.error);
          }
          return ok({ greeting: `Hello, ${userResult.value.name}!` });
        },
      });

      const result = await runtime.execute(domainFn, { userId: "123" });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toEqual({ greeting: "Hello, User 123!" });
      }
    });
  });
});

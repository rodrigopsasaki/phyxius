import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ok, err } from "@phyxiusjs/fp";
import { ms } from "@phyxiusjs/clock";
import { defineFunction, isServiceFunction, functionRef } from "../src/function.js";
import { ServiceError } from "../src/errors.js";
import type { DataContext, DomainContext, OrchestrationContext } from "../src/types.js";

describe("defineFunction", () => {
  describe("valid definitions", () => {
    it("should create a data layer function with all required fields", () => {
      const fn = defineFunction({
        layer: "data",
        name: "user.getbyid",
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string(), name: z.string() }),
        policy: {
          timeout: ms(5000),
          retry: { attempts: 3, backoff: "exponential", on: ["CONNECTION_ERROR"] },
          circuitBreaker: { threshold: 5, resetAfter: ms(30000) },
        },
        handler: async (_ctx: DataContext, _input) => {
          return ok({ id: "123", name: "Test" });
        },
      });

      expect(fn._tag).toBe("ServiceFunction");
      expect(fn.layer).toBe("data");
      expect(fn.name).toBe("user.getbyid");
      expect(fn.policy.timeout).toBe(5000);
    });

    it("should create a domain layer function", () => {
      const fn = defineFunction({
        layer: "domain",
        name: "user.validate",
        input: z.object({ email: z.string() }),
        output: z.boolean(),
        policy: {
          timeout: ms(1000),
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async (_ctx: DomainContext, _input) => {
          return ok(true);
        },
      });

      expect(fn.layer).toBe("domain");
      expect(fn.policy.retry).toBe("none");
      expect(fn.policy.circuitBreaker).toBe("none");
    });

    it("should create an orchestration layer function", () => {
      const fn = defineFunction({
        layer: "orchestration",
        name: "purchase.process",
        input: z.object({ purchaseId: z.string() }),
        output: z.object({ success: z.boolean() }),
        policy: {
          timeout: ms(30000),
          retry: { attempts: 5, backoff: "exponential", baseDelay: ms(1000), on: ["TIMEOUT", "CONNECTION_ERROR"] },
          circuitBreaker: { threshold: 10, resetAfter: ms(60000) },
        },
        handler: async (_ctx: OrchestrationContext, _input) => {
          return ok({ success: true });
        },
      });

      expect(fn.layer).toBe("orchestration");
      expect(fn.policy.retry).not.toBe("none");
      if (fn.policy.retry !== "none") {
        expect(fn.policy.retry.attempts).toBe(5);
      }
    });

    it("should accept timeout: none for unlimited timeout", () => {
      const fn = defineFunction({
        layer: "data",
        name: "data.longrunning",
        input: z.object({}),
        output: z.void(),
        policy: {
          timeout: "none",
          retry: "none",
          circuitBreaker: "none",
        },
        handler: async () => ok(undefined),
      });

      expect(fn.policy.timeout).toBe("none");
    });
  });

  describe("invalid definitions", () => {
    it("should throw on missing name", () => {
      expect(() =>
        defineFunction({
          layer: "data",
          name: "",
          input: z.object({}),
          output: z.void(),
          policy: { timeout: ms(1000), retry: "none", circuitBreaker: "none" },
          handler: async () => ok(undefined),
        }),
      ).toThrow("non-empty name");
    });

    it("should throw on invalid name format", () => {
      expect(() =>
        defineFunction({
          layer: "data",
          name: "Invalid-Name",
          input: z.object({}),
          output: z.void(),
          policy: { timeout: ms(1000), retry: "none", circuitBreaker: "none" },
          handler: async () => ok(undefined),
        }),
      ).toThrow("lowercase");
    });

    it("should throw on invalid layer", () => {
      expect(() =>
        defineFunction({
          layer: "invalid" as "data",
          name: "data.test",
          input: z.object({}),
          output: z.void(),
          policy: { timeout: ms(1000), retry: "none", circuitBreaker: "none" },
          handler: async () => ok(undefined),
        }),
      ).toThrow("Invalid layer");
    });

    it("should throw on negative timeout", () => {
      expect(() =>
        defineFunction({
          layer: "data",
          name: "data.test",
          input: z.object({}),
          output: z.void(),
          policy: { timeout: ms(-100), retry: "none", circuitBreaker: "none" },
          handler: async () => ok(undefined),
        }),
      ).toThrow("Invalid timeout");
    });

    it("should throw on invalid retry attempts", () => {
      expect(() =>
        defineFunction({
          layer: "data",
          name: "data.test",
          input: z.object({}),
          output: z.void(),
          policy: {
            timeout: ms(1000),
            retry: { attempts: -1, backoff: "exponential", on: ["TIMEOUT"] },
            circuitBreaker: "none",
          },
          handler: async () => ok(undefined),
        }),
      ).toThrow("Invalid retry attempts");
    });

    it("should throw on empty retry conditions", () => {
      expect(() =>
        defineFunction({
          layer: "data",
          name: "data.test",
          input: z.object({}),
          output: z.void(),
          policy: {
            timeout: ms(1000),
            retry: { attempts: 3, backoff: "exponential", on: [] },
            circuitBreaker: "none",
          },
          handler: async () => ok(undefined),
        }),
      ).toThrow("at least one condition");
    });

    it("should throw on invalid circuit breaker threshold", () => {
      expect(() =>
        defineFunction({
          layer: "data",
          name: "data.test",
          input: z.object({}),
          output: z.void(),
          policy: {
            timeout: ms(1000),
            retry: "none",
            circuitBreaker: { threshold: 0, resetAfter: ms(30000) },
          },
          handler: async () => ok(undefined),
        }),
      ).toThrow("Invalid circuit breaker threshold");
    });
  });
});

describe("isServiceFunction", () => {
  it("should return true for a service function", () => {
    const fn = defineFunction({
      layer: "data",
      name: "data.test",
      input: z.object({}),
      output: z.void(),
      policy: { timeout: ms(1000), retry: "none", circuitBreaker: "none" },
      handler: async () => ok(undefined),
    });

    expect(isServiceFunction(fn)).toBe(true);
  });

  it("should return false for non-service functions", () => {
    expect(isServiceFunction({})).toBe(false);
    expect(isServiceFunction(null)).toBe(false);
    expect(isServiceFunction(undefined)).toBe(false);
    expect(isServiceFunction({ _tag: "Something" })).toBe(false);
  });
});

describe("functionRef", () => {
  it("should create a reference without the handler", () => {
    const fn = defineFunction({
      layer: "data",
      name: "data.test",
      input: z.object({ id: z.string() }),
      output: z.object({ name: z.string() }),
      policy: { timeout: ms(1000), retry: "none", circuitBreaker: "none" },
      handler: async () => ok({ name: "Test" }),
    });

    const ref = functionRef(fn);

    expect(ref._tag).toBe("ServiceFunction");
    expect(ref.layer).toBe("data");
    expect(ref.name).toBe("data.test");
    expect("handler" in ref).toBe(false);
    expect("policy" in ref).toBe(false);
  });
});

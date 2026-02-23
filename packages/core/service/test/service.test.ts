import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ok } from "@phyxiusjs/fp";
import { ms } from "@phyxiusjs/clock";
import { defineFunction } from "../src/function.js";
import { defineService, isService, getFunctionNames } from "../src/service.js";
import type { DataContext, DomainContext } from "../src/types.js";

describe("defineService", () => {
  // Create some test functions
  const getUser = defineFunction({
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

  const validateEmail = defineFunction({
    layer: "domain",
    name: "user.validateemail",
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

  describe("valid definitions", () => {
    it("should create a service with functions", () => {
      const service = defineService({
        name: "user-service",
        functions: [getUser, validateEmail],
      });

      expect(service._tag).toBe("Service");
      expect(service.name).toBe("user-service");
      expect(service.functions).toHaveLength(2);
    });

    it("should allow getting functions by name", () => {
      const service = defineService({
        name: "user-service",
        functions: [getUser, validateEmail],
      });

      const fn = service.get("user.getbyid");
      expect(fn).toBeDefined();
      expect(fn?.name).toBe("user.getbyid");
      expect(fn?.layer).toBe("data");
    });

    it("should return undefined for non-existent function", () => {
      const service = defineService({
        name: "user-service",
        functions: [getUser],
      });

      const fn = service.get("nonexistent" as "user.getbyid");
      expect(fn).toBeUndefined();
    });

    it("should accept default policies", () => {
      const service = defineService({
        name: "user-service",
        functions: [getUser],
        defaults: {
          timeout: ms(10000),
          circuitBreaker: { threshold: 10, resetAfter: ms(60000) },
        },
      });

      expect(service.defaults?.timeout).toBe(10000);
    });

    it("should accept observe hooks", () => {
      const onStart = () => {};
      const service = defineService({
        name: "user-service",
        functions: [getUser],
        observe: {
          onStart,
        },
      });

      expect(service.observe?.onStart).toBe(onStart);
    });
  });

  describe("invalid definitions", () => {
    it("should throw on empty name", () => {
      expect(() =>
        defineService({
          name: "",
          functions: [getUser],
        }),
      ).toThrow("non-empty name");
    });

    it("should throw on invalid name format", () => {
      expect(() =>
        defineService({
          name: "UserService",
          functions: [getUser],
        }),
      ).toThrow("lowercase");
    });

    it("should throw on empty functions array", () => {
      expect(() =>
        defineService({
          name: "user-service",
          functions: [],
        }),
      ).toThrow("at least one function");
    });

    it("should throw on duplicate function names", () => {
      expect(() =>
        defineService({
          name: "user-service",
          functions: [getUser, getUser],
        }),
      ).toThrow("Duplicate function name");
    });

    it("should throw on invalid function", () => {
      expect(() =>
        defineService({
          name: "user-service",
          functions: [{ name: "invalid" }] as never,
        }),
      ).toThrow("not a ServiceFunction");
    });
  });
});

describe("isService", () => {
  it("should return true for a service", () => {
    const getUser = defineFunction({
      layer: "data",
      name: "user.getbyid",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      policy: { timeout: ms(1000), retry: "none", circuitBreaker: "none" },
      handler: async () => ok({ id: "123" }),
    });

    const service = defineService({
      name: "user-service",
      functions: [getUser],
    });

    expect(isService(service)).toBe(true);
  });

  it("should return false for non-services", () => {
    expect(isService({})).toBe(false);
    expect(isService(null)).toBe(false);
    expect(isService(undefined)).toBe(false);
    expect(isService({ _tag: "Something" })).toBe(false);
  });
});

describe("getFunctionNames", () => {
  it("should return all function names", () => {
    const fn1 = defineFunction({
      layer: "data",
      name: "user.get",
      input: z.object({}),
      output: z.void(),
      policy: { timeout: ms(1000), retry: "none", circuitBreaker: "none" },
      handler: async () => ok(undefined),
    });

    const fn2 = defineFunction({
      layer: "data",
      name: "user.create",
      input: z.object({}),
      output: z.void(),
      policy: { timeout: ms(1000), retry: "none", circuitBreaker: "none" },
      handler: async () => ok(undefined),
    });

    const service = defineService({
      name: "user-service",
      functions: [fn1, fn2],
    });

    const names = getFunctionNames(service);
    expect(names).toEqual(["user.get", "user.create"]);
  });
});

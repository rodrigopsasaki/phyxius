import { describe, it, expect } from "vitest";
import { createObserveContext } from "../src/observe.js";

describe("createObserveContext", () => {
  describe("set", () => {
    it("should set a value", () => {
      const ctx = createObserveContext();
      ctx.set("key", "value");

      expect(ctx.all()).toEqual({ key: "value" });
    });

    it("should overwrite existing value", () => {
      const ctx = createObserveContext();
      ctx.set("key", "value1");
      ctx.set("key", "value2");

      expect(ctx.all()).toEqual({ key: "value2" });
    });
  });

  describe("push", () => {
    it("should create array and push value", () => {
      const ctx = createObserveContext();
      ctx.push("items", "first");

      expect(ctx.all()).toEqual({ items: ["first"] });
    });

    it("should append to existing array", () => {
      const ctx = createObserveContext();
      ctx.push("items", "first");
      ctx.push("items", "second");

      expect(ctx.all()).toEqual({ items: ["first", "second"] });
    });

    it("should replace non-array with array", () => {
      const ctx = createObserveContext();
      ctx.set("items", "not an array");
      ctx.push("items", "value");

      expect(ctx.all()).toEqual({ items: ["value"] });
    });
  });

  describe("inc", () => {
    it("should initialize counter to amount", () => {
      const ctx = createObserveContext();
      ctx.inc("count");

      expect(ctx.all()).toEqual({ count: 1 });
    });

    it("should increment with default amount of 1", () => {
      const ctx = createObserveContext();
      ctx.inc("count");
      ctx.inc("count");

      expect(ctx.all()).toEqual({ count: 2 });
    });

    it("should increment by specified amount", () => {
      const ctx = createObserveContext();
      ctx.inc("count", 5);
      ctx.inc("count", 3);

      expect(ctx.all()).toEqual({ count: 8 });
    });

    it("should replace non-number with amount", () => {
      const ctx = createObserveContext();
      ctx.set("count", "not a number");
      ctx.inc("count", 5);

      expect(ctx.all()).toEqual({ count: 5 });
    });
  });

  describe("all", () => {
    it("should return a copy of data", () => {
      const ctx = createObserveContext();
      ctx.set("key", "value");

      const data = ctx.all();
      // Modify the returned object
      (data as Record<string, unknown>).key = "modified";

      // Original should be unchanged
      expect(ctx.all()).toEqual({ key: "value" });
    });
  });
});

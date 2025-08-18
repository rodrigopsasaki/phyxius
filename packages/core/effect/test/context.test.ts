import { describe, it, expect } from "vitest";
import { createContext, ContextImpl } from "../src/index.js";

describe("Context", () => {
  describe("createContext", () => {
    it("should create empty context", () => {
      const context = createContext();
      expect(context.values.size).toBe(0);
    });

    it("should create context with initial values", () => {
      const initial = new Map([["key", "value"]]);
      const context = createContext(initial);

      expect(context.values.size).toBe(1);
      expect(context.get("key")).toBe("value");
    });
  });

  describe("ContextImpl", () => {
    it("should get values", () => {
      const context = new ContextImpl(new Map([["key", "value"]]));
      expect(context.get("key")).toBe("value");
      expect(context.get("nonexistent")).toBeUndefined();
    });

    it("should return typed values", () => {
      const context = new ContextImpl(
        new Map([
          ["number", 42],
          ["string", "hello"],
        ]),
      );

      const num = context.get<number>("number");
      const str = context.get<string>("string");

      expect(num).toBe(42);
      expect(str).toBe("hello");
    });

    it("should create new context with additional values", () => {
      const original = createContext().with("key1", "value1");
      const extended = original.with("key2", "value2");

      expect(original.get("key2")).toBeUndefined();
      expect(extended.get("key1")).toBe("value1");
      expect(extended.get("key2")).toBe("value2");
    });

    it("should override existing values", () => {
      const context = createContext().with("key", "original").with("key", "updated");

      expect(context.get("key")).toBe("updated");
    });

    it("should maintain immutability", () => {
      const original = createContext().with("key", "value");
      const modified = original.with("key", "new value");

      expect(original.get("key")).toBe("value");
      expect(modified.get("key")).toBe("new value");
    });

    it("should handle complex value types", () => {
      const obj = { nested: { value: 42 } };
      const arr = [1, 2, 3];

      const context = createContext().with("object", obj).with("array", arr);

      expect(context.get<typeof obj>("object")).toBe(obj);
      expect(context.get<typeof arr>("array")).toBe(arr);
    });
  });
});

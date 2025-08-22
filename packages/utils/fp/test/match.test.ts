import { describe, it, expect } from "vitest";
import {
  match,
  matchValue,
  matchTag,
  matchPartial,
  matchBool,
  matchNullable,
  matchNumber,
  matchString,
  exhaustive,
} from "../src/match.js";

describe("Pattern Matching", () => {
  describe("Matcher", () => {
    it("should match exact values", () => {
      const result = match(42)
        .when(42, () => "forty-two")
        .when(0, () => "zero")
        .otherwise(() => "other");

      expect(result).toBe("forty-two");
    });

    it("should match with predicates", () => {
      const result = match(15)
        .whenPredicate(
          (x) => x > 10,
          () => "big",
        )
        .whenPredicate(
          (x) => x > 0,
          () => "positive",
        )
        .otherwise(() => "other");

      expect(result).toBe("big");
    });

    it("should match with type guards", () => {
      const value: string | number = "hello";

      const result = match(value)
        .whenGuard(
          (v): v is string => typeof v === "string",
          (s) => `string: ${s}`,
        )
        .whenGuard(
          (v): v is number => typeof v === "number",
          (n) => `number: ${n}`,
        )
        .otherwise(() => "unknown");

      expect(result).toBe("string: hello");
    });

    it("should use otherwise for unmatched values", () => {
      const result = match(100)
        .when(42, () => "forty-two")
        .when(0, () => "zero")
        .otherwise(() => "other");

      expect(result).toBe("other");
    });

    it("should throw on non-exhaustive match without otherwise", () => {
      expect(() => {
        match(100)
          .when(42, () => "forty-two")
          .run();
      }).toThrow("Non-exhaustive pattern match");
    });
  });

  describe("matchValue", () => {
    it("should match string keys", () => {
      const result = matchValue("apple", {
        apple: () => "🍎",
        banana: () => "🍌",
        _: () => "🤷",
      });

      expect(result).toBe("🍎");
    });

    it("should use default pattern", () => {
      const result = matchValue("orange", {
        apple: () => "🍎",
        banana: () => "🍌",
        _: () => "🤷",
      });

      expect(result).toBe("🤷");
    });

    it("should throw without matching pattern", () => {
      expect(() => {
        matchValue("orange", {
          apple: () => "🍎",
          banana: () => "🍌",
        });
      }).toThrow();
    });
  });

  describe("matchTag", () => {
    type Shape =
      | { _tag: "circle"; radius: number }
      | { _tag: "rectangle"; width: number; height: number }
      | { _tag: "triangle"; base: number; height: number };

    it("should match discriminated union tags", () => {
      const shape: Shape = { _tag: "circle", radius: 5 };

      const area = matchTag(shape, {
        circle: (c) => Math.PI * c.radius ** 2,
        rectangle: (r) => r.width * r.height,
        triangle: (t) => 0.5 * t.base * t.height,
      });

      expect(area).toBeCloseTo(78.54, 2);
    });

    it("should provide correct types for each case", () => {
      const shape: Shape = { _tag: "rectangle", width: 10, height: 5 };

      const description = matchTag(shape, {
        circle: (c) => `Circle with radius ${c.radius}`,
        rectangle: (r) => `Rectangle ${r.width}x${r.height}`,
        triangle: (t) => `Triangle base:${t.base} height:${t.height}`,
      });

      expect(description).toBe("Rectangle 10x5");
    });

    it("should throw for unmatched tag", () => {
      const badShape = { _tag: "pentagon" } as never;

      expect(() => {
        matchTag(badShape, {
          circle: () => 0,
          rectangle: () => 0,
          triangle: () => 0,
        } as never);
      }).toThrow();
    });
  });

  describe("matchPartial", () => {
    type Result = { _tag: "ok"; value: number } | { _tag: "err"; error: string };

    it("should match available patterns", () => {
      const result: Result = { _tag: "ok", value: 42 };

      const message = matchPartial(result, {
        ok: (r) => `Success: ${r.value}`,
        // err case omitted
      });

      expect(message).toBe("Success: 42");
    });

    it("should return undefined for unmatched patterns", () => {
      const result: Result = { _tag: "err", error: "oops" };

      const message = matchPartial(result, {
        ok: (r) => `Success: ${r.value}`,
        // err case omitted
      });

      expect(message).toBeUndefined();
    });

    it("should use default pattern", () => {
      const result: Result = { _tag: "err", error: "oops" };

      const message = matchPartial(result, {
        ok: (r) => `Success: ${r.value}`,
        _: () => "Something else",
      });

      expect(message).toBe("Something else");
    });
  });

  describe("matchBool", () => {
    it("should match true", () => {
      const result = matchBool(true, {
        true: () => "yes",
        false: () => "no",
      });

      expect(result).toBe("yes");
    });

    it("should match false", () => {
      const result = matchBool(false, {
        true: () => "yes",
        false: () => "no",
      });

      expect(result).toBe("no");
    });
  });

  describe("matchNullable", () => {
    it("should match non-null value", () => {
      const result = matchNullable(42, {
        some: (x) => `value: ${x}`,
        none: () => "no value",
      });

      expect(result).toBe("value: 42");
    });

    it("should match null", () => {
      const result = matchNullable(null, {
        some: (x) => `value: ${x}`,
        none: () => "no value",
      });

      expect(result).toBe("no value");
    });

    it("should match undefined", () => {
      const result = matchNullable(undefined, {
        some: (x) => `value: ${x}`,
        none: () => "no value",
      });

      expect(result).toBe("no value");
    });
  });

  describe("NumberMatcher", () => {
    it("should match exact numbers", () => {
      const result = matchNumber(42)
        .when(42, () => "the answer")
        .when(0, () => "zero")
        .otherwise(() => "other");

      expect(result).toBe("the answer");
    });

    it("should match ranges", () => {
      const result = matchNumber(25)
        .whenRange(0, 18, () => "child")
        .whenRange(18, 65, () => "adult")
        .whenRange(65, 120, () => "senior")
        .otherwise(() => "invalid");

      expect(result).toBe("adult");
    });

    it("should match less than", () => {
      const result = matchNumber(5)
        .whenLt(10, () => "small")
        .otherwise(() => "big");

      expect(result).toBe("small");
    });

    it("should match greater than", () => {
      const result = matchNumber(15)
        .whenGt(10, () => "big")
        .otherwise(() => "small");

      expect(result).toBe("big");
    });

    it("should use first matching pattern", () => {
      const result = matchNumber(25)
        .whenRange(20, 30, () => "twenties")
        .whenRange(0, 100, () => "broad range")
        .otherwise(() => "other");

      expect(result).toBe("twenties");
    });
  });

  describe("StringMatcher", () => {
    it("should match exact strings", () => {
      const result = matchString("hello")
        .when("hello", () => "greeting")
        .when("goodbye", () => "farewell")
        .otherwise(() => "unknown");

      expect(result).toBe("greeting");
    });

    it("should match with regex", () => {
      const result = matchString("test@example.com")
        .whenRegex(/^\d+$/, () => "number")
        .whenRegex(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, () => "email")
        .otherwise(() => "text");

      expect(result).toBe("email");
    });

    it("should provide regex matches", () => {
      const result = matchString("prefix-12345")
        .whenRegex(/^prefix-(\d+)$/, (_, matches) => `number: ${matches[1]}`)
        .otherwise(() => "no match");

      expect(result).toBe("number: 12345");
    });

    it("should match prefix", () => {
      const result = matchString("hello world")
        .whenPrefix("hello", () => "greeting")
        .otherwise(() => "other");

      expect(result).toBe("greeting");
    });

    it("should match suffix", () => {
      const result = matchString("file.txt")
        .whenSuffix(".txt", () => "text file")
        .whenSuffix(".jpg", () => "image file")
        .otherwise(() => "unknown file");

      expect(result).toBe("text file");
    });

    it("should match contains", () => {
      const result = matchString("hello world")
        .whenContains("world", () => "contains world")
        .otherwise(() => "other");

      expect(result).toBe("contains world");
    });
  });

  describe("exhaustive", () => {
    it("should throw with never type", () => {
      const testExhaustive = (value: never) => {
        return exhaustive(value);
      };

      // This would be caught at compile time, but we test runtime behavior
      expect(() => testExhaustive("unexpected" as never)).toThrow();
    });

    it("should be useful in switch statements", () => {
      type Color = "red" | "green" | "blue";

      const getHex = (color: Color): string => {
        switch (color) {
          case "red":
            return "#FF0000";
          case "green":
            return "#00FF00";
          case "blue":
            return "#0000FF";
          default:
            return exhaustive(color);
        }
      };

      expect(getHex("red")).toBe("#FF0000");
      expect(getHex("green")).toBe("#00FF00");
      expect(getHex("blue")).toBe("#0000FF");
    });
  });
});

import { describe, expect, it } from "vitest";

import { deepEquals } from "../src/equals.js";

describe("deepEquals", () => {
  it("returns true for identical primitives", () => {
    expect(deepEquals(1, 1)).toBe(true);
    expect(deepEquals("hi", "hi")).toBe(true);
    expect(deepEquals(true, true)).toBe(true);
    expect(deepEquals(null, null)).toBe(true);
    expect(deepEquals(undefined, undefined)).toBe(true);
  });

  it("returns false for differing primitives", () => {
    expect(deepEquals(1, 2)).toBe(false);
    expect(deepEquals("a", "b")).toBe(false);
    expect(deepEquals(true, false)).toBe(false);
    expect(deepEquals(null, undefined)).toBe(false);
    expect(deepEquals(0, false)).toBe(false);
    expect(deepEquals(1, "1")).toBe(false);
  });

  it("treats NaN as equal to itself", () => {
    expect(deepEquals(NaN, NaN)).toBe(true);
    expect(deepEquals(NaN, 0)).toBe(false);
  });

  it("compares arrays element-wise", () => {
    expect(deepEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEquals([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(deepEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEquals([], [])).toBe(true);
  });

  it("compares nested arrays", () => {
    expect(
      deepEquals(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [1, 2],
          [3, 4],
        ],
      ),
    ).toBe(true);
    expect(
      deepEquals(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [1, 2],
          [3, 5],
        ],
      ),
    ).toBe(false);
  });

  it("compares plain objects structurally", () => {
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true); // key order irrelevant
    expect(deepEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  });

  it("compares nested objects", () => {
    const a = { user: { id: 1, profile: { name: "alice" } } };
    const b = { user: { id: 1, profile: { name: "alice" } } };
    const c = { user: { id: 1, profile: { name: "bob" } } };

    expect(deepEquals(a, b)).toBe(true);
    expect(deepEquals(a, c)).toBe(false);
  });

  it("distinguishes arrays from objects with integer keys", () => {
    expect(deepEquals([1, 2, 3], { 0: 1, 1: 2, 2: 3 })).toBe(false);
  });

  it("handles mixed nested structures", () => {
    const a = { items: [{ id: 1 }, { id: 2 }], total: 2 };
    const b = { items: [{ id: 1 }, { id: 2 }], total: 2 };
    const c = { items: [{ id: 1 }, { id: 3 }], total: 2 };

    expect(deepEquals(a, b)).toBe(true);
    expect(deepEquals(a, c)).toBe(false);
  });
});

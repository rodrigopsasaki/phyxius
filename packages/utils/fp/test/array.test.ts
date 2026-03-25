import { describe, it, expect } from "vitest";
import { head, last, at, tail, isNonEmpty, isEmpty, isSome, isNone, unwrapOption } from "../src/index.js";

describe("head", () => {
  it("should return Some for non-empty array", () => {
    const result = head([1, 2, 3]);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toBe(1);
  });

  it("should return None for empty array", () => {
    const result = head([]);

    expect(isNone(result)).toBe(true);
  });

  it("should return the first element for single-element array", () => {
    const result = head(["only"]);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toBe("only");
  });
});

describe("last", () => {
  it("should return Some with last element for non-empty array", () => {
    const result = last([1, 2, 3]);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toBe(3);
  });

  it("should return None for empty array", () => {
    const result = last([]);

    expect(isNone(result)).toBe(true);
  });

  it("should return the only element for single-element array", () => {
    const result = last(["only"]);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toBe("only");
  });

  it("should work with readonly arrays", () => {
    const arr = [10, 20, 30] as const;
    const result = last(arr);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toBe(30);
  });
});

describe("at", () => {
  it("should return Some for valid index", () => {
    const result = at([10, 20, 30], 1);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toBe(20);
  });

  it("should return None for negative index", () => {
    const result = at([1, 2, 3], -1);

    expect(isNone(result)).toBe(true);
  });

  it("should return None for out-of-bounds index", () => {
    const result = at([1, 2, 3], 5);

    expect(isNone(result)).toBe(true);
  });

  it("should return None for empty array", () => {
    const result = at([], 0);

    expect(isNone(result)).toBe(true);
  });

  it("should return Some for index 0 of non-empty array", () => {
    const result = at(["a", "b"], 0);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toBe("a");
  });

  it("should return Some for last valid index", () => {
    const result = at([1, 2, 3], 2);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toBe(3);
  });

  it("should return None for index equal to length", () => {
    const result = at([1, 2, 3], 3);

    expect(isNone(result)).toBe(true);
  });
});

describe("tail", () => {
  it("should return Some with remaining elements", () => {
    const result = tail([1, 2, 3]);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toEqual([2, 3]);
  });

  it("should return None for empty array", () => {
    const result = tail([]);

    expect(isNone(result)).toBe(true);
  });

  it("should return Some with empty array for single-element array", () => {
    const result = tail(["only"]);

    expect(isSome(result)).toBe(true);
    expect(unwrapOption(result)).toEqual([]);
  });
});

describe("isNonEmpty", () => {
  it("should return true for non-empty array", () => {
    expect(isNonEmpty([1])).toBe(true);
  });

  it("should return false for empty array", () => {
    expect(isNonEmpty([])).toBe(false);
  });
});

describe("isEmpty", () => {
  it("should return true for empty array", () => {
    expect(isEmpty([])).toBe(true);
  });

  it("should return false for non-empty array", () => {
    expect(isEmpty([1])).toBe(false);
  });
});

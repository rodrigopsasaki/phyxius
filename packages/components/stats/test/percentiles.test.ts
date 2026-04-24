import { describe, expect, it } from "vitest";

import { percentileOfSorted, summarize } from "../src/percentiles.js";

describe("percentileOfSorted", () => {
  it("returns 0 for an empty array", () => {
    expect(percentileOfSorted([], 0.5)).toBe(0);
    expect(percentileOfSorted([], 0.95)).toBe(0);
  });

  it("returns the single element for a 1-sample array", () => {
    expect(percentileOfSorted([42], 0.5)).toBe(42);
    expect(percentileOfSorted([42], 0.95)).toBe(42);
    expect(percentileOfSorted([42], 0.99)).toBe(42);
  });

  it("handles p <= 0 by returning the minimum", () => {
    expect(percentileOfSorted([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentileOfSorted([1, 2, 3, 4, 5], -0.5)).toBe(1);
  });

  it("handles p >= 1 by returning the maximum", () => {
    expect(percentileOfSorted([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(percentileOfSorted([1, 2, 3, 4, 5], 1.5)).toBe(5);
  });

  it("computes p50 (median) correctly for small arrays", () => {
    expect(percentileOfSorted([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentileOfSorted([10, 20, 30, 40], 0.5)).toBe(20);
  });

  it("computes p95 on a 100-element range [1..100]", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileOfSorted(samples, 0.95)).toBe(95);
  });

  it("computes p99 on the same range", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileOfSorted(samples, 0.99)).toBe(99);
  });

  it("is nearest-rank (deterministic, no interpolation)", () => {
    // With 10 samples [1..10], ceil(0.95 * 10) - 1 = 9 → the 10th element.
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileOfSorted(samples, 0.95)).toBe(10);
  });
});

describe("summarize", () => {
  it("returns zeroes for an empty input", () => {
    expect(summarize([])).toEqual({ p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 });
  });

  it("computes min / max / mean / percentiles in one pass", () => {
    const s = summarize([5, 2, 9, 1, 7, 3, 8, 4, 6, 10]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.mean).toBe(5.5);
    expect(s.p50).toBe(5); // ceil(0.5 * 10) - 1 = 4 → 5th of sorted [1,2,3,4,5,6,7,8,9,10]
    expect(s.p95).toBe(10);
    expect(s.p99).toBe(10);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("works with realistic duration-like samples", () => {
    // 100 samples: 90 fast (1–100ms), 10 slow (500–1500ms).
    const fast = Array.from({ length: 90 }, (_, i) => i + 1);
    const slow = Array.from({ length: 10 }, (_, i) => 500 + i * 100);
    const all = [...fast, ...slow];

    const s = summarize(all);
    // p50 is firmly in the fast range.
    expect(s.p50).toBeLessThanOrEqual(100);
    // p95 catches the slow tail.
    expect(s.p95).toBeGreaterThan(500);
  });
});

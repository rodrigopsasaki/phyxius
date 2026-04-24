import { describe, it, expect, vi } from "vitest";
import { memoize, memoizeWith, once, either, tryOrElse, chainNullable } from "../src/combinators.js";
import { isOk, isErr } from "../src/result.js";

describe("combinators", () => {
  describe("memoize", () => {
    it("should cache single-argument results", () => {
      const fn = vi.fn((n: number) => n * 2);
      const memoized = memoize(fn);

      expect(memoized(5)).toBe(10);
      expect(memoized(5)).toBe(10);
      expect(memoized(5)).toBe(10);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should cache per distinct argument", () => {
      const fn = vi.fn((n: number) => n * 2);
      const memoized = memoize(fn);

      memoized(1);
      memoized(2);
      memoized(1);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should evict the least-recently-used entry when maxSize is exceeded", () => {
      const fn = vi.fn((n: number) => n * 2);
      const memoized = memoize(fn, { maxSize: 2 });

      memoized(1); // cache: [1]
      memoized(2); // cache: [1, 2]
      memoized(1); // touch 1 → cache: [2, 1]
      memoized(3); // evicts 2 → cache: [1, 3]

      memoized(1);
      expect(fn).toHaveBeenCalledTimes(3); // 1, 2, 3 called once each so far

      // 2 was evicted; calling it again triggers recomputation
      memoized(2);
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });

  describe("memoizeWith", () => {
    it("should cache using the key function", () => {
      const fn = vi.fn((obj: { id: number }) => obj.id * 10);
      const memoized = memoizeWith(fn, (obj) => String(obj.id));

      // Two distinct object references, same key.
      memoized({ id: 1 });
      memoized({ id: 1 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should evict LRU entries when maxSize is exceeded", () => {
      const fn = vi.fn((s: string) => s.length);
      const memoized = memoizeWith(fn, (s) => s, { maxSize: 2 });

      memoized("a");
      memoized("b");
      memoized("c"); // evicts "a"

      expect(fn).toHaveBeenCalledTimes(3);
      memoized("a"); // cache miss — recomputed
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });

  describe("once", () => {
    it("should call the function exactly once on repeated invocations", () => {
      const fn = vi.fn((n: number) => n * 2);
      const onceFn = once(fn);

      expect(onceFn(5)).toBe(10);
      expect(onceFn(99)).toBe(10);
      expect(onceFn(1)).toBe(10);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should rethrow the cached error on subsequent calls if the first call threw", () => {
      const error = new Error("first-call failure");
      const fn = vi.fn(() => {
        throw error;
      });
      const onceFn = once(fn);

      expect(() => onceFn()).toThrow("first-call failure");
      expect(() => onceFn()).toThrow("first-call failure");
      expect(fn).toHaveBeenCalledTimes(1); // never re-attempted
    });

    it("should return the cached value even when the handler returns undefined", () => {
      const fn = vi.fn((): undefined => undefined);
      const onceFn = once(fn);

      expect(onceFn()).toBeUndefined();
      expect(onceFn()).toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("either (lifted into Result)", () => {
    it("should return Ok(fn1(a)) when fn1 succeeds", () => {
      const fn1 = (s: string) => s.toUpperCase();
      const fn2 = (_s: string) => "fallback";

      const result = either(fn1, fn2)("hello");
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe("HELLO");
    });

    it("should return Ok(fn2(a)) when fn1 throws and fn2 succeeds", () => {
      const fn1 = (_s: string) => {
        throw new Error("primary failure");
      };
      const fn2 = (s: string) => s.toUpperCase();

      const result = either(fn1, fn2)("hello");
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe("HELLO");
    });

    it("should return Err with both errors when both throw", () => {
      const fn1 = (_s: string) => {
        throw new Error("primary");
      };
      const fn2 = (_s: string) => {
        throw new Error("fallback");
      };

      const result = either(fn1, fn2)("hello");
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect((result.error.primary as Error).message).toBe("primary");
        expect((result.error.fallback as Error).message).toBe("fallback");
      }
    });

    it("should return Err(primary) without trying fn2 when predicate rejects", () => {
      const fn1 = (_s: string) => {
        throw new TypeError("type error");
      };
      const fn2 = vi.fn((_s: string) => "fallback");

      const result = either(fn1, fn2, (e) => e instanceof RangeError)("x");
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect((result.error.primary as Error).message).toBe("type error");
        expect(result.error.fallback).toBeUndefined();
      }
      expect(fn2).not.toHaveBeenCalled();
    });
  });

  describe("tryOrElse", () => {
    it("should return fn1(a) on success", () => {
      const fn1 = (n: number) => n + 1;
      const fn2 = (_n: number) => 0;

      expect(tryOrElse(fn1, fn2)(5)).toBe(6);
    });

    it("should return fn2(a) when fn1 throws", () => {
      const fn1 = (_n: number): number => {
        throw new Error("fail");
      };
      const fn2 = (n: number) => n * 2;

      expect(tryOrElse(fn1, fn2)(5)).toBe(10);
    });

    it("should rethrow when predicate rejects the primary error", () => {
      const fn1 = (_n: number): number => {
        throw new TypeError("not matched");
      };
      const fn2 = vi.fn((_n: number) => 0);

      expect(() => tryOrElse(fn1, fn2, (e) => e instanceof RangeError)(5)).toThrow(TypeError);
      expect(fn2).not.toHaveBeenCalled();
    });
  });

  describe("chainNullable", () => {
    it("should compose when both functions return non-null", () => {
      const fn1 = (s: string) => (s.length > 0 ? s.toUpperCase() : null);
      const fn2 = (s: string) => (s.startsWith("H") ? s : undefined);

      const composed = chainNullable(fn1, fn2);
      expect(composed("hello")).toBe("HELLO");
    });

    it("should short-circuit when fn1 returns null", () => {
      const fn1 = (_s: string) => null;
      const fn2 = vi.fn((s: string) => s);

      const composed = chainNullable(fn1, fn2);
      expect(composed("hello")).toBeUndefined();
      expect(fn2).not.toHaveBeenCalled();
    });

    it("should short-circuit when fn1 returns undefined", () => {
      const fn1 = (_s: string): string | undefined => undefined;
      const fn2 = vi.fn((s: string) => s);

      const composed = chainNullable(fn1, fn2);
      expect(composed("hello")).toBeUndefined();
      expect(fn2).not.toHaveBeenCalled();
    });
  });
});

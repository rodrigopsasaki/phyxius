import { describe, it, expect } from "vitest";
import {
  some,
  none,
  isSome,
  isNone,
  fromNullable,
  fromPredicate,
  unwrap,
  unwrapOr,
  unwrapOrElse,
  map,
  flatMap,
  orElse,
  match,
  and,
  or,
  ap,
  filter,
  tap,
  contains,
  exists,
  toResult,
  toNullable,
  toUndefined,
  toArray,
  all,
  compact,
  any,
  zip,
  zipWith,
  flatten,
  getOrElseThrow,
} from "../src/option.js";
import { isOk, isErr, unwrap as unwrapResult, unwrapErr } from "../src/result.js";

describe("Option", () => {
  describe("constructors", () => {
    it("should create Some option", () => {
      const option = some(42);
      expect(option._tag).toBe("Some");
      expect(option.value).toBe(42);
    });

    it("should create None option", () => {
      const option = none();
      expect(option._tag).toBe("None");
    });

    it("None should be singleton", () => {
      const n1 = none();
      const n2 = none();
      expect(n1).toBe(n2);
    });
  });

  describe("type guards", () => {
    it("should identify Some option", () => {
      const option = some(42);
      expect(isSome(option)).toBe(true);
      expect(isNone(option)).toBe(false);
    });

    it("should identify None option", () => {
      const option = none();
      expect(isSome(option)).toBe(false);
      expect(isNone(option)).toBe(true);
    });
  });

  describe("from constructors", () => {
    it("fromNullable should convert non-null to Some", () => {
      const option = fromNullable(42);
      expect(isSome(option)).toBe(true);
      expect(unwrap(option)).toBe(42);
    });

    it("fromNullable should convert null to None", () => {
      const option = fromNullable(null);
      expect(isNone(option)).toBe(true);
    });

    it("fromNullable should convert undefined to None", () => {
      const option = fromNullable(undefined);
      expect(isNone(option)).toBe(true);
    });

    it("fromPredicate should create Some for passing predicate", () => {
      const option = fromPredicate(42, (x) => x > 40);
      expect(isSome(option)).toBe(true);
      expect(unwrap(option)).toBe(42);
    });

    it("fromPredicate should create None for failing predicate", () => {
      const option = fromPredicate(42, (x) => x > 50);
      expect(isNone(option)).toBe(true);
    });
  });

  describe("extractors", () => {
    it("unwrap should extract Some value", () => {
      const option = some(42);
      expect(unwrap(option)).toBe(42);
    });

    it("unwrap should throw on None", () => {
      const option = none();
      expect(() => unwrap(option)).toThrow();
    });

    it("unwrapOr should extract Some or default", () => {
      expect(unwrapOr(some(42), 0)).toBe(42);
      expect(unwrapOr(none(), 0)).toBe(0);
    });

    it("unwrapOrElse should extract Some or compute default", () => {
      expect(unwrapOrElse(some(42), () => 0)).toBe(42);
      expect(unwrapOrElse(none(), () => 100)).toBe(100);
    });

    it("getOrElseThrow should extract Some or throw custom error", () => {
      expect(getOrElseThrow(some(42), () => new Error("custom"))).toBe(42);
      expect(() => getOrElseThrow(none(), () => new Error("custom"))).toThrow("custom");
    });
  });

  describe("transformers", () => {
    it("map should transform Some value", () => {
      const option = map(some(42), (x) => x * 2);
      expect(unwrap(option)).toBe(84);
    });

    it("map should pass through None", () => {
      const option = map(none(), (x: number) => x * 2);
      expect(isNone(option)).toBe(true);
    });

    it("flatMap should chain Some options", () => {
      const option = flatMap(some(42), (x) => some(x * 2));
      expect(unwrap(option)).toBe(84);
    });

    it("flatMap should short-circuit on None", () => {
      const option = flatMap(none(), (x: number) => some(x * 2));
      expect(isNone(option)).toBe(true);
    });

    it("flatMap should propagate inner None", () => {
      const option = flatMap(some(42), () => none());
      expect(isNone(option)).toBe(true);
    });

    it("orElse should provide alternative on None", () => {
      const option = orElse(none(), () => some(42));
      expect(unwrap(option)).toBe(42);
    });

    it("orElse should pass through Some", () => {
      const option = orElse(some(42), () => some(0));
      expect(unwrap(option)).toBe(42);
    });
  });

  describe("pattern matching", () => {
    it("should match Some case", () => {
      const result = match(some(42), {
        some: (x) => `value: ${x}`,
        none: () => "no value",
      });
      expect(result).toBe("value: 42");
    });

    it("should match None case", () => {
      const result = match(none(), {
        some: (x) => `value: ${x}`,
        none: () => "no value",
      });
      expect(result).toBe("no value");
    });
  });

  describe("combinators", () => {
    it("and should return second if first is Some", () => {
      const option = and(some(1), some(2));
      expect(unwrap(option)).toBe(2);
    });

    it("and should return None if first is None", () => {
      const option = and(none(), some(2));
      expect(isNone(option)).toBe(true);
    });

    it("or should return first if Some", () => {
      const option = or(some(1), some(2));
      expect(unwrap(option)).toBe(1);
    });

    it("or should return second if first is None", () => {
      const option = or(none(), some(2));
      expect(unwrap(option)).toBe(2);
    });

    it("ap should apply function in Option", () => {
      const fnOption = some((x: number) => x * 2);
      const valueOption = some(21);
      const option = ap(fnOption, valueOption);
      expect(unwrap(option)).toBe(42);
    });

    it("ap should return None if function is None", () => {
      const fnOption = none();
      const valueOption = some(21);
      const option = ap(fnOption, valueOption);
      expect(isNone(option)).toBe(true);
    });
  });

  describe("utilities", () => {
    it("filter should keep Some matching predicate", () => {
      const option = filter(some(42), (x) => x > 40);
      expect(unwrap(option)).toBe(42);
    });

    it("filter should convert Some to None if predicate fails", () => {
      const option = filter(some(42), (x) => x > 50);
      expect(isNone(option)).toBe(true);
    });

    it("filter should pass through None", () => {
      const option = filter(none(), (x: number) => x > 0);
      expect(isNone(option)).toBe(true);
    });

    it("tap should perform side effect on Some", () => {
      let sideEffect = 0;
      const option = tap(some(42), (x) => {
        sideEffect = x;
      });
      expect(unwrap(option)).toBe(42);
      expect(sideEffect).toBe(42);
    });

    it("tap should not perform side effect on None", () => {
      let sideEffect = 0;
      const option = tap(none(), (x: number) => {
        sideEffect = x;
      });
      expect(isNone(option)).toBe(true);
      expect(sideEffect).toBe(0);
    });

    it("contains should check Some value", () => {
      expect(contains(some(42), 42)).toBe(true);
      expect(contains(some(42), 43)).toBe(false);
    });

    it("contains should return false for None", () => {
      expect(contains(none(), 42)).toBe(false);
    });

    it("exists should check predicate on Some", () => {
      expect(exists(some(42), (x) => x > 40)).toBe(true);
      expect(exists(some(42), (x) => x > 50)).toBe(false);
    });

    it("exists should return false for None", () => {
      expect(exists(none(), (x: number) => x > 0)).toBe(false);
    });
  });

  describe("conversions", () => {
    it("toResult should convert Some to Ok", () => {
      const result = toResult(some(42), "error");
      expect(isOk(result)).toBe(true);
      expect(unwrapResult(result)).toBe(42);
    });

    it("toResult should convert None to Err", () => {
      const result = toResult(none(), "error");
      expect(isErr(result)).toBe(true);
      expect(unwrapErr(result)).toBe("error");
    });

    it("toNullable should convert Some to value", () => {
      expect(toNullable(some(42))).toBe(42);
    });

    it("toNullable should convert None to null", () => {
      expect(toNullable(none())).toBe(null);
    });

    it("toUndefined should convert Some to value", () => {
      expect(toUndefined(some(42))).toBe(42);
    });

    it("toUndefined should convert None to undefined", () => {
      expect(toUndefined(none())).toBe(undefined);
    });

    it("toArray should convert Some to single-element array", () => {
      expect(toArray(some(42))).toEqual([42]);
    });

    it("toArray should convert None to empty array", () => {
      expect(toArray(none())).toEqual([]);
    });
  });

  describe("collections", () => {
    it("all should collect Some options", () => {
      const options = [some(1), some(2), some(3)];
      const option = all(options);
      expect(unwrap(option)).toEqual([1, 2, 3]);
    });

    it("all should return None if any is None", () => {
      const options = [some(1), none(), some(3)];
      const option = all(options);
      expect(isNone(option)).toBe(true);
    });

    it("compact should filter out Nones", () => {
      const options = [some(1), none(), some(3)];
      const values = compact(options);
      expect(values).toEqual([1, 3]);
    });

    it("any should return first Some", () => {
      const options = [none(), some(42), none()];
      const option = any(options);
      expect(unwrap(option)).toBe(42);
    });

    it("any should return None if all are None", () => {
      const options = [none(), none(), none()];
      const option = any(options);
      expect(isNone(option)).toBe(true);
    });
  });

  describe("advanced operations", () => {
    it("zip should combine two Some options", () => {
      const option = zip(some(1), some("a"));
      expect(unwrap(option)).toEqual([1, "a"]);
    });

    it("zip should return None if any is None", () => {
      expect(isNone(zip(none(), some(2)))).toBe(true);
      expect(isNone(zip(some(1), none()))).toBe(true);
    });

    it("zipWith should combine with custom function", () => {
      const option = zipWith(some(2), some(3), (a, b) => a + b);
      expect(unwrap(option)).toBe(5);
    });

    it("flatten should unwrap nested Option", () => {
      const nested = some(some(42));
      const flattened = flatten(nested);
      expect(unwrap(flattened)).toBe(42);
    });

    it("flatten should convert Some(None) to None", () => {
      const nested = some(none());
      const flattened = flatten(nested);
      expect(isNone(flattened)).toBe(true);
    });

    it("flatten should pass through None", () => {
      const nested = none();
      const flattened = flatten(nested);
      expect(isNone(flattened)).toBe(true);
    });
  });
});

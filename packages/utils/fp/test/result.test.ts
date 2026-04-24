import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapErr,
  unwrapOr,
  unwrapOrElse,
  map,
  mapErr,
  flatMap,
  orElse,
  match,
  and,
  or,
  ap,
  all,
  allSettled,
  any,
  fromNullable,
  tryCatch,
  fromPromise,
  bimap,
  tap,
  tapErr,
  filter,
  swap,
  partition,
  zip,
  zipWith,
  toUndefined,
} from "../src/result.js";

describe("Result", () => {
  describe("constructors", () => {
    it("should create Ok result", () => {
      const result = ok(42);
      expect(result._tag).toBe("Ok");
      expect(result.value).toBe(42);
    });

    it("should create Err result", () => {
      const result = err("error");
      expect(result._tag).toBe("Err");
      expect(result.error).toBe("error");
    });
  });

  describe("type guards", () => {
    it("should identify Ok result", () => {
      const result = ok(42);
      expect(isOk(result)).toBe(true);
      expect(isErr(result)).toBe(false);
    });

    it("should identify Err result", () => {
      const result = err("error");
      expect(isOk(result)).toBe(false);
      expect(isErr(result)).toBe(true);
    });
  });

  describe("extractors", () => {
    it("unwrap should extract Ok value", () => {
      const result = ok(42);
      expect(unwrap(result)).toBe(42);
    });

    it("unwrap should throw on Err", () => {
      const result = err("error");
      expect(() => unwrap(result)).toThrow();
    });

    it("unwrapErr should extract Err value", () => {
      const result = err("error");
      expect(unwrapErr(result)).toBe("error");
    });

    it("unwrapErr should throw on Ok", () => {
      const result = ok(42);
      expect(() => unwrapErr(result)).toThrow();
    });

    it("unwrapOr should extract Ok or default", () => {
      expect(unwrapOr(ok(42), 0)).toBe(42);
      expect(unwrapOr(err("error"), 0)).toBe(0);
    });

    it("unwrapOrElse should extract Ok or compute default", () => {
      expect(unwrapOrElse(ok(42), () => 0)).toBe(42);
      expect(unwrapOrElse(err("error"), (e) => e.length)).toBe(5);
    });
  });

  describe("transformers", () => {
    it("map should transform Ok value", () => {
      const result = map(ok(42), (x) => x * 2);
      expect(unwrap(result)).toBe(84);
    });

    it("map should pass through Err", () => {
      const result = map(err("error"), (x: number) => x * 2);
      expect(unwrapErr(result)).toBe("error");
    });

    it("mapErr should transform Err value", () => {
      const result = mapErr(err("error"), (e) => e.toUpperCase());
      expect(unwrapErr(result)).toBe("ERROR");
    });

    it("mapErr should pass through Ok", () => {
      const result = mapErr(ok(42), (e: string) => e.toUpperCase());
      expect(unwrap(result)).toBe(42);
    });

    it("flatMap should chain Ok results", () => {
      const result = flatMap(ok(42), (x) => ok(x * 2));
      expect(unwrap(result)).toBe(84);
    });

    it("flatMap should short-circuit on Err", () => {
      const result = flatMap(err("error"), (x: number) => ok(x * 2));
      expect(unwrapErr(result)).toBe("error");
    });

    it("flatMap should propagate inner Err", () => {
      const result = flatMap(ok(42), () => err("inner error"));
      expect(unwrapErr(result)).toBe("inner error");
    });

    it("orElse should provide alternative on Err", () => {
      const result = orElse(err("error"), () => ok(42));
      expect(unwrap(result)).toBe(42);
    });

    it("orElse should pass through Ok", () => {
      const result = orElse(ok(42), () => ok(0));
      expect(unwrap(result)).toBe(42);
    });
  });

  describe("pattern matching", () => {
    it("should match Ok case", () => {
      const result = match(ok(42), {
        ok: (x) => `value: ${x}`,
        err: (e) => `error: ${e}`,
      });
      expect(result).toBe("value: 42");
    });

    it("should match Err case", () => {
      const result = match(err("oops"), {
        ok: (x) => `value: ${x}`,
        err: (e) => `error: ${e}`,
      });
      expect(result).toBe("error: oops");
    });
  });

  describe("combinators", () => {
    it("and should return second if first is Ok", () => {
      const result = and(ok(1), ok(2));
      expect(unwrap(result)).toBe(2);
    });

    it("and should return first if first is Err", () => {
      const result = and(err("first"), ok(2));
      expect(unwrapErr(result)).toBe("first");
    });

    it("or should return first if Ok", () => {
      const result = or(ok(1), ok(2));
      expect(unwrap(result)).toBe(1);
    });

    it("or should return second if first is Err", () => {
      const result = or(err("first"), ok(2));
      expect(unwrap(result)).toBe(2);
    });

    it("ap should apply function in Result", () => {
      const fnResult = ok((x: number) => x * 2);
      const valueResult = ok(21);
      const result = ap(fnResult, valueResult);
      expect(unwrap(result)).toBe(42);
    });
  });

  describe("collections", () => {
    it("all should collect Ok results", () => {
      const results = [ok(1), ok(2), ok(3)];
      const result = all(results);
      expect(unwrap(result)).toEqual([1, 2, 3]);
    });

    it("all should short-circuit on first Err", () => {
      const results = [ok(1), err("error"), ok(3)];
      const result = all(results);
      expect(unwrapErr(result)).toBe("error");
    });

    it("allSettled should filter out Errs", () => {
      const results = [ok(1), err("error"), ok(3)];
      const result = allSettled(results);
      expect(unwrap(result)).toEqual([1, 3]);
    });

    it("any should return first Ok", () => {
      const results = [err("e1"), ok(42), err("e2")];
      const result = any(results);
      expect(unwrap(result)).toBe(42);
    });

    it("any should collect all Errs if no Ok", () => {
      const results = [err("e1"), err("e2"), err("e3")];
      const result = any(results);
      expect(unwrapErr(result)).toEqual(["e1", "e2", "e3"]);
    });

    it("partition should separate Oks and Errs", () => {
      const results = [ok(1), err("e1"), ok(2), err("e2")];
      const [oks, errs] = partition(results);
      expect(oks).toEqual([1, 2]);
      expect(errs).toEqual(["e1", "e2"]);
    });
  });

  describe("conversions", () => {
    it("fromNullable should convert non-null to Ok", () => {
      const result = fromNullable(42, "error");
      expect(unwrap(result)).toBe(42);
    });

    it("fromNullable should convert null to Err", () => {
      const result = fromNullable(null, "error");
      expect(unwrapErr(result)).toBe("error");
    });

    it("fromNullable should convert undefined to Err", () => {
      const result = fromNullable(undefined, "error");
      expect(unwrapErr(result)).toBe("error");
    });

    it("tryCatch should catch exceptions", () => {
      const result = tryCatch(() => {
        throw new Error("oops");
      });
      expect(unwrapErr(result)).toBeInstanceOf(Error);
      expect((unwrapErr(result) as Error).message).toBe("oops");
    });

    it("tryCatch should return Ok for successful execution", () => {
      const result = tryCatch(() => 42);
      expect(unwrap(result)).toBe(42);
    });

    it("fromPromise should convert resolved promise to Ok", async () => {
      const result = await fromPromise(Promise.resolve(42));
      expect(unwrap(result)).toBe(42);
    });

    it("fromPromise should convert rejected promise to Err", async () => {
      const result = await fromPromise(Promise.reject("error"));
      expect(unwrapErr(result)).toBe("error");
    });

    it("toUndefined should return the value from Ok", () => {
      const value = toUndefined(ok(42));
      expect(value).toBe(42);
    });

    it("toUndefined should return undefined from Err", () => {
      const value = toUndefined(err("error"));
      expect(value).toBeUndefined();
    });
  });

  describe("advanced operations", () => {
    it("bimap should transform both sides", () => {
      const okResult = bimap(
        ok(42),
        (x) => x * 2,
        (e) => e,
      );
      expect(unwrap(okResult)).toBe(84);

      const errResult = bimap(
        err("error"),
        (x) => x,
        (e: string) => e.toUpperCase(),
      );
      expect(unwrapErr(errResult)).toBe("ERROR");
    });

    it("tap should perform side effect on Ok", () => {
      let sideEffect = 0;
      const result = tap(ok(42), (x) => {
        sideEffect = x;
      });
      expect(unwrap(result)).toBe(42);
      expect(sideEffect).toBe(42);
    });

    it("tapErr should perform side effect on Err", () => {
      let sideEffect = "";
      const result = tapErr(err("error"), (e) => {
        sideEffect = e;
      });
      expect(unwrapErr(result)).toBe("error");
      expect(sideEffect).toBe("error");
    });

    it("filter should convert filtered Ok to Err", () => {
      const result = filter(ok(42), (x) => x > 50, "too small");
      expect(unwrapErr(result)).toBe("too small");
    });

    it("filter should pass through matching Ok", () => {
      const result = filter(ok(42), (x) => x > 30, "too small");
      expect(unwrap(result)).toBe(42);
    });

    it("swap should exchange Ok and Err", () => {
      const okSwapped = swap(ok(42));
      expect(unwrapErr(okSwapped)).toBe(42);

      const errSwapped = swap(err("error"));
      expect(unwrap(errSwapped)).toBe("error");
    });

    it("zip should combine two Ok results", () => {
      const result = zip(ok(1), ok("a"));
      expect(unwrap(result)).toEqual([1, "a"]);
    });

    it("zip should return first Err", () => {
      const result = zip(err("e1"), ok(2));
      expect(unwrapErr(result)).toBe("e1");
    });

    it("zipWith should combine with custom function", () => {
      const result = zipWith(ok(2), ok(3), (a, b) => a + b);
      expect(unwrap(result)).toBe(5);
    });
  });
});

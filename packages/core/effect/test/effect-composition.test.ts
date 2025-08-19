import { describe, it, expect, beforeEach } from "vitest";
import { succeed, fail } from "../src/index.js";

describe("Effect Composition - Monad Laws", () => {
  let events: unknown[] = [];
  const _emit = (event: unknown) => events.push(event);

  beforeEach(() => {
    events = [];
  });

  describe("map: Functor laws", () => {
    it("should preserve identity: map(id) === id", async () => {
      const eff = succeed(42);
      const mapped = eff.map((_x) => _x);

      const original = await eff.unsafeRunPromise();
      const result = await mapped.unsafeRunPromise();

      expect(result).toEqual(original);
    });

    it("should preserve composition: map(f).map(g) === map(g ∘ f)", async () => {
      const eff = succeed(10);
      const f = (x: number) => x * 2;
      const g = (x: number) => x + 1;

      const composed1 = eff.map(f).map(g);
      const composed2 = eff.map((x) => g(f(x)));

      const result1 = await composed1.unsafeRunPromise();
      const result2 = await composed2.unsafeRunPromise();

      expect(result1).toEqual(result2);
      expect(result1).toEqual({ _tag: "Ok", value: 21 }); // (10 * 2) + 1
    });

    it("should not execute effect if previous stage failed", async () => {
      let executed = false;

      const eff = fail("error").map((x: number) => {
        executed = true;
        return x * 2;
      });

      const result = await eff.unsafeRunPromise();

      expect(executed).toBe(false);
      expect(result).toEqual({ _tag: "Err", error: "error" });
    });

    it("should handle exceptions in map function", async () => {
      const eff = succeed(42).map((_x: number) => {
        throw new Error("map failed");
      });

      const result = await eff.unsafeRunPromise();

      expect(result._tag).toBe("Err");
      expect((result.error as Error).message).toBe("map failed");
    });
  });

  describe("flatMap: Monad laws", () => {
    it("should satisfy left identity: succeed(a).flatMap(f) === f(a)", async () => {
      const a = 42;
      const f = (x: number) => succeed(x * 2);

      const leftSide = succeed(a).flatMap(f);
      const rightSide = f(a);

      const result1 = await leftSide.unsafeRunPromise();
      const result2 = await rightSide.unsafeRunPromise();

      expect(result1).toEqual(result2);
    });

    it("should satisfy right identity: m.flatMap(succeed) === m", async () => {
      const m = succeed(42);

      const flatMapped = m.flatMap(succeed);

      const original = await m.unsafeRunPromise();
      const result = await flatMapped.unsafeRunPromise();

      expect(result).toEqual(original);
    });

    it("should satisfy associativity: m.flatMap(f).flatMap(g) === m.flatMap(x => f(x).flatMap(g))", async () => {
      const m = succeed(10);
      const f = (x: number) => succeed(x * 2);
      const g = (x: number) => succeed(x + 1);

      const leftSide = m.flatMap(f).flatMap(g);
      const rightSide = m.flatMap((x) => f(x).flatMap(g));

      const result1 = await leftSide.unsafeRunPromise();
      const result2 = await rightSide.unsafeRunPromise();

      expect(result1).toEqual(result2);
      expect(result1).toEqual({ _tag: "Ok", value: 21 });
    });

    it("should short-circuit on first error", async () => {
      let executed = false;

      const eff = fail("first error").flatMap((x: number) => {
        executed = true;
        return succeed(x * 2);
      });

      const result = await eff.unsafeRunPromise();

      expect(executed).toBe(false);
      expect(result).toEqual({ _tag: "Err", error: "first error" });
    });

    it("should propagate errors from flatMapped effects", async () => {
      const eff = succeed(42).flatMap((x: number) => fail(`error with ${x}`));

      const result = await eff.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Err", error: "error with 42" });
    });
  });

  describe("catch: Error recovery", () => {
    it("should recover from errors", async () => {
      const eff = fail("original error").catch((error: string) => succeed(`recovered from: ${error}`));

      const result = await eff.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Ok", value: "recovered from: original error" });
    });

    it("should not execute catch if no error occurred", async () => {
      let catchExecuted = false;

      const eff = succeed(42).catch((_error: unknown) => {
        catchExecuted = true;
        return succeed("should not happen");
      });

      const result = await eff.unsafeRunPromise();

      expect(catchExecuted).toBe(false);
      expect(result).toEqual({ _tag: "Ok", value: 42 });
    });

    it("should propagate new errors from catch handler", async () => {
      const eff = fail("original").catch((error: string) => fail(`new error: ${error}`));

      const result = await eff.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Err", error: "new error: original" });
    });

    it("should handle exceptions in catch handler", async () => {
      const eff = fail("original").catch((_error: string) => {
        throw new Error("catch handler failed");
      });

      const result = await eff.unsafeRunPromise();

      expect(result._tag).toBe("Err");
      expect((result.error as Error).message).toBe("catch handler failed");
    });
  });

  describe("Complex composition patterns", () => {
    it("should handle deep composition chains", async () => {
      const pipeline = succeed(1)
        .map((x) => x + 1) // 2
        .flatMap((x) => succeed(x * 3)) // 6
        .map((x) => x - 1) // 5
        .flatMap((x) => succeed(x * 2)) // 10
        .catch(() => succeed(0)); // Should not execute

      const result = await pipeline.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Ok", value: 10 });
    });

    it("should handle mixed success/failure chains", async () => {
      const pipeline = succeed(10)
        .flatMap((x) => (x > 5 ? succeed(x * 2) : fail("too small")))
        .map((x) => x + 1)
        .catch((_error: string) => succeed(-1));

      const result = await pipeline.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Ok", value: 21 });
    });

    it("should handle early failure with recovery", async () => {
      const pipeline = succeed(2)
        .flatMap((x) => (x > 5 ? succeed(x * 2) : fail("too small")))
        .map((x) => x + 1) // Should not execute
        .catch((_error: string) => succeed(-1));

      const result = await pipeline.unsafeRunPromise();

      expect(result).toEqual({ _tag: "Ok", value: -1 });
    });
  });
});

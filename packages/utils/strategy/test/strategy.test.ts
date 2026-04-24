import { describe, expect, it } from "vitest";

import { createControlledClock } from "@phyxiusjs/clock";

import { strategy } from "../src/strategy.js";
import type { StrategyEvent } from "../src/types.js";

describe("strategy.define", () => {
  it("creates a typed value with name + compute", () => {
    const s = strategy.define("double", (n: number) => n * 2);
    expect(s.name).toBe("double");
    expect(s.compute(5)).toBe(10);
  });

  it("the compute is sync — no async allowed by type", () => {
    // This test is a compile-time check posing as a runtime one:
    // if `compute` were accidentally typed to accept Promise<T>, this
    // assertion would still pass but the `await` on line 4 below would
    // be a type error. Keep it here as a semantic guard.
    const s = strategy.define("upper", (x: string) => x.toUpperCase());
    const result: string = s.compute("hi");
    expect(result).toBe("HI");
  });
});

describe("strategy.set — validation", () => {
  it("builds a valid set", () => {
    const v1 = strategy.define("calc.v1", (n: number) => n + 1);
    const v2 = strategy.define("calc.v2", (n: number) => n + 2);
    const s = strategy.set({
      name: "calc",
      strategies: [v1, v2],
      primary: "calc.v1",
      shadow: ["calc.v2"],
    });
    expect(s.primary).toBe("calc.v1");
    expect(s.shadow).toEqual(["calc.v2"]);
  });

  it("rejects an empty strategies list", () => {
    expect(() =>
      strategy.set({
        name: "empty",
        strategies: [],
        primary: "none",
      }),
    ).toThrow(/at least one strategy/);
  });

  it("rejects a primary not in the strategies list", () => {
    expect(() =>
      strategy.set({
        name: "bad-primary",
        strategies: [strategy.define("a", (_: number) => 1)],
        primary: "does-not-exist",
      }),
    ).toThrow(/primary "does-not-exist"/);
  });

  it("rejects a shadow not in the strategies list", () => {
    expect(() =>
      strategy.set({
        name: "bad-shadow",
        strategies: [strategy.define("a", (_: number) => 1)],
        primary: "a",
        shadow: ["b"],
      }),
    ).toThrow(/shadow "b"/);
  });

  it("rejects a strategy used as both primary and shadow", () => {
    const a = strategy.define("a", (_: number) => 1);
    expect(() =>
      strategy.set({
        name: "overlap",
        strategies: [a],
        primary: "a",
        shadow: ["a"],
      }),
    ).toThrow(/cannot be both primary and shadow/);
  });

  it("rejects duplicate strategy names within a set", () => {
    expect(() =>
      strategy.set({
        name: "dup",
        strategies: [strategy.define("a", (_: number) => 1), strategy.define("a", (_: number) => 2)],
        primary: "a",
      }),
    ).toThrow(/duplicate strategy name "a"/);
  });

  it("rejects duplicate shadows", () => {
    expect(() =>
      strategy.set({
        name: "dup-shadow",
        strategies: [strategy.define("a", (_: number) => 1), strategy.define("b", (_: number) => 2)],
        primary: "a",
        shadow: ["b", "b"],
      }),
    ).toThrow(/duplicate shadow "b"/);
  });
});

describe("strategy.run — primary only", () => {
  it("returns the primary's output", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const s = strategy.set({
      name: "double",
      strategies: [strategy.define("d", (n: number) => n * 2)],
      primary: "d",
    });

    expect(strategy.run(s, 5, { clock })).toBe(10);
  });

  it("emits strategy:computed for the primary", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: StrategyEvent[] = [];
    const s = strategy.set({
      name: "compute",
      strategies: [strategy.define("c", (n: number) => n)],
      primary: "c",
    });

    strategy.run(s, 1, { clock, emit: (e) => events.push(e) });

    const computed = events.filter((e) => e.type === "strategy:computed");
    expect(computed).toHaveLength(1);
    if (computed[0]?.type === "strategy:computed") {
      expect(computed[0].strategy).toBe("c");
      expect(computed[0].set).toBe("compute");
    }
  });

  it("propagates throws from the primary (bug, not shadow artifact)", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const s = strategy.set({
      name: "buggy",
      strategies: [
        strategy.define("b", (_: number): number => {
          throw new Error("primary broke");
        }),
      ],
      primary: "b",
    });

    expect(() => strategy.run(s, 1, { clock })).toThrow("primary broke");
  });
});

describe("strategy.run — shadow comparison", () => {
  it("runs shadows and emits match when outputs agree", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: StrategyEvent[] = [];

    const v1 = strategy.define("tax.v1", (amt: number) => amt * 0.1);
    const v2 = strategy.define("tax.v2", (amt: number) => amt / 10);

    const s = strategy.set({
      name: "tax",
      strategies: [v1, v2],
      primary: "tax.v1",
      shadow: ["tax.v2"],
    });

    const result = strategy.run(s, 100, { clock, emit: (e) => events.push(e) });

    // Primary's output is what we return.
    expect(result).toBe(10);

    // Two "computed" events (primary + shadow) + one "match" event.
    const computed = events.filter((e) => e.type === "strategy:computed");
    const matches = events.filter((e) => e.type === "strategy:shadow-match");
    const mismatches = events.filter((e) => e.type === "strategy:shadow-mismatch");

    expect(computed).toHaveLength(2);
    expect(matches).toHaveLength(1);
    expect(mismatches).toHaveLength(0);
  });

  it("emits mismatch with input + both outputs when outputs disagree", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: StrategyEvent<number, number>[] = [];

    const v1 = strategy.define("tax.v1", (amt: number) => amt * 0.1);
    const v2 = strategy.define("tax.v2", (amt: number) => amt * 0.15); // different rate

    const s = strategy.set({
      name: "tax",
      strategies: [v1, v2],
      primary: "tax.v1",
      shadow: ["tax.v2"],
    });

    const result = strategy.run<number, number>(s, 100, {
      clock,
      emit: (e) => events.push(e),
    });

    // Primary still wins — shadow is silent.
    expect(result).toBe(10);

    const mismatch = events.find((e) => e.type === "strategy:shadow-mismatch");
    expect(mismatch).toBeDefined();
    if (mismatch?.type === "strategy:shadow-mismatch") {
      expect(mismatch.primary).toBe("tax.v1");
      expect(mismatch.shadow).toBe("tax.v2");
      expect(mismatch.input).toBe(100);
      expect(mismatch.primaryOutput).toBe(10);
      expect(mismatch.shadowOutput).toBe(15);
    }
  });

  it("runs multiple shadows, each compared independently", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: StrategyEvent[] = [];

    const s = strategy.set({
      name: "multi",
      strategies: [
        strategy.define("primary", (n: number) => n + 1),
        strategy.define("match", (n: number) => n + 1), // agrees
        strategy.define("mismatch", (n: number) => n + 99), // disagrees
      ],
      primary: "primary",
      shadow: ["match", "mismatch"],
    });

    strategy.run(s, 5, { clock, emit: (e) => events.push(e) });

    const matches = events.filter((e) => e.type === "strategy:shadow-match");
    const mismatches = events.filter((e) => e.type === "strategy:shadow-mismatch");
    expect(matches).toHaveLength(1);
    expect(mismatches).toHaveLength(1);
  });

  it("a throwing shadow emits shadow-error but doesn't affect the result", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: StrategyEvent[] = [];

    const s = strategy.set({
      name: "with-bad-shadow",
      strategies: [
        strategy.define("good", (n: number) => n + 1),
        strategy.define("bad", (_: number): number => {
          throw new Error("shadow bug");
        }),
      ],
      primary: "good",
      shadow: ["bad"],
    });

    // Primary still produces a result; shadow's throw is swallowed to an event.
    const result = strategy.run(s, 10, { clock, emit: (e) => events.push(e) });
    expect(result).toBe(11);

    const errors = events.filter((e) => e.type === "strategy:shadow-error");
    expect(errors).toHaveLength(1);
    if (errors[0]?.type === "strategy:shadow-error") {
      expect(errors[0].shadow).toBe("bad");
      expect((errors[0].cause as Error).message).toBe("shadow bug");
    }
  });
});

describe("strategy.run — custom equals", () => {
  it("uses a user-supplied equality when provided", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: StrategyEvent[] = [];

    // Numerical tolerance — values within 0.01 are considered equal.
    const s = strategy.set({
      name: "float-compare",
      strategies: [
        strategy.define("precise", (x: number) => x / 3),
        strategy.define("approximate", (x: number) => Number((x / 3).toFixed(4))),
      ],
      primary: "precise",
      shadow: ["approximate"],
      equals: (a, b) => Math.abs(a - b) < 0.001,
    });

    strategy.run(s, 10, { clock, emit: (e) => events.push(e) });

    const matches = events.filter((e) => e.type === "strategy:shadow-match");
    const mismatches = events.filter((e) => e.type === "strategy:shadow-mismatch");

    // Would be a mismatch under strict equality; custom equals accepts it.
    expect(matches).toHaveLength(1);
    expect(mismatches).toHaveLength(0);
  });
});

describe("strategy.run — no emit", () => {
  it("runs cleanly when no emit is supplied", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const s = strategy.set({
      name: "quiet",
      strategies: [strategy.define("a", (n: number) => n), strategy.define("b", (n: number) => n + 1)],
      primary: "a",
      shadow: ["b"],
    });

    // No emit argument — still works, just silent.
    expect(strategy.run(s, 7, { clock })).toBe(7);
  });

  it("emitter failures never cascade into the call", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const s = strategy.set({
      name: "emit-fails",
      strategies: [strategy.define("a", (n: number) => n)],
      primary: "a",
    });

    const result = strategy.run(s, 1, {
      clock,
      emit: () => {
        throw new Error("emitter broke");
      },
    });
    expect(result).toBe(1);
  });
});

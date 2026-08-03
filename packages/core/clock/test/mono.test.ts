import { describe, it, expect } from "vitest";
import { createControlledClock } from "../src/controlled-clock.js";
import { elapsedSince, deadlineFrom, hasPassed } from "../src/mono.js";
import type { Millis, MonoMs } from "../src/types.js";

describe("elapsedSince", () => {
  it("computes the duration between two readings of the same clock", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const then = clock.now().monoMs;
    clock.advanceBy(250 as Millis);
    const now = clock.now().monoMs;

    expect(elapsedSince(now, then)).toBe(250);
  });

  it("clamps to 0 rather than going negative when the arguments are backwards", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const earlier = clock.now().monoMs;
    clock.advanceBy(100 as Millis);
    const later = clock.now().monoMs;

    // "Elapsed since `later`, measured at `earlier`" hasn't happened yet —
    // the clamp is the honest answer, not a negative duration.
    expect(elapsedSince(earlier, later)).toBe(0);
  });

  it("inverts deadlineFrom: the gap it measures is exactly the duration that built the deadline", () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const now = clock.now().monoMs;
    const duration = 750 as Millis;

    expect(elapsedSince(deadlineFrom(now, duration), now)).toBe(750);
  });
});

describe("deadlineFrom", () => {
  it("returns the reading `ms` after `now`", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const now = clock.now().monoMs;

    const deadline = deadlineFrom(now, 500 as Millis);

    // deadlineFrom's job is to land exactly where a real later reading of
    // the SAME clock would land — check it against one instead of a bare
    // number, since a bare number is the one thing a MonoMs never is.
    clock.advanceBy(500 as Millis);
    expect(deadline).toBe(clock.now().monoMs);
  });

  it("composes: two chained durations land on their sum", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const now = clock.now().monoMs;

    const chained = deadlineFrom(deadlineFrom(now, 100 as Millis), 150 as Millis);
    const direct = deadlineFrom(now, 250 as Millis);

    expect(chained).toBe(direct);
  });
});

describe("hasPassed", () => {
  it("is false before the deadline", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const deadline = deadlineFrom(clock.now().monoMs, 100 as Millis);

    expect(hasPassed(clock.now().monoMs, deadline)).toBe(false);
  });

  it("is true at the exact deadline — 'passed' is inclusive, i.e. `>=` not `>`", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const deadline = deadlineFrom(clock.now().monoMs, 100 as Millis);

    clock.advanceBy(100 as Millis);
    expect(hasPassed(clock.now().monoMs, deadline)).toBe(true);
  });

  it("is true after the deadline", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const deadline = deadlineFrom(clock.now().monoMs, 100 as Millis);

    clock.advanceBy(150 as Millis);
    expect(hasPassed(clock.now().monoMs, deadline)).toBe(true);
  });
});

// ── Type-level correctness ────────────────────────────────────────────────
//
// These tests look small because the real assertions are in the TypeScript
// compiler: the whole file must compile for the test to pass. Pattern
// matches packages/utils/state-machine/test/types.test.ts.

describe("types — MonoMs is reachable only through the clock", () => {
  it("clock.now().monoMs and deadlineFrom(...) are the only ways to produce one", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const fromReading: MonoMs = clock.now().monoMs;
    const fromDerivation: MonoMs = deadlineFrom(fromReading, 10 as Millis);
    expect(typeof fromReading).toBe("number");
    expect(typeof fromDerivation).toBe("number");
  });

  // The two blocks below are compile-time only — the comment documents the
  // enforcement instead of `@ts-expect-error`. Empirically confirmed (via a
  // throwaway `tsc --noEmit` outside this package, not committed) that both
  // lines below error exactly as described. Left as comments rather than
  // live `@ts-expect-error` pins for two reasons: (1) this repo's own
  // precedent — packages/utils/state-machine/test/types.test.ts — makes the
  // same choice, to avoid depending on the exact error shape across TS
  // versions; (2) concretely for THIS package, `tsc --noEmit` (the
  // `typecheck` script) never sees `test/**/*` — clock/tsconfig.json
  // excludes it, because `rootDir` is pinned to `./src` so tsup's `dist/`
  // mirrors `src/` 1:1, and TypeScript refuses to include a file outside
  // `rootDir` in the same program. A `@ts-expect-error` here would never be
  // checked by anything this repo runs — it would read as enforced and
  // verify nothing, which is worse than an honest comment.
  //
  // it("a bare number does not satisfy MonoMs", () => {
  //   const notReallyAReading: MonoMs = 12345; // TypeScript errors here.
  // });
  //
  // it("a MonoMs does not satisfy Millis — an instant is not a duration", () => {
  //   const clock = createControlledClock({ initialTime: 0 });
  //   const reading = clock.now().monoMs;
  //   const treatedAsADuration: Millis = reading; // TypeScript errors here.
  // });
});

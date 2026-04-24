import type { Instant } from "@phyxiusjs/clock";

// ── Strategy ──────────────────────────────────────────────────────────────

/**
 * A pure, named, synchronous computation from `TInput` to `TOutput`.
 *
 * **Sync is the fence, not a convenience.** The signature `(input) => output`
 * deliberately cannot express `await`, which means it cannot express IO.
 * The primitive can't *prove* purity (no TypeScript can), but it makes
 * impurity awkward enough to be a review finding.
 *
 * Two consequences fall out of that:
 *
 * 1. **Shadow mode is cheap.** Running a primary and several shadows on the
 *    same input is CPU-bound microseconds, not network-bound milliseconds.
 *    You can deploy shadows in production traffic without a performance
 *    budget discussion — which is the specific thing that keeps the pattern
 *    usable in practice.
 * 2. **Tests don't need mocks.** A strategy is a pure function; its tests
 *    are `expect(compute(input)).toEqual(output)`. No clock mocks, no time
 *    injection, no harness. Business-logic tests become dramatically smaller
 *    because time, IO, and state never enter a strategy's scope.
 *
 * If you need async or IO in your computation, it isn't a strategy — it's a
 * handler. Strategies operate on data you have; handlers fetch data first
 * and then hand it to strategies. That boundary is the point.
 */
export interface Strategy<TInput, TOutput> {
  /**
   * Identity. Appears in every event, every comparison, every journal entry.
   * Convention: dotted + versioned, e.g. `"tax.calculate.v2"`.
   */
  readonly name: string;

  /**
   * The computation. Sync by type, pure by discipline.
   */
  readonly compute: (input: TInput) => TOutput;
}

// ── StrategySet ───────────────────────────────────────────────────────────

/**
 * A group of strategies that all answer the same question. One is
 * authoritative (`primary`); any number run silently as shadows for
 * comparison (`shadow`). Mismatches between primary and shadow are
 * emitted as high-signal events carrying the full input + both outputs.
 *
 * Use cases shadow-compare unlocks:
 *
 *   - **Versioned rollout.** Run `v1` primary, `v2` shadow for a week.
 *     Inspect mismatches. Flip primary to `v2` when you're confident.
 *   - **Experimentation.** Run several candidate algorithms against the
 *     same traffic without committing to any. The "right" one is the one
 *     whose shadow-mismatch pattern matches your intent.
 *   - **Gradual trust.** A new rule can be the shadow of a well-understood
 *     rule for a release cycle before being promoted.
 */
export interface StrategySet<TInput, TOutput> {
  /** Identity of the set (distinct from individual strategy names). */
  readonly name: string;

  /** Every candidate strategy. Must include the primary and all shadows. */
  readonly strategies: ReadonlyArray<Strategy<TInput, TOutput>>;

  /** The authoritative strategy — its output is what `run()` returns. */
  readonly primary: string;

  /** Strategies that run silently and are compared against the primary. */
  readonly shadow: ReadonlyArray<string>;

  /**
   * Equality for shadow comparison. Default: deep structural equality.
   * Supply a custom equals for numerical tolerance, set-based equality,
   * or any domain-specific notion of "same answer."
   */
  readonly equals?: (a: TOutput, b: TOutput) => boolean;
}

// ── Events ────────────────────────────────────────────────────────────────

/**
 * Events emitted during `strategy.run`. The mismatch event is the
 * load-bearing one — it's what turns shadow mode from "nice idea" into
 * "deploy a new rule and observe."
 *
 * Match events are emitted too (for volume accounting), but the mismatch
 * events are what you alert on and diff.
 */
export type StrategyEvent<TInput = unknown, TOutput = unknown> =
  | {
      readonly type: "strategy:computed";
      readonly set: string;
      readonly strategy: string;
      readonly durationMs: number;
      readonly at: Instant;
    }
  | {
      readonly type: "strategy:shadow-match";
      readonly set: string;
      readonly primary: string;
      readonly shadow: string;
      readonly at: Instant;
    }
  | {
      readonly type: "strategy:shadow-mismatch";
      readonly set: string;
      readonly primary: string;
      readonly shadow: string;
      readonly input: TInput;
      readonly primaryOutput: TOutput;
      readonly shadowOutput: TOutput;
      readonly at: Instant;
    }
  | {
      readonly type: "strategy:shadow-error";
      readonly set: string;
      readonly shadow: string;
      readonly cause: unknown;
      readonly at: Instant;
    };

// ── Options ───────────────────────────────────────────────────────────────

export interface StrategySetOptions<TInput, TOutput> {
  readonly name: string;
  readonly strategies: ReadonlyArray<Strategy<TInput, TOutput>>;
  readonly primary: string;
  readonly shadow?: ReadonlyArray<string>;
  readonly equals?: (a: TOutput, b: TOutput) => boolean;
}

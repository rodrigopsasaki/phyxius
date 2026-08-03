import { elapsedSince } from "@phyxiusjs/clock";
import type { Clock } from "@phyxiusjs/clock";

import { deepEquals } from "./equals.js";
import type { Strategy, StrategyEvent, StrategySet, StrategySetOptions } from "./types.js";

// ── Public: define ─────────────────────────────────────────────────────────

/**
 * Construct a named strategy. No runtime machinery — just a typed pair
 * of `name` and `compute`. Strategies are values you pass around and
 * compose into sets.
 *
 * Naming convention: dotted + versioned (`"tax.calculate.v2"`). The
 * primitive doesn't enforce it, but the convention is what lets you
 * tell which version of a rule produced a specific mismatch event
 * months after the fact.
 */
export function define<TInput, TOutput>(name: string, compute: (input: TInput) => TOutput): Strategy<TInput, TOutput> {
  return { name, compute };
}

// ── Public: set ────────────────────────────────────────────────────────────

/**
 * Assemble a set of candidate strategies with one primary and any number
 * of shadows. Validates at construction time:
 *
 *   - `primary` must match one of the strategies' names.
 *   - Every entry in `shadow` must match one of the strategies' names.
 *   - No strategy can be both primary and shadow.
 *   - Strategy names within a set must be unique.
 *
 * These invariants are checked here because a malformed set is never
 * what you want at runtime — better to fail at construction, where the
 * stack trace points at your config.
 */
export function set<TInput, TOutput>(options: StrategySetOptions<TInput, TOutput>): StrategySet<TInput, TOutput> {
  const { name, strategies, primary, shadow = [], equals } = options;

  if (strategies.length === 0) {
    throw new Error(`StrategySet "${name}" must declare at least one strategy.`);
  }

  const byName = new Map<string, Strategy<TInput, TOutput>>();
  for (const s of strategies) {
    if (byName.has(s.name)) {
      throw new Error(`StrategySet "${name}": duplicate strategy name "${s.name}".`);
    }
    byName.set(s.name, s);
  }

  if (!byName.has(primary)) {
    throw new Error(`StrategySet "${name}": primary "${primary}" is not in the strategies list.`);
  }

  const shadowSet = new Set<string>();
  for (const shadowName of shadow) {
    if (!byName.has(shadowName)) {
      throw new Error(`StrategySet "${name}": shadow "${shadowName}" is not in the strategies list.`);
    }
    if (shadowName === primary) {
      throw new Error(`StrategySet "${name}": "${shadowName}" cannot be both primary and shadow.`);
    }
    if (shadowSet.has(shadowName)) {
      throw new Error(`StrategySet "${name}": duplicate shadow "${shadowName}".`);
    }
    shadowSet.add(shadowName);
  }

  const result: {
    name: string;
    strategies: ReadonlyArray<Strategy<TInput, TOutput>>;
    primary: string;
    shadow: ReadonlyArray<string>;
    equals?: (a: TOutput, b: TOutput) => boolean;
  } = { name, strategies, primary, shadow };
  if (equals !== undefined) result.equals = equals;
  return result;
}

// ── Public: run ────────────────────────────────────────────────────────────

/**
 * Run a set against an input. The primary fires first and its output is
 * returned (or its throw is re-thrown — strategies are pure functions;
 * if one throws, it's treated as a bug in the primary). Shadows fire
 * after the primary, inline (same tick), and each is compared against
 * the primary via `equals`.
 *
 * Shadow errors don't abort the result — the primary's output is
 * authoritative. A shadow that throws emits `strategy:shadow-error` and
 * moves on. That isolation is deliberate: a broken shadow should never
 * take down production, and you need to see the breakage to fix it.
 */
export function run<TInput, TOutput>(
  strategySet: StrategySet<TInput, TOutput>,
  input: TInput,
  ctx: { readonly clock: Clock; readonly emit?: (event: StrategyEvent<TInput, TOutput>) => void },
): TOutput {
  const { clock, emit } = ctx;
  const byName = new Map<string, Strategy<TInput, TOutput>>(strategySet.strategies.map((s) => [s.name, s]));

  // Run the primary first. Any throw propagates — this is a bug, not
  // a shadow comparison artifact.
  const primary = byName.get(strategySet.primary);
  if (!primary) {
    // Defensive: `set()` validates this, but `set` could be hand-rolled.
    throw new Error(`StrategySet "${strategySet.name}": primary "${strategySet.primary}" not found.`);
  }

  const primaryStart = clock.now();
  const primaryStartMono = primaryStart.monoMs;
  const primaryOutput = primary.compute(input);
  const primaryEnd = clock.now();

  safeEmit(emit, {
    type: "strategy:computed",
    set: strategySet.name,
    strategy: primary.name,
    durationMs: elapsedSince(primaryEnd.monoMs, primaryStartMono),
    at: primaryEnd,
  });

  // Run each shadow and compare against the primary.
  const eq = strategySet.equals ?? (deepEquals as (a: TOutput, b: TOutput) => boolean);

  for (const shadowName of strategySet.shadow) {
    const shadow = byName.get(shadowName);
    if (!shadow) continue; // validated above; defensive

    let shadowOutput: TOutput;
    const shadowStart = clock.now();
    try {
      shadowOutput = shadow.compute(input);
    } catch (cause) {
      safeEmit(emit, {
        type: "strategy:shadow-error",
        set: strategySet.name,
        shadow: shadow.name,
        cause,
        at: clock.now(),
      });
      continue;
    }
    const shadowEnd = clock.now();

    safeEmit(emit, {
      type: "strategy:computed",
      set: strategySet.name,
      strategy: shadow.name,
      durationMs: elapsedSince(shadowEnd.monoMs, shadowStart.monoMs),
      at: shadowEnd,
    });

    if (eq(primaryOutput, shadowOutput)) {
      safeEmit(emit, {
        type: "strategy:shadow-match",
        set: strategySet.name,
        primary: primary.name,
        shadow: shadow.name,
        at: shadowEnd,
      });
    } else {
      safeEmit(emit, {
        type: "strategy:shadow-mismatch",
        set: strategySet.name,
        primary: primary.name,
        shadow: shadow.name,
        input,
        primaryOutput,
        shadowOutput,
        at: shadowEnd,
      });
    }
  }

  return primaryOutput;
}

// ── Namespace ──────────────────────────────────────────────────────────────

/**
 * Ergonomic grouping — mirrors `retry`, `cb`, `schedule`, `resource`.
 * Call sites read as `strategy.define(...)` / `strategy.set({...})` /
 * `strategy.run(set, input, ctx)`.
 */
export const strategy = {
  define,
  set,
  run,
} as const;

// ── Internals ──────────────────────────────────────────────────────────────

function safeEmit<TInput, TOutput>(
  emit: ((event: StrategyEvent<TInput, TOutput>) => void) | undefined,
  event: StrategyEvent<TInput, TOutput>,
): void {
  if (!emit) return;
  try {
    emit(event);
  } catch {
    // Emitter failures never cascade.
  }
}

# Strategy

Pure named computation with shadow deployment. The primitive that makes experimentation, versioned rollouts, and gradual trust-building a first-class operation instead of a pattern you re-invent per project.

---

## What this really is

A `Strategy<TInput, TOutput>` is a typed, _sync_, named function: `(input) => output`. A `StrategySet` is a group of strategies that answer the same question — one is authoritative (primary), any number run silently alongside it (shadows), and every disagreement between primary and shadow becomes a typed event carrying the full input and both outputs.

Once computations are strategies:

- **Versioned rollouts become free.** Run `v1` primary, `v2` shadow for a week. Read the mismatches. Flip primary to `v2` when you're confident.
- **Experimentation becomes free.** Run three candidate algorithms against the same traffic, inspect each one's disagreement pattern, pick one.
- **Gradual trust becomes free.** A new rule can be the shadow of a well-understood rule for a release cycle before being promoted.
- **Business-logic tests stop needing mocks.** Strategies are pure functions; tests become `expect(compute(input)).toEqual(output)`. No clock, no time injection, no harness.

---

## Installation

```bash
npm install @phyxiusjs/strategy @phyxiusjs/clock
```

---

## Quick start

```ts
import { createSystemClock } from "@phyxiusjs/clock";
import { strategy } from "@phyxiusjs/strategy";

// Two versions of a pricing rule.
const pricingV1 = strategy.define("pricing.v1", (order: Order): number => {
  return order.subtotal * 1.1;
});

const pricingV2 = strategy.define("pricing.v2", (order: Order): number => {
  return order.subtotal * 1.08 + order.shipping;
});

// A set with v1 authoritative and v2 running silently for comparison.
const pricingSet = strategy.set({
  name: "pricing",
  strategies: [pricingV1, pricingV2],
  primary: "pricing.v1",
  shadow: ["pricing.v2"],
});

const clock = createSystemClock();

// Call site: runs v1 (primary), runs v2 silently, compares, returns v1's output.
const total = strategy.run(pricingSet, order, {
  clock,
  emit: (event) => journal.append(event),
});
```

`total` is whatever the primary produced. Every mismatch between primary and shadow flows into your event sink — you read them, you decide what to do about them, you flip the primary when confident.

---

## Sync is the fence, not a convenience

```ts
interface Strategy<TInput, TOutput> {
  readonly name: string;
  readonly compute: (input: TInput) => TOutput; // sync. not Promise<TOutput>.
}
```

The signature is deliberate. Most IO in Node wears `await` — `fetch`, `fs.readFile`, any SDK worth using. A sync signature can't express `await`, which means it can't express IO. The type can't _prove_ purity (no TypeScript can), but it makes impurity awkward enough to be a review finding.

Two consequences:

1. **Shadow mode is cheap.** Running primary and shadows together is CPU-bound microseconds, not network-bound milliseconds. You can deploy shadows in production traffic without a performance-budget discussion. _This is the specific thing that keeps the pattern usable in practice._ Async strategies would force "do I run the shadow?" into every request.

2. **Tests don't need mocks.** A strategy is a pure function. Its tests are `expect(compute(input)).toEqual(output)`. No clock mocks, no `vi.useFakeTimers()`, no injection harness. If you need time or IO in your computation, it isn't a strategy — it's a handler. Strategies operate on data you already have; handlers fetch data first and then hand it to strategies. That boundary is the point.

---

## The `StrategySet` contract

```ts
strategy.set({
  name: "pricing",
  strategies: [v1, v2, v3],
  primary: "pricing.v1",
  shadow: ["pricing.v2", "pricing.v3"],
  equals: (a, b) => Math.abs(a - b) < 0.001, // optional, custom equality
});
```

Construction validates:

- `primary` must match one of the strategy names.
- Every shadow must match one of the strategy names.
- Nothing can be both primary and shadow.
- Strategy names within a set must be unique.

Failure at construction points at your config, not at 3am mid-request.

---

## Default equality

Structural deep equality:

- Primitives: `===`, with `NaN === NaN` as a pragmatic deviation (numeric computations often produce NaN as an intended result).
- Arrays: same length + pairwise deep equal.
- Plain objects: same key set + deep equal values.
- Anything exotic (`Date`, `Map`, `Set`, typed arrays): treated as opaque. If you compare those, supply a custom `equals`.

Custom equality for numerical tolerance, ordering-invariant sets, or domain-specific equivalence:

```ts
strategy.set({
  ...,
  equals: (a, b) => Math.abs(a - b) < 0.01,          // within 1%
  // or
  equals: (a, b) => new Set(a).symmetricDifference(new Set(b)).size === 0,
});
```

---

## Events

```ts
type StrategyEvent<TInput, TOutput> =
  | { type: "strategy:computed"; set; strategy; durationMs; at }
  | { type: "strategy:shadow-match"; set; primary; shadow; at }
  | { type: "strategy:shadow-mismatch"; set; primary; shadow; input; primaryOutput; shadowOutput; at }
  | { type: "strategy:shadow-error"; set; shadow; cause; at };
```

The load-bearing one is `shadow-mismatch`. It carries the **full input and both outputs** — deliberately high-signal, low-volume. When primary and shadow disagree, you want every detail you can get for diffing. The volume is manageable because disagreements are rare (most of the time the new rule behaves like the old one; that's the whole point of shadow mode).

`shadow-match` events are emitted too, but they're for volume accounting, not for alerting. A reasonable observability setup logs mismatches loudly and counts matches silently.

`shadow-error` fires when a shadow's `compute` throws. The primary's output is still returned — a broken shadow never takes down production. You see the breakage in the journal and fix the shadow on your next deploy.

---

## Throw semantics

- **Primary throws → propagates.** The primary is the authoritative computation. If it throws, that's a real bug in the code path that's serving traffic; hiding it would be wrong. `strategy.run` re-throws.
- **Shadow throws → swallowed, emitted as `shadow-error`.** Shadows are candidates, not authorities. A broken shadow must never affect production behavior.

That asymmetry is the whole deal of shadow mode: silent observation with zero blast radius.

---

## Testing strategies

The strategies themselves are just functions. No harness:

```ts
import { describe, expect, it } from "vitest";
import { strategy } from "@phyxiusjs/strategy";

const pricingV2 = strategy.define("pricing.v2", (order: Order): number => {
  return order.subtotal * 1.08 + order.shipping;
});

describe("pricing.v2", () => {
  it("applies 8% to subtotal and adds shipping", () => {
    expect(pricingV2.compute({ subtotal: 100, shipping: 5 })).toBe(113);
  });
});
```

That's the whole test. No mocks, no clock, no injected dependencies. If `pricingV2` needs anything more than data to compute its answer, it isn't a strategy — move the IO out.

---

## What this does NOT do

- **No async / IO.** Sync by type. Any computation needing IO belongs in a handler that pre-fetches the data and passes it to a strategy.
- **No runtime interpreter / state machine.** Strategies aren't a DSL. They're typed functions. `run` is a flat loop, not a framework.
- **No persistence of mismatches.** `emit` is the only sink; pipe it into your journal, drain, or logger of choice. The primitive stays pure.
- **No auto-promotion.** Flipping primary from `v1` to `v2` is a code change — a version control event, a review, a deploy. This is deliberate: promoting a primary is the single most consequential moment in the lifecycle, and it should be explicit and observable.

---

## What you get

- **Versioned computation as a value.** Your business rules are first-class named things that you can track, compare, and swap.
- **Shadow mode that's actually affordable.** Deploy a shadow today, flip primary next week, with no performance budget discussion.
- **Pure tests.** Business-logic tests go back to being `input → output` assertions, which is what they should have been all along.
- **Experimentation without ceremony.** A/B testing, gradual rollout, versioned computation — all the same primitive, not three different tools.

Strategy is the primitive for the computations that define _what your system does_. Handlers run the effects; strategies decide the answers.

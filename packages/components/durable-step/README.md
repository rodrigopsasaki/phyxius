# Durable Step

A step that cannot lie about what it did. Its duration, its spend, and its proof of completion are recorded because the step ran — not because its author remembered to record them.

---

## What this really is

Long-running work fails in a specific, expensive way: it stops halfway and reports nothing useful. You are left with a process that died, a bill you cannot attribute, and no way to tell "finished" from "stopped".

A durable step makes that unrepresentable. Every step declares, up front, what state it moves through, what it will spend, and what would prove it finished. It cannot run without declaring, and it cannot complete without satisfying what it declared.

The discipline, stated once: **absence is never a valid answer.** A step that spends nothing declares `spend.none()` — it does not stay silent. A step that has nothing to prove declares an empty evidence bag — it does not skip the gate. Silence and zero are different states, and this package refuses to conflate them.

If that sounds like `@phyxiusjs/handler`'s rule that no stability decision may be defaulted, it is the same rule pushed one layer out: from *how work behaves* to *whether work happened at all*.

---

## The composition, and why it is not one thing

A durable step is three existing primitives held together, deliberately not merged:

| piece | question it answers | nature |
|---|---|---|
| `@phyxiusjs/state-machine` | is this transition **legal**? | pure, synchronous, no IO by type |
| `@phyxiusjs/migration`'s evidence | has this transition been **earned**? | inherently IO — it asks the world |
| `@phyxiusjs/handler` | lifecycle, concurrency, timeout, journalling | supervised process |

Legality is checked *before* the work runs, cheaply, without spending anything — that is only possible because a transition function cannot await, cannot query, and cannot fail for any reason but "no transition declared here". Earnedness is checked *after*, and can only be answered by looking at the world.

Merging the two would force one of them to lie. A state machine that gains async escape hatches stops being checkable without mocks. An evidence engine that pretends to be synchronous cannot ask anything. The two-phase shape — legality before, proof after — is the point.

---

## What it refuses

The refusals are the feature. Each is a way a step could otherwise have reported success while doing less than it claimed.

| refusal | what it caught |
|---|---|
| `ILLEGAL_TRANSITION` | the step tried to move somewhere its own machine does not allow — including completing twice |
| `STATE_RACE_LOST` | another worker moved this operation while we held a stale view |
| `SPEND_UNACCOUNTED` | the step declared it would spend, ran, and never recorded what it spent |
| `SPEND_DECLARED_NONE_BUT_RECORDED` | the step promised to spend nothing and then spent |
| `PROOF_FAILED` | the completion evidence was gathered and did not hold |
| `PROOF_ERRORED` | the evidence could not be gathered at all — *distinct from failing*, because "could not check" is not "checked and false" |

That last distinction is load-bearing. A system that folds "I could not verify" into "it failed" — or worse, into "it passed" — is the failure mode this package exists to remove.

Refusals arrive as typed values. Narrow them with `isStepRefusal`, or catch `StepRefusalThrown` at a boundary.

---

## Declaring a step

```ts
import { defineDurableStep, spend, createMemoryStateStore } from "@phyxiusjs/durable-step";

const step = defineDurableStep({
  name: "extract-symbols",
  machine,                       // the legal transitions
  eventType: "extracted",
  toEvent: (input, output) => ({ type: "extracted", count: output.symbols.length }),
  input: inputValidator,
  output: outputValidator,
  fields: { repo: "acme/widget" },

  timeout: 30_000,
  concurrency: /* … */,
  retry: /* … */,
  circuitBreaker: /* … */,

  spend: spend.metered({ unit: "llm-call" }),   // or spend.none() — never omitted
  proof: { symbolsIndexed: /* evidence */ },

  run: async (input, tools) => {
    const symbols = await index(input.path);
    tools.spend.record(symbols.length);          // required: declared metered, must record
    return { symbols };
  },
});
```

Omit `spend` and it does not compile. Declare `metered` and never record, and it does not complete.

---

## Retry, conserved

Retry capacity belongs to the operation, not to each step inside it. `createRetryLedger` hands out attempts from one pool, so decomposing work into more steps cannot mint more retries — the failure mode where a runaway loop multiplies itself into a vendor outage.

```ts
const ledger = createRetryLedger({ attempts: 6 });
```

---

## Running a sequence

`runClimb` wraps a sequence of steps and reports what the sequence itself could not account for:

```ts
const result = await runClimb(steps, deps);
result.accountedMs;    // time inside declared steps
result.unaccountedMs;  // time between them — named, not hidden
```

`unaccountedMs` is deliberately surfaced rather than swallowed. A sequence built entirely from declared steps still reports a small non-zero value: the glue between steps is itself unmeasured. Naming it is honest; pretending it is zero would not be.

---

## Status

Published and in use, but young. Known edges, stated plainly:

- **The retry ledger is in-process.** It conserves attempts across steps in one process; it does not survive a process hop. Work on a durable, cross-process ledger is in progress — until it lands, a revived step in a fresh process starts with a fresh pool.
- **`StateStore` ships with an in-memory implementation.** Real durability means supplying your own backed by real storage; the interface is the contract, `createMemoryStateStore` is for tests.
- Shaped by a bounded `find-shape` run against real workloads rather than designed in the abstract. The log, including what it got wrong on the way, is in `docs/notes/2026-08-17-durable-step-find-shape.md`.

Built for [Mycelium](https://github.com/mycelium-ai-labs/mycelium) and extracted because the problem is not Mycelium-shaped. If it is useful to you, that is a happy consequence rather than a design goal.

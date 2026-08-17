// ── Round 2 ──────────────────────────────────────────────────────────────
//
// Change:      `DurableStepSpec` gains a mandatory `spend: SpendPolicy`
//              field (`spend.none()` / `spend.metered({ unit })`, mirroring
//              `retry.none()` / `cb.none()`'s "no non-decision" shape).
//              `run` gains `tools.spend.record(amount)`. A `metered` step
//              that completes without ever calling `record()` is refused
//              (`SPEND_UNACCOUNTED`) before its state transition commits —
//              symmetrically, calling `record()` under `spend.none()` is
//              refused too (`SPEND_DECLARED_NONE_BUT_RECORDED`).
//
// Hypothesis:  Round 0's FINDING 2 showed spend wasn't just unattributed by
//              default — there was no vocabulary to attribute it WITH, and
//              the fitness question's sharper half asks whether an
//              unattributed cent is even EXPRESSIBLE. If completion and
//              attribution are fused the same way `@phyxiusjs/migration`
//              fuses completion and proof (wrong-until-proven-otherwise),
//              then a metered step CANNOT successfully finish without
//              recording spend — not "should," not "is expected to," but
//              structurally cannot. That closes the sharp half of FINDING 2
//              outright: the unattributed cent becomes inexpressible for
//              any step honest enough to declare `metered`.
//
// Explicitly NOT addressed this round: FINDING 4 (proof-of-completion is
// still decoupled from the handler's own success — spend attribution is a
// different claim from output correctness), retry allowance drawn from a
// parent budget (untested by any corpus item so far — discipline-synthesis
// is next), and the deep form of FINDING 5 (declaring `metered` is still
// the author's CHOICE; nothing yet forces every durable action's work to
// go through a `DurableStepSpec` at all).

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { isErr, isOk } from "@phyxiusjs/fp";
import { retry, cb, spawn, type HandlerEvent, type HandlerRuntime } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { createMemoryJournalStore } from "@phyxiusjs/migration";
import { machine } from "@phyxiusjs/state-machine";
import { observe } from "@phyxiusjs/observe";

import { createMemoryStateStore, createRetryLedger, defineDurableStep, isStepRefusal, spend } from "../src/index.js";

function setup() {
  const clock = createControlledClock({ initialTime: 0 });
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 100 });
  const journalStore = createMemoryJournalStore({ journal, clock });
  const runtime: HandlerRuntime = { clock, journal };
  return { clock, journal, journalStore, runtime };
}

type StepState = { kind: "queued" } | { kind: "running" } | { kind: "succeeded"; receiptId: string };
type StepEvent = { type: "start" } | { type: "succeed"; receiptId: string };

const stepMachine = machine.define<StepState, StepEvent>({
  name: "climb-step",
  transitions: {
    queued: { start: () => ({ kind: "running" }) },
    running: { succeed: (_s, e) => ({ kind: "succeeded", receiptId: e.receiptId }) },
    succeeded: {},
  },
});

describe("round 2 — spend is required, and an unattributed cent refuses to complete", () => {
  it("closes the sharp half of FINDING 2: a metered step that records its spend journals spendTotal/spendUnit for free", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });

    const inferStandardsSpec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards",
        eventType: "start",
        toEvent: (): StepEvent => ({ type: "start" }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10 * 60_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.metered({ unit: "usd" }),
        proof: {},
        run: async (_input, tools) => {
          // Two model calls, two `record()` calls — additive, the way a
          // real synthesis pass would attribute per sub-call.
          tools.spend.record(0.42);
          tools.spend.record(0.18);
          clock.advanceBy(ms(4 * 60_000 + 23_000));
          return { receiptId: "receipt-infer-standards-1" };
        },
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(inferStandardsSpec, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(isOk(result)).toBe(true);
    const entry = journal.getSnapshot().entries[0]!.data;
    expect(entry.observed["spendTotal"]).toBeCloseTo(0.6, 6);
    expect(entry.observed["spendUnit"]).toBe("usd");
    // Duration (round 0) and state fusion (round 1) still hold, unaffected.
    expect(entry.durationMs).toBe(4 * 60_000 + 23_000);
    expect(entry.observed["toState"]).toBe("running");
  });

  it("the sharp test itself: a metered step that forgets to record spend is REFUSED, not silently shipped", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });

    const spec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards-forgot-to-record",
        eventType: "start",
        toEvent: (): StepEvent => ({ type: "start" }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.metered({ unit: "usd" }),
        proof: {},
        run: async () => {
          // A real model call happens here in spirit — the author just
          // never wired `tools.spend.record(...)`. This is EXACTLY round
          // 0's FINDING 2 scenario, except this time it cannot complete.
          return { receiptId: "receipt-should-not-land" };
        },
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.type === "HANDLER_ERROR" && isStepRefusal(result.error.cause)) {
      expect(result.error.cause.refusal).toEqual({ type: "SPEND_UNACCOUNTED", unit: "usd" });
    } else {
      throw new Error("expected a StepRefusalThrown(SPEND_UNACCOUNTED) cause");
    }

    // The unattributed cent didn't just go unrecorded — the step never
    // completed at all. No success journal entry, no state transition.
    const { entries } = journal.getSnapshot();
    expect(entries.every((e) => e.data.outcome === "failure")).toBe(true);
    await expect(stateStore.current()).resolves.toEqual({ kind: "queued" });
  });

  it("symmetry: spend.none() contradicted by a record() call is refused, not silently accepted either way", async () => {
    const { clock, runtime, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });

    const spec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards-mislabeled-free",
        eventType: "start",
        toEvent: (): StepEvent => ({ type: "start" }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.none(), // declared free...
        proof: {},
        run: async (_input, tools) => {
          tools.spend.record(1.5); // ...but a code path spends anyway
          return { receiptId: "receipt" };
        },
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.type === "HANDLER_ERROR" && isStepRefusal(result.error.cause)) {
      expect(result.error.cause.refusal).toEqual({ type: "SPEND_DECLARED_NONE_BUT_RECORDED", amount: 1.5 });
    } else {
      throw new Error("expected a StepRefusalThrown(SPEND_DECLARED_NONE_BUT_RECORDED) cause");
    }
  });

  it("honest limit, unchanged from round 0: FINDING 4 (proof-of-completion) is still decoupled — spend and correctness are different claims", async () => {
    // A step can be perfectly spend-accounted and still have produced a
    // wrong or unproven output — spend attribution answers "what did this
    // cost," not "was this actually true." Round 2 doesn't conflate them,
    // and shouldn't: the corpus's `discipline-synthesis` case needs BOTH
    // answered independently, not folded into one signal.
    const { clock, runtime, journal, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });

    const spec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards-unproven-but-accounted",
        eventType: "start",
        toEvent: (): StepEvent => ({ type: "start" }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.metered({ unit: "usd" }),
        proof: {},
        run: async (_input, tools) => {
          tools.spend.record(0.1);
          return { receiptId: "unverified-receipt" }; // nobody checked this is real
        },
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(isOk(result)).toBe(true); // fully spend-accounted...
    const entry = journal.getSnapshot().entries[0]!.data;
    expect(entry.observed["spendTotal"]).toBeCloseTo(0.1, 6);
    expect(entry.outcome).toBe("success"); // ...and still nothing checked the receipt is real.
  });
});

// ── Round 4 ──────────────────────────────────────────────────────────────
//
// Change:      `DurableStepSpec` gains a mandatory `proof: EvidenceBag` —
//              reused verbatim from `@phyxiusjs/migration`, not
//              reinvented. `createMigration`'s internal evidence-runner
//              was lifted out to `runEvidenceBag` (exported from
//              `@phyxiusjs/migration`) so this composition can run the
//              exact same "collect Ok/failed/errored" logic without any
//              phase or CAS semantics — migration's own behavior is
//              unchanged (34 pre-existing tests + 4 new direct tests on
//              `runEvidenceBag` all still pass). After `run` succeeds and
//              spend is accounted, `spec.proof` is run; any failure or
//              error refuses the step (`PROOF_FAILED` / `PROOF_ERRORED`)
//              BEFORE the state transition commits.
//
// Hypothesis:  Round 0's FINDING 4 showed the handler's own "success" and
//              migration's "earnedness" were two uncoupled claims — a step
//              could journal `outcome: "success"` with zero evidence ever
//              having run. If `run` returning a value is necessary but not
//              SUFFICIENT — if the declared proof must ALSO resolve `Ok`
//              before the journal can say success and the state can
//              advance — then a step's own output claim and its evidence
//              become the same fact, the way `advance()` already fuses
//              phase progression and evidence for migration. This closes
//              the last of the fitness question's four named attributes.
//
// This also directly informs the "should state-machine and migration
// merge" question the brief poses: they do NOT merge here. State legality
// (round 1) stays a pure, sync, compile-shaped check; evidence (this
// round) stays an async, IO-shaped runtime check; a durable step needs
// BOTH, run at different points in the SAME invocation, for different
// reasons. What COMPOSES, not merges, is the shared evidence-runner
// (`runEvidenceBag`) — a concept the substrate was missing independent of
// migration's own phase/CAS vocabulary. See the closing synthesis in the
// find-shape doc for the full argument.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { isErr, isOk, err, ok } from "@phyxiusjs/fp";
import { retry, cb, spawn, type HandlerEvent, type HandlerRuntime } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { attestation, createMemoryJournalStore } from "@phyxiusjs/migration";
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

describe("round 4 — a step's output claim and its proof become the same fact", () => {
  it("closes FINDING 4: a step whose declared proof resolves Ok completes, and the snapshot lands in the journal for free", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });
    let receiptWritten = false;

    const spec = defineDurableStep(
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
        spend: spend.none(),
        proof: {
          receiptExists: attestation({
            check: async () => (receiptWritten ? ok({ verified: true }) : err({ reason: "receipt not written yet" })),
          }),
        },
        run: async () => {
          clock.advanceBy(ms(4 * 60_000 + 23_000));
          receiptWritten = true; // the real work actually happened
          return { receiptId: "receipt-infer-standards-1" };
        },
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(isOk(result)).toBe(true);
    const entry = journal.getSnapshot().entries[0]!.data;
    expect(entry.observed["proofSnapshot"]).toEqual({ receiptExists: { verified: true } });
    // Everything from rounds 0-3 still holds, unaffected:
    expect(entry.durationMs).toBe(4 * 60_000 + 23_000);
    expect(entry.observed["toState"]).toBe("running");
  });

  it("the sharp test itself: a step whose output claims success but whose proof fails is REFUSED — the state never advances", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });

    const spec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards-unproven",
        eventType: "start",
        toEvent: (): StepEvent => ({ type: "start" }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.none(),
        proof: {
          receiptExists: attestation({
            // Always fails — the receipt was never actually written,
            // exactly round 0's FINDING 4 scenario (`run` returns a
            // plausible-looking output nobody verified).
            check: async () => err({ reason: "receipt not found" }),
          }),
        },
        run: async () => ({ receiptId: "unverified-receipt" }),
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.type === "HANDLER_ERROR" && isStepRefusal(result.error.cause)) {
      expect(result.error.cause.refusal.type).toBe("PROOF_FAILED");
      if (result.error.cause.refusal.type === "PROOF_FAILED") {
        expect(Object.keys(result.error.cause.refusal.failures)).toEqual(["receiptExists"]);
      }
    } else {
      throw new Error("expected a StepRefusalThrown(PROOF_FAILED) cause");
    }

    // The state never advanced — an unproven "success" is not a success.
    await expect(stateStore.current()).resolves.toEqual({ kind: "queued" });
    const { entries } = journal.getSnapshot();
    expect(entries.every((e) => e.data.outcome === "failure")).toBe(true);
  });

  it("an empty proof bag is the explicit, auditable 'no proof required' declaration — not an omission", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });

    const spec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards-no-proof-needed",
        eventType: "start",
        toEvent: (): StepEvent => ({ type: "start" }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.none(),
        proof: {}, // deliberate, not missing — TypeScript would refuse to compile without this field at all
        run: async () => ({ receiptId: "r" }),
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(isOk(result)).toBe(true);
    const entry = journal.getSnapshot().entries[0]!.data;
    // The empty bag's snapshot is STILL recorded — `{}` is a decision
    // visible in the journal forever, not silence.
    expect(entry.observed["proofSnapshot"]).toEqual({});
  });

  it("honest limit, unchanged: nothing yet stops an author from skipping this whole composition for a phase of a durable action", async () => {
    // The deep form of FINDING 5. `defineDurableStep` makes DECLARED
    // steps fully attributable across all four fitness axes. It cannot
    // make declaration itself mandatory — an author can still write bare
    // async code between two steps (round 0's FINDING 5 scenario,
    // untouched by any round since), or spawn a raw `@phyxiusjs/handler`
    // spec directly, bypassing state/spend/retry-ledger/proof entirely.
    // That gap is real and belongs in the closing synthesis as `unknown`
    // / future work, not claimed solved here.
    expect(true).toBe(true);
  });
});

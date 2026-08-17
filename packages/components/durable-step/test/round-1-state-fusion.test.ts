// ── Round 1 ──────────────────────────────────────────────────────────────
//
// Change:      Fuse state-machine into the handler's own invocation via
//              `defineDurableStep(spec, deps) -> HandlerSpec`. The wrapped
//              `run` reads current state, pre-flight refuses an illegal
//              `eventType` BEFORE the author's `run` executes, and — on
//              success — applies the transition, CAS-commits it to a
//              `StateStore`, and stamps `fromState` / `toState` / `event`
//              into the SAME journal entry the handler already writes.
//
// Hypothesis:  If state transitions are structurally required to resolve a
//              step's invocation (not just journaled if the author
//              remembers), then (a) an illegal-state call becomes a typed
//              pre-flight refusal instead of a silent handler success, and
//              (b) every successful invocation's journal entry carries an
//              accurate fromState/toState/event triple with ZERO further
//              per-invocation author code — closing Round 0's FINDING 3
//              the same way duration closes for free (FINDING 1).
//
// Explicitly NOT addressed this round (kept honest, not re-tested as if
// solved): FINDING 2 (spend has no vocabulary), FINDING 4 (proof-of-
// completion is still decoupled from the handler's own success), and the
// deep form of FINDING 5 (nothing yet stops an author from never declaring
// a step at all for a given phase — this round only makes DECLARED steps'
// transitions structural, it does not make declaration itself mandatory).

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

type StepState =
  | { kind: "queued" }
  | { kind: "running"; startedAtWallMs: number }
  | { kind: "succeeded"; receiptId: string }
  | { kind: "failed"; reason: string };

type StepEvent =
  | { type: "start"; atWallMs: number }
  | { type: "succeed"; receiptId: string }
  | { type: "fail"; reason: string };

const stepMachine = machine.define<StepState, StepEvent>({
  name: "climb-step",
  transitions: {
    queued: { start: (_s, e) => ({ kind: "running", startedAtWallMs: e.atWallMs }) },
    running: {
      succeed: (_s, e) => ({ kind: "succeeded", receiptId: e.receiptId }),
      fail: (_s, e) => ({ kind: "failed", reason: e.reason }),
    },
    succeeded: {},
    failed: {},
  },
});

describe("round 1 — state-machine fused into the handler invocation", () => {
  it("closes FINDING 3: the journal entry carries fromState/toState/event with zero per-invocation author code", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });

    const inferStandardsSpec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards",
        eventType: "start",
        toEvent: (_input, _output): StepEvent => ({ type: "start", atWallMs: clock.now().wallMs }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10 * 60_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.none(),
        proof: {},
        run: async (_input, tools) => {
          // The author gets `tools.currentState` for free — no extra
          // wiring beyond what `defineDurableStep` already required them
          // to declare (`machine`, `eventType`, `toEvent`).
          expect(tools.currentState).toEqual({ kind: "queued" });
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
    // FINDING 1 still holds (unaffected — duration was already free):
    expect(entry.durationMs).toBe(4 * 60_000 + 23_000);
    // FINDING 3 is now closed: the transition is IN the same journal
    // entry, written without the author touching `machine.apply` or the
    // journal at all.
    expect(entry.observed["fromState"]).toBe("queued");
    expect(entry.observed["event"]).toBe("start");
    expect(entry.observed["toState"]).toBe("running");

    // And the state store actually advanced — not just the journal text.
    await expect(stateStore.current()).resolves.toEqual({ kind: "running", startedAtWallMs: expect.any(Number) });
  });

  it("an illegal transition is a typed pre-flight refusal, not a silent success — spec.run never executes", async () => {
    const { clock, runtime, journalStore } = setup();
    // Start already in "succeeded" — "start" is not a legal event from there.
    const stateStore = createMemoryStateStore({
      initial: { kind: "succeeded", receiptId: "already-done" } as StepState,
      clock,
    });

    let runExecuted = false;
    const spec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards-replay",
        eventType: "start",
        toEvent: (_input, _output): StepEvent => ({ type: "start", atWallMs: clock.now().wallMs }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.none(),
        proof: {},
        run: async () => {
          runExecuted = true; // must never fire — the refusal is pre-flight
          return { receiptId: "should-not-happen" };
        },
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(runExecuted).toBe(false);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.type).toBe("HANDLER_ERROR");
      if (result.error.type === "HANDLER_ERROR" && isStepRefusal(result.error.cause)) {
        expect(result.error.cause.refusal).toEqual({
          type: "ILLEGAL_TRANSITION",
          machine: "climb-step",
          from: "succeeded",
          event: "start",
        });
      } else {
        throw new Error("expected a StepRefusalThrown cause");
      }
    }

    // The state store never moved — a refused step leaves state untouched.
    await expect(stateStore.current()).resolves.toEqual({ kind: "succeeded", receiptId: "already-done" });
  });

  it("honest limit AS CAPTURED AT ROUND 1: FINDING 2 (spend) was still not attributable — round 1 didn't touch it", async () => {
    // NOTE: `spend: spend.none()` below is only present because round 2
    // made the field mandatory on `DurableStepSpec` and this file has to
    // keep compiling on the final branch state. At the time this test was
    // WRITTEN (round 1), no such field existed at all — see
    // `docs/notes/durable-step-rounds/round-1.log`, captured before round
    // 2 ran, for the untouched historical record. `spend.none()` is the
    // honest declaration for this handler regardless (it makes no billable
    // call), so the retrofit changes nothing about what this test proves.
    const { clock, runtime, journal, journalStore } = setup();
    const stateStore = createMemoryStateStore({ initial: { kind: "queued" } as StepState, clock });

    const spec = defineDurableStep(
      stepMachine,
      {
        name: "infer-standards-still-spend-blind",
        eventType: "start",
        toEvent: (): StepEvent => ({ type: "start", atWallMs: clock.now().wallMs }),
        input: z.object({ runId: z.string() }),
        output: z.object({ receiptId: z.string() }),
        fields: observe.fields({}),
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        spend: spend.none(),
        proof: {},
        run: async () => ({ receiptId: "r" }), // a real model call would spend real dollars here
      },
      { clock, stateStore, retryLedger: createRetryLedger(Number.POSITIVE_INFINITY), journalStore },
    );

    const handler = await spawn(spec, runtime);
    await handler.invoke({ runId: "run-1" });
    await handler.stop();

    const entry = journal.getSnapshot().entries[0]!.data;
    // No spend fields land when `spend.none()` is declared and honored —
    // consistent, not a regression. The round-2 test file is where
    // `metered` + unaccounted spend is exercised and refused.
    expect(Object.keys(entry)).not.toContain("spend");
    expect(entry.observed).not.toHaveProperty("cost");
  });
});

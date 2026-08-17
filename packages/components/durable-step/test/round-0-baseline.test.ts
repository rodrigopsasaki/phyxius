// ── Round 0 — baseline, unchanged ────────────────────────────────────────
//
// Express corpus item 1 (`infer-standards` — a synthesis pass, 4m23s on the
// 2026-08-17 run; bounded work, one obvious receipt) using
// @phyxiusjs/state-machine + @phyxiusjs/migration + @phyxiusjs/handler
// EXACTLY as they ship today. No new code, no helpers, no glue — that glue
// IS what round 1+ would add, and adding it here would contaminate the
// baseline. Every `it()` below is a scored observation against the fitness
// question, not a correctness test of the underlying packages (those have
// their own test suites).
//
// Fitness question (held constant across every round):
//   Can a new durable step be declared such that its duration, its spend,
//   its retry allowance drawn from a parent budget, and its proof of
//   completion are ALL attributable — without the step's author having
//   written anything to make that true? And conversely: is an unattributed
//   minute or an unattributed cent even EXPRESSIBLE?

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { isOk, ok } from "@phyxiusjs/fp";
import { defineHandler, spawn, retry, cb, type HandlerEvent, type HandlerRuntime } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { attestation, createMemoryJournalStore, createMigration, defineMigration } from "@phyxiusjs/migration";
import { machine } from "@phyxiusjs/state-machine";
import { observe } from "@phyxiusjs/observe";

function setup() {
  const clock = createControlledClock({ initialTime: 0 });
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 100 });
  const runtime: HandlerRuntime = { clock, journal };
  return { clock, journal, runtime };
}

// ── The climb-step vocabulary, hand-modeled per corpus-item-1's shape ───────
// Nothing forces these particular states/events to exist. An author picks
// them the same way they'd pick any local type — the machine package has
// no opinion about what a "climb step" is.

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
    queued: {
      start: (_s, e) => ({ kind: "running", startedAtWallMs: e.atWallMs }),
    },
    running: {
      succeed: (_s, e) => ({ kind: "succeeded", receiptId: e.receiptId }),
      fail: (_s, e) => ({ kind: "failed", reason: e.reason }),
    },
    succeeded: {},
    failed: {},
  },
});

describe("round 0 — infer-standards, expressed with today's three primitives, unchanged", () => {
  it("FINDING 1 (pass, free): duration is attributable with zero author effort", async () => {
    const { clock, runtime, journal } = setup();

    const inferStandards = defineHandler({
      name: "infer-standards",
      input: z.object({ runId: z.string() }),
      output: z.object({ receiptId: z.string() }),
      fields: observe.fields({}), // the author declares NOTHING beyond the handler's own mandatory shape
      timeout: ms(10 * 60_000), // 10 min ceiling — real run was 4m23s
      concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      run: async () => {
        // Simulate the 4m23s synthesis pass by advancing the controlled
        // clock synchronously from inside the run body — no real wait,
        // deterministic duration.
        clock.advanceBy(ms(4 * 60_000 + 23_000));
        return { receiptId: "receipt-infer-standards-1" };
      },
    });

    const handler = await spawn(inferStandards, runtime);
    const result = await handler.invoke({ runId: "run-1" });
    await handler.stop();

    expect(isOk(result)).toBe(true);

    const entry = journal.getSnapshot().entries[0]!.data;
    // The author wrote NOTHING to make duration attributable. It falls out
    // of using the handler at all — HandlerEvent.durationMs is mandatory,
    // stamped by spawn()'s own executeWork(), not something run() opts into.
    expect(entry.durationMs).toBe(4 * 60_000 + 23_000);
    expect(entry.outcome).toBe("success");
  });

  it("FINDING 2 (fail, sharp): spend is not merely unattributed by default — it has no vocabulary to attribute it WITH", async () => {
    const { runtime, journal } = setup();

    // HandlerSpec's required fields are: name, input, output, fields,
    // timeout, concurrency, retry, circuitBreaker, run. There is no
    // `spend` field to omit — unlike retry/circuitBreaker (where
    // retry.none() / cb.none() are the explicit "no decision" values),
    // there is no spend.none() because there is no `spend` at all. The
    // ONLY avenue is the free-form `observe.fields` bag, which is
    // opt-in and untyped-by-convention: nothing distinguishes "this
    // handler makes zero model calls" from "this handler makes six model
    // calls and the author didn't wire the field."
    const inferStandards = defineHandler({
      name: "infer-standards-spend-blind",
      input: z.object({ runId: z.string() }),
      output: z.object({ receiptId: z.string() }),
      fields: observe.fields({}), // <- a real model call happens in `run`; nothing here says so
      timeout: ms(10 * 60_000),
      concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      run: async () => {
        // A real synthesis call would spend real dollars here. The type
        // system has no field to refuse compiling without.
        return { receiptId: "receipt-infer-standards-2" };
      },
    });

    const handler = await spawn(inferStandards, runtime);
    const result = await handler.invoke({ runId: "run-2" });
    await handler.stop();

    expect(isOk(result)).toBe(true);
    const entry = journal.getSnapshot().entries[0]!.data;
    // The journal entry that IS the record of this invocation carries no
    // cost/spend key anywhere in its typed shape, and `observed` (the one
    // place a cost COULD have landed) is empty because the author never
    // wrote to it — and nothing required them to.
    expect(entry.observed).toEqual({});
    expect(Object.keys(entry)).not.toContain("spend");
    expect(Object.keys(entry)).not.toContain("cost");
    // The unattributed cent is not just possible — it's the default.
  });

  it("FINDING 3 (fail): state-machine legality is a disconnected island from the handler's own invocation", async () => {
    const { runtime, journal } = setup();

    const inferStandards = defineHandler({
      name: "infer-standards-untracked-state",
      input: z.object({ runId: z.string() }),
      output: z.object({ receiptId: z.string() }),
      fields: observe.fields({}),
      timeout: ms(10 * 60_000),
      concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      run: async () => ({ receiptId: "receipt-infer-standards-3" }),
    });

    const handler = await spawn(inferStandards, runtime);

    // The author declared a `stepMachine` above (queued -> running ->
    // succeeded/failed) but NOTHING in `defineHandler`/`spawn` requires
    // it to be referenced, let alone driven, for the handler to run.
    // `apply()` is never called here at all — compiles, runs, journals.
    const result = await handler.invoke({ runId: "run-3" });
    await handler.stop();

    expect(isOk(result)).toBe(true);
    // The handler's own journal entry exists...
    expect(journal.getSnapshot().entries).toHaveLength(1);
    // ...but nowhere does it carry the machine's name, the state it was
    // in, or the event that fired. `machine.apply` and `spawn` do not
    // know about each other; composing them is 100% the author's
    // discipline, unenforced by any type.
    const entry = journal.getSnapshot().entries[0]!.data;
    expect(entry.observed).not.toHaveProperty("stepMachineState");
    expect(stepMachine.name).toBe("climb-step"); // proves the machine exists, unused
  });

  it("FINDING 4 (fail, sharp): migration's evidence gate can express proof-of-completion only by contortion, and the handler's own success is not coupled to it", async () => {
    const { runtime, journal } = setup();

    const inferStandards = defineHandler({
      name: "infer-standards-unproven",
      input: z.object({ runId: z.string() }),
      output: z.object({ receiptId: z.string() }),
      fields: observe.fields({}),
      timeout: ms(10 * 60_000),
      concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      run: async () => ({ receiptId: "receipt-infer-standards-4" }),
    });

    const handler = await spawn(inferStandards, runtime);
    const result = await handler.invoke({ runId: "run-4" });

    expect(isOk(result)).toBe(true);
    const entry = journal.getSnapshot().entries[0]!.data;
    // The handler ALREADY says "success" — no evidence has run yet.
    expect(entry.outcome).toBe("success");

    // `migration` is built for expand-and-contract between REST states,
    // minimum two phases. There is no such thing as "one step, proven or
    // not" in its vocabulary — to get proof-of-completion out of it at
    // all, an author has to invent a fake two-phase migration per step:
    const journalStore = createMemoryJournalStore({ journal, clock: runtime.clock });
    const proofSpec = defineMigration({
      name: `infer-standards-unproven-proof`,
      phases: {
        pending: { evidence: {} },
        proven: {
          evidence: {
            receiptExists: attestation({
              check: async () => {
                // A real check would look the receipt up. This is the
                // ONLY place "proof of completion" is checked at all —
                // and it's a second primitive, bolted on by hand, per
                // step, that nothing forces the author to invoke.
                return ok({ receiptId: "receipt-infer-standards-4" });
              },
            }),
          },
        },
      },
    });
    const proof = createMigration(proofSpec, { clock: runtime.clock, journal, journalStore });

    // The step's journal entry already reads "success" whether or not the
    // next line runs. Comment it out and every earlier assertion in this
    // test still passes — the handler's success and the migration's
    // earnedness are two uncoupled claims, and the composition supplies
    // no seam that forces the second to gate the first.
    const advance = await proof.advance();
    expect(isOk(advance)).toBe(true); // when an author DOES wire it, it works...
    // ...but the handler's outcome, already journaled, was never
    // conditioned on it. A step that never calls `.advance()` at all is
    // indistinguishable, from the handler's own journal, from one that
    // did and passed.

    await handler.stop();
  });

  it("FINDING 5 (fail, the hardest case): work between two declared steps is invisible by construction — nothing here can even notice it, let alone forbid it", async () => {
    const { clock, runtime, journal } = setup();

    const extractStep = defineHandler({
      name: "extract",
      input: z.object({ runId: z.string() }),
      output: z.object({ fileCount: z.number() }),
      fields: observe.fields({}),
      timeout: ms(60_000),
      concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      run: async () => ({ fileCount: 42 }),
    });
    const queueStep = defineHandler({
      name: "queue",
      input: z.object({ runId: z.string() }),
      output: z.object({ queued: z.boolean() }),
      fields: observe.fields({}),
      timeout: ms(60_000),
      concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      run: async () => ({ queued: true }),
    });

    const extract = await spawn(extractStep, runtime);
    const queue = await spawn(queueStep, runtime);

    // This is the 25 invisible minutes: a clone happens here, as plain
    // async code, between two declared steps. It is not a handler
    // invocation. It cannot be, because nothing about `defineHandler` /
    // `spawn` / `machine.define` / `defineMigration` requires ALL work
    // inside a durable action to be wrapped in one of them — the
    // composition has no outer boundary that would even notice a bare
    // `await` sitting between two `handler.invoke()` calls, let alone
    // refuse to compile or run without one.
    clock.advanceBy(ms(25 * 60_000)); // <- clone + file-level extraction + queuing, today: nothing

    await extract.invoke({ runId: "run-5" });
    await queue.invoke({ runId: "run-5" });
    await extract.stop();
    await queue.stop();

    // Two journal entries exist. The 25 minutes between session start and
    // the first of them do not, and cannot, appear — there is no third
    // entry, no gap marker, nothing. The composition, as it ships today,
    // is silent about exactly the phase corpus item 3 says nobody had to
    // declare, so nobody did.
    expect(journal.getSnapshot().entries).toHaveLength(2);
    expect(journal.getSnapshot().entries.some((e) => e.data.name.includes("clone"))).toBe(false);
  });
});

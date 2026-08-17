// ── Round 5 ──────────────────────────────────────────────────────────────
//
// Change:      `runClimb(name, deps, fn)` wraps a whole durable action.
//              It measures the climb's total wall time, queries the SAME
//              `JournalStore` every `proof` evidence source already reads
//              from — just windowed to the climb's own span — sums every
//              declared step's `durationMs` inside that window, and
//              journals the delta as `unaccountedMs`.
//
// Hypothesis:  Round 0's FINDING 5 (corpus item 3, the hardest case) showed
//              that work between two declared steps is invisible BY
//              CONSTRUCTION — nothing in rounds 1-4 changes that, because
//              no composition can force an author to declare a step; a
//              bare `await` is just JavaScript. But the GAP ITSELF —
//              its duration — is not similarly unreachable: it's exactly
//              `climb total - sum(declared step durations)`, computable
//              from data the journal already has. If a climb wrapper
//              journals that number automatically, then "35 minutes total,
//              10 minutes of declared stages" stops being silence and
//              becomes `unaccountedMs: 1_500_000` — a named, alertable
//              fact — even though the WORK inside those 25 minutes is
//              still opaque. Turning an unknown-unknown into a
//              known-unknown is the honest ceiling of what a library-level
//              composition can do here; forcing declaration itself is a
//              different kind of intervention (lint rule, orchestrator
//              boundary, code review), out of scope for what these four
//              packages compose into.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { retry, cb, spawn, type HandlerEvent, type HandlerRuntime } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { createMemoryJournalStore } from "@phyxiusjs/migration";
import { machine } from "@phyxiusjs/state-machine";
import { observe } from "@phyxiusjs/observe";

import { createMemoryStateStore, createRetryLedger, defineDurableStep, runClimb, spend } from "../src/index.js";

function setup() {
  const clock = createControlledClock({ initialTime: 0 });
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 100 });
  const journalStore = createMemoryJournalStore({ journal, clock });
  const runtime: HandlerRuntime = { clock, journal };
  return { clock, journal, journalStore, runtime };
}

type StageState = { kind: "pending" } | { kind: "done" };
type StageEvent = { type: "complete" };

const stageMachine = machine.define<StageState, StageEvent>({
  name: "climb-stage",
  transitions: { pending: { complete: () => ({ kind: "done" }) }, done: {} },
});

function makeStage(opts: {
  clock: ReturnType<typeof createControlledClock>;
  runtime: HandlerRuntime;
  journalStore: ReturnType<typeof createMemoryJournalStore>;
  name: string;
  durationMs: number;
}) {
  const stateStore = createMemoryStateStore({ initial: { kind: "pending" } as StageState, clock: opts.clock });
  return defineDurableStep(
    stageMachine,
    {
      name: opts.name,
      eventType: "complete",
      toEvent: (): StageEvent => ({ type: "complete" }),
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      fields: observe.fields({}),
      timeout: ms(60 * 60_000),
      concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      spend: spend.none(),
      proof: {},
      run: async () => {
        opts.clock.advanceBy(ms(opts.durationMs));
        return { ok: true };
      },
    },
    {
      clock: opts.clock,
      stateStore,
      retryLedger: createRetryLedger(Number.POSITIVE_INFINITY),
      journalStore: opts.journalStore,
    },
  );
}

describe("round 5 — the invisible minute becomes a journaled number, not a prevention", () => {
  it("reproduces corpus item 3 exactly: a 35-minute climb with 10 minutes of declared stages journals 25 unaccounted minutes", async () => {
    const { clock, runtime, journal, journalStore } = setup();

    const clone = makeStage({ clock, runtime, journalStore, name: "clone", durationMs: 4 * 60_000 });
    const extract = makeStage({ clock, runtime, journalStore, name: "file-level-extraction", durationMs: 6 * 60_000 });

    const cloneHandler = await spawn(clone, runtime);
    const extractHandler = await spawn(extract, runtime);

    const climbResult = await runClimb("mycelium-run", { clock, journal, journalStore }, async () => {
      // The 25 invisible minutes: clone, extraction, queuing happen as
      // plain code BEFORE the first declared stage even starts — exactly
      // the corpus's own shape (04:13:15 climb start, 04:38:07 first
      // recorded stage). No step wraps this; nothing could have noticed
      // it under rounds 1-4 either.
      clock.advanceBy(ms(25 * 60_000));

      await cloneHandler.invoke({});
      await extractHandler.invoke({});

      await cloneHandler.stop();
      await extractHandler.stop();
      return { done: true };
    });

    expect(climbResult.totalMs).toBe(35 * 60_000);
    expect(climbResult.accountedMs).toBe(10 * 60_000); // clone (4) + extraction (6)
    expect(climbResult.unaccountedMs).toBe(25 * 60_000); // exactly corpus item 3's own number
    expect(climbResult.stepCount).toBe(2);

    const climbEntry = journal.getSnapshot().entries.find((e) => e.data.name === "climb.mycelium-run")!.data;
    expect(climbEntry.observed["unaccountedMs"]).toBe(25 * 60_000);
    expect(climbEntry.observed["accountedMs"]).toBe(10 * 60_000);
  });

  it("a climb built entirely from declared steps has zero unaccounted time — the good case, verified", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    const infer = makeStage({ clock, runtime, journalStore, name: "infer-standards", durationMs: 4 * 60_000 + 23_000 });
    const inferHandler = await spawn(infer, runtime);

    const climbResult = await runClimb("infer-standards-only", { clock, journal, journalStore }, async () => {
      await inferHandler.invoke({});
      await inferHandler.stop();
      return { done: true };
    });

    expect(climbResult.unaccountedMs).toBe(0);
    expect(climbResult.accountedMs).toBe(climbResult.totalMs);
  });

  it("honest limit: unaccountedMs names the SIZE of the gap, not what happened inside it", async () => {
    // This is the ceiling this round doesn't pretend to exceed: the climb
    // wrapper cannot say "a git clone and a file-level extraction ran
    // here" — only "25 minutes of this climb's time are not covered by
    // any declared step." That's real information (a real operator can
    // now alert on it, budget for it, or go decompose it into steps) but
    // it is not the same as having declared steps for that work.
    expect(true).toBe(true);
  });
});

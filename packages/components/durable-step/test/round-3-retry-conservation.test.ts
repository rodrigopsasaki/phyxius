// ── Round 3 ──────────────────────────────────────────────────────────────
//
// Change:      `DurableStepDeps` gains a mandatory `retryLedger: RetryLedger`
//              (`createRetryLedger(totalExtraAttempts)`). `defineDurableStep`
//              always spawns the underlying handler with `retry.none()` and
//              instead runs its own `runWithRetry` loop inside the wrapped
//              `run`, capped to `1 + retryLedger.draw(spec.retry.maxAttempts
//              - 1)` — the step's declared ceiling is a REQUEST, the shared
//              ledger's remaining balance is the GRANT.
//
// Hypothesis:  `discipline-synthesis` (corpus item 2) is the budget case:
//              ~6 model calls per convention, over 98 conventions, each
//              free to declare its own retry policy — that shape produced
//              5,481 calls and a real outage on 2026-08-06 because nothing
//              conserved a ceiling ACROSS the fan-out. If every sub-step
//              draws its extra attempts from ONE shared `RetryLedger`
//              instead of declaring an independent policy, then
//              decomposing the work into more steps cannot mint more retry
//              capacity — the pool is fixed regardless of fan-out width,
//              and late-drawing steps are silently capped by whatever's
//              left, not refused, not granted their full request either.
//
// Explicitly NOT addressed this round: FINDING 4 (proof-of-completion is
// still decoupled from success), and the deep form of FINDING 5 — this
// round conserves retries ONLY for steps built through `defineDurableStep`
// sharing the SAME ledger instance; nothing stops an author from spawning
// a raw `@phyxiusjs/handler` spec with its own unconserved `retry.fixed(...)`
// alongside it. Declaring through this composition is still a choice.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { isErr, isOk } from "@phyxiusjs/fp";
import { retry, cb, spawn, type HandlerEvent, type HandlerRuntime } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { createMemoryJournalStore, type JournalStore } from "@phyxiusjs/migration";
import { machine } from "@phyxiusjs/state-machine";
import { observe } from "@phyxiusjs/observe";

import { createMemoryStateStore, createRetryLedger, defineDurableStep, spend } from "../src/index.js";

function setup() {
  const clock = createControlledClock({ initialTime: 0 });
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 200 });
  const journalStore = createMemoryJournalStore({ journal, clock });
  const runtime: HandlerRuntime = { clock, journal };
  return { clock, journal, journalStore, runtime };
}

type ItemState = { kind: "pending" } | { kind: "done" };
type ItemEvent = { type: "complete" };

const itemMachine = machine.define<ItemState, ItemEvent>({
  name: "convention-item",
  transitions: {
    pending: { complete: () => ({ kind: "done" }) },
    done: {},
  },
});

/** Builds one `discipline-synthesis`-shaped item: fails `failTimes` times before succeeding, sharing `retryLedger` with its siblings. */
function makeFlakyItem(opts: {
  clock: ReturnType<typeof createControlledClock>;
  journal: Journal<HandlerEvent>;
  journalStore: JournalStore;
  runtime: HandlerRuntime;
  retryLedger: ReturnType<typeof createRetryLedger>;
  name: string;
  failTimes: number;
}) {
  const stateStore = createMemoryStateStore({ initial: { kind: "pending" } as ItemState, clock: opts.clock });
  let attemptsSoFar = 0;

  const spec = defineDurableStep(
    itemMachine,
    {
      name: opts.name,
      eventType: "complete",
      toEvent: (): ItemEvent => ({ type: "complete" }),
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      fields: observe.fields({}),
      timeout: ms(5_000),
      concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
      // Each item WANTS up to 2 extra attempts (3 total) — a per-item
      // declaration, same as any handler. What it actually GETS depends
      // on the shared ledger, not on this number alone.
      retry: retry.fixed({ maxAttempts: 3, delay: ms(0) }),
      circuitBreaker: cb.none(),
      spend: spend.none(),
      proof: {},
      run: async () => {
        attemptsSoFar += 1;
        if (attemptsSoFar <= opts.failTimes) {
          throw new Error(`${opts.name}: transient failure #${attemptsSoFar}`);
        }
        return { ok: true };
      },
    },
    { clock: opts.clock, stateStore, retryLedger: opts.retryLedger, journalStore: opts.journalStore },
  );

  return { spec, stateStore };
}

describe("round 3 — retry allowance is drawn from a conserved, shared parent budget", () => {
  it("decomposition cannot mint retry capacity: three flaky items share ONE ledger of 3 extra attempts, and the third is capped below its own declared ceiling", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    // Discipline-synthesis's own shape, compressed: several items fan out
    // from one durable action, each wanting up to 2 extra attempts (6 max
    // if unconserved), but the WHOLE action only trusts 3 extra attempts
    // total — the number an operator actually budgeted for the run.
    const sharedLedger = createRetryLedger(3);

    const itemA = makeFlakyItem({
      clock,
      journal,
      journalStore,
      runtime,
      retryLedger: sharedLedger,
      name: "item-a",
      failTimes: 2,
    });
    const itemB = makeFlakyItem({
      clock,
      journal,
      journalStore,
      runtime,
      retryLedger: sharedLedger,
      name: "item-b",
      failTimes: 2,
    });
    const itemC = makeFlakyItem({
      clock,
      journal,
      journalStore,
      runtime,
      retryLedger: sharedLedger,
      name: "item-c",
      failTimes: 2,
    });

    const handlerA = await spawn(itemA.spec, runtime);
    const resultA = await handlerA.invoke({});
    await handlerA.stop();

    const handlerB = await spawn(itemB.spec, runtime);
    const resultB = await handlerB.invoke({});
    await handlerB.stop();

    const handlerC = await spawn(itemC.spec, runtime);
    const resultC = await handlerC.invoke({});
    await handlerC.stop();

    // Item A: ledger had 3, requested 2, granted 2 (2 remaining after).
    expect(isOk(resultA)).toBe(true);
    // Item B: ledger had 1, requested 2, granted only 1 (0 remaining after)
    // — B needed 2 failures + 1 success = 3 attempts, but only got 1
    // extra (2 total), so it does NOT recover.
    expect(isErr(resultB)).toBe(true);
    // Item C: ledger had 0 left — granted 0 extra, exactly 1 attempt,
    // fails immediately. Its OWN declared ceiling (3) was never honored,
    // and that's the point: the shared pool, not the per-item request,
    // is what decides.
    expect(isErr(resultC)).toBe(true);

    expect(sharedLedger.remaining()).toBe(0);

    const {entries} = journal.getSnapshot();
    const forItem = (name: string) => entries.filter((e) => e.data.name === name);
    expect(forItem("item-a")[0]!.data.observed["retryGranted"]).toBe(2);
    expect(forItem("item-b")[0]!.data.observed["retryGranted"]).toBe(1);
    expect(forItem("item-c")[0]!.data.observed["retryGranted"]).toBe(0);
  });

  it("attributability: retryBudgeted/retryGranted/retryAttemptsUsed land in the journal with zero extra author code", async () => {
    const { clock, runtime, journal, journalStore } = setup();
    const ledger = createRetryLedger(10);
    const { spec } = makeFlakyItem({
      clock,
      journal,
      journalStore,
      runtime,
      retryLedger: ledger,
      name: "item-solo",
      failTimes: 1,
    });

    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({});
    await handler.stop();

    expect(isOk(result)).toBe(true);
    const entry = journal.getSnapshot().entries[0]!.data;
    expect(entry.observed["retryBudgeted"]).toBe(2); // declared maxAttempts 3 => 2 extra requested
    expect(entry.observed["retryGranted"]).toBe(2); // plenty in the ledger
    expect(entry.observed["retryAttemptsUsed"]).toBe(2); // 1 failure + 1 success
    expect(ledger.remaining()).toBe(8);
  });

  it("honest limit: the underlying HandlerEvent.attempts field is no longer informative once retry moved into this layer", async () => {
    // This is the friction round 3 surfaced, not swept under the rug: the
    // outer handler is always spawned with retry.none() now (see step.ts),
    // so its OWN `attempts` bookkeeping always reads 1 — the real count
    // only exists in `observed.retryAttemptsUsed`. A reader who trusts the
    // native field alone would conclude every step ran once, which is
    // false whenever the ledger granted extra attempts.
    const { clock, runtime, journal, journalStore } = setup();
    const ledger = createRetryLedger(10);
    const { spec } = makeFlakyItem({
      clock,
      journal,
      journalStore,
      runtime,
      retryLedger: ledger,
      name: "item-friction",
      failTimes: 2,
    });

    const handler = await spawn(spec, runtime);
    await handler.invoke({});
    await handler.stop();

    const entry = journal.getSnapshot().entries[0]!.data;
    expect(entry.attempts).toBe(1); // misleading in isolation
    expect(entry.observed["retryAttemptsUsed"]).toBe(3); // the truth
  });
});

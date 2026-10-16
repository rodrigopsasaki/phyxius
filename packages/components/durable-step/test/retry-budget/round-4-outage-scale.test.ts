// ── Round 4 (retry-budget find-shape) ───────────────────────────────────
//
// Change:      `runClimb` now owns the conserved retry budget's
//              declaration (`operationId` + `deps.ledgerStore` +
//              `deps.retryBudget`, idempotent, refused on disagreement —
//              see `climb.ts`). No new conservation mechanism — this round
//              wires rounds 1-3's mechanism into the actual entry point a
//              real durable action would call, and exercises it at the
//              corpus's own scale instead of 3-item toy examples.
//
// Hypothesis:  Corpus item 2 is `discipline-synthesis`: ~6 model calls per
//              convention over ~98 conventions is healthy (~588 total,
//              generously); the 2026-08-06 outage ran ~274 calls per
//              convention (~5,481 total) because nothing conserved a
//              ceiling ACROSS the fan-out — each item's own retry policy
//              multiplied independently. If every item, no matter how many
//              there are, draws its extra attempts from ONE climb-owned
//              ledger, then even the ABSOLUTE WORST CASE — every single
//              item persistently flaky, each demanding its full declared
//              ceiling — cannot exceed
//              `itemCount + retryBudget` total attempts. The runaway
//              becomes UNREACHABLE, not merely detectable after the fact:
//              this test constructs exactly that worst case on purpose and
//              asserts the hard ceiling holds.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { isErr } from "@phyxiusjs/fp";
import { retry, cb, spawn, type HandlerEvent, type HandlerRuntime } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { createMemoryJournalStore } from "@phyxiusjs/migration";
import { machine } from "@phyxiusjs/state-machine";
import { observe } from "@phyxiusjs/observe";

import {
  createMemoryLedgerStore,
  createMemoryStateStore,
  defineDurableStep,
  runClimb,
  spend,
  type DurableRetryLedger,
} from "../../src/index.js";

type ItemState = { kind: "pending" } | { kind: "done" };
type ItemEvent = { type: "complete" };

const itemMachine = machine.define<ItemState, ItemEvent>({
  name: "convention-item",
  transitions: { pending: { complete: () => ({ kind: "done" }) }, done: {} },
});

function makeConventionItem(opts: {
  clock: ReturnType<typeof createControlledClock>;
  journalStore: ReturnType<typeof createMemoryJournalStore>;
  retryLedger: DurableRetryLedger;
  name: string;
  alwaysFails: boolean;
}) {
  const stateStore = createMemoryStateStore({ initial: { kind: "pending" } as ItemState, clock: opts.clock });
  let attemptCount = 0;

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
      // Every item is free to WANT up to 5 extra attempts (6 total, the
      // corpus's own "healthy ~6 calls" figure) — what it actually gets
      // is decided by the shared budget, not this declaration.
      retry: retry.fixed({ maxAttempts: 6, delay: ms(0) }),
      circuitBreaker: cb.none(),
      spend: spend.none(),
      proof: {},
      run: async () => {
        attemptCount += 1;
        if (opts.alwaysFails) {
          // The absolute worst case: this item NEVER succeeds, so it
          // consumes every single attempt the ledger is willing to grant
          // it — exactly the shape that turns a fan-out into a runaway
          // when nothing conserves a ceiling across items.
          throw new Error(`${opts.name}: persistently flaky, attempt #${attemptCount}`);
        }
        return { ok: true };
      },
    },
    { clock: opts.clock, stateStore, retryLedger: opts.retryLedger, journalStore: opts.journalStore },
  );

  return { spec, attemptsMade: () => attemptCount };
}

describe("round 4 — the conserved budget makes the discipline-synthesis runaway unreachable, at scale", () => {
  it("[corpus item 2, worst case] 98 items, ALL persistently flaky, share one climb-owned budget — total attempts hard-capped at itemCount + retryBudget, not itemCount * maxAttempts", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const journal = new Journal<HandlerEvent>({ clock, maxEntries: 2_000 });
    const journalStore = createMemoryJournalStore({ journal, clock });
    const runtime: HandlerRuntime = { clock, journal };

    const ITEM_COUNT = 98;
    const RETRY_BUDGET = 50; // the operator's actual budget for this run — far below the unconserved worst case

    const climbResult = await runClimb(
      "discipline-synthesis",
      "op-discipline-synthesis-2026-08-06-shape",
      { clock, journal, journalStore, ledgerStore: createMemoryLedgerStore(), retryBudget: RETRY_BUDGET },
      async ({ retryLedger }) => {
        const items = Array.from({ length: ITEM_COUNT }, (_, i) =>
          makeConventionItem({
            clock,
            journalStore,
            retryLedger, // every item draws from the SAME climb-owned pool
            name: `convention-${i}`,
            alwaysFails: true, // the worst case, on purpose
          }),
        );

        let failureCount = 0;
        for (const item of items) {
          const handler = await spawn(item.spec, runtime);
          const result = await handler.invoke({});
          await handler.stop();
          if (isErr(result)) failureCount += 1;
        }

        const totalAttempts = items.reduce((sum, item) => sum + item.attemptsMade(), 0);
        return { failureCount, totalAttempts };
      },
    );

    const { failureCount, totalAttempts } = climbResult.output;

    // Every item failed — that's honest given `alwaysFails: true`, not a
    // bug this test papers over. What matters is HOW MANY CALLS it took to
    // discover that, which is exactly what the outage was about.
    expect(failureCount).toBe(ITEM_COUNT);

    // THE hard ceiling: itemCount guaranteed first tries + the ENTIRE
    // conserved budget, and not one call more — regardless of how flaky
    // any item is, regardless of fan-out width. This is what "unreachable"
    // means: not a number we happened to observe, but the maximum the
    // mechanism can structurally produce.
    const hardCeiling = ITEM_COUNT + RETRY_BUDGET;
    expect(totalAttempts).toBeLessThanOrEqual(hardCeiling);
    expect(totalAttempts).toBe(hardCeiling); // the worst case actually reaches it — the budget wasn't left unused, it was fully and exactly spent

    // The comparison the corpus frames this whole item around: healthy is
    // ~6 calls/convention (~588 for 98, generously, if every item used its
    // full declared ceiling unconserved); the outage was ~274/convention
    // (~5,481 total actual). This run's worst case:
    const callsPerConvention = totalAttempts / ITEM_COUNT;
    expect(callsPerConvention).toBeLessThan(2); // 148 / 98 ≈ 1.51
    expect(totalAttempts).toBeLessThan(5_481 / 30); // not merely "less than the outage" — an order of magnitude below it
  });

  it("[healthy case, for contrast] the same 98 items, mostly well-behaved, spend nowhere near the full budget — conservation doesn't punish the common case", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const journal = new Journal<HandlerEvent>({ clock, maxEntries: 2_000 });
    const journalStore = createMemoryJournalStore({ journal, clock });
    const runtime: HandlerRuntime = { clock, journal };

    const ITEM_COUNT = 98;
    const RETRY_BUDGET = 50;

    const climbResult = await runClimb(
      "discipline-synthesis-healthy",
      "op-discipline-synthesis-healthy-run",
      { clock, journal, journalStore, ledgerStore: createMemoryLedgerStore(), retryBudget: RETRY_BUDGET },
      async ({ retryLedger }) => {
        const items = Array.from({ length: ITEM_COUNT }, (_, i) =>
          makeConventionItem({
            clock,
            journalStore,
            retryLedger,
            name: `convention-${i}`,
            alwaysFails: false, // succeeds on the first, guaranteed attempt
          }),
        );

        let successCount = 0;
        for (const item of items) {
          const handler = await spawn(item.spec, runtime);
          const result = await handler.invoke({});
          await handler.stop();
          if (!isErr(result)) successCount += 1;
        }

        const totalAttempts = items.reduce((sum, item) => sum + item.attemptsMade(), 0);
        return { successCount, totalAttempts };
      },
    );

    expect(climbResult.output.successCount).toBe(ITEM_COUNT);
    // Nobody was flaky, so nobody drew from the shared pool at all —
    // conservation is dormant machinery in the common case, not an
    // overhead the healthy path pays for.
    expect(climbResult.output.totalAttempts).toBe(ITEM_COUNT); // exactly 1 call each
  });
});

// ── Round 1 (retry-budget find-shape) ───────────────────────────────────
//
// Change:      `RetryLedger` (sync, closure-backed) replaced by
//              `DurableRetryLedger` (async) + `LedgerStore`, shaped after
//              `StateStore`/`PhaseStore`'s own async-CAS-keyed-by-identity
//              contract instead of inventing a new one. The client is now a
//              thin, disposable pair — `(store, operationId)` — reconstructed
//              wherever it's needed rather than threaded by object
//              reference. `initialize()` is idempotent when re-declaring
//              the SAME budget (the revival case) and refused when a
//              second declaration disagrees with the first (round 0's
//              mint-by-mistake case).
//
// Hypothesis:  If the ledger's balance lives in a store keyed by
//              operationId instead of in the client object's own closure,
//              then (a) conservation for corpus item 1 (flat siblings)
//              survives unchanged, (b) an operation nobody declared a
//              budget for is a distinguishable, refused `unknown` state —
//              never silently 0 or unlimited, (c) a SECOND declaration for
//              the same operationId with a DIFFERENT number is refused
//              (closing round 0's headroom probe #2 structurally), and (d)
//              a SECOND declaration with the SAME number is a safe no-op
//              (so a climb that legitimately re-runs its own start-of-climb
//              code after a crash doesn't reset attempts already spent).
//              None of this yet proves the process-hop case (round 0's
//              headroom probe #3) — that needs a store that is actually
//              durable across a real process boundary, not merely
//              async-shaped. This round only proves the SHAPE is now
//              capable of it; round 2 proves it for real.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { isErr, isOk } from "@phyxiusjs/fp";
import { retry, cb, spawn, type HandlerEvent, type HandlerRuntime } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { createMemoryJournalStore, type JournalStore } from "@phyxiusjs/migration";
import { machine } from "@phyxiusjs/state-machine";
import { observe } from "@phyxiusjs/observe";

import {
  createDurableRetryLedger,
  createMemoryLedgerStore,
  createMemoryStateStore,
  defineDurableStep,
  isStepRefusal,
  spend,
  type DurableRetryLedger,
  type LedgerStore,
} from "../../src/index.js";

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
  transitions: { pending: { complete: () => ({ kind: "done" }) }, done: {} },
});

function makeFlakyItem(opts: {
  clock: ReturnType<typeof createControlledClock>;
  journalStore: JournalStore;
  retryLedger: DurableRetryLedger;
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

describe("round 1 — a durable, operation-keyed ledger replaces the closure-backed one", () => {
  it("[item 1 regression] flat siblings sharing one operationId still conserve capacity, identically to round 0", async () => {
    const { clock, journal, journalStore } = setup();
    const store = createMemoryLedgerStore();
    await store.initialize("op-siblings", 3);

    const a = makeFlakyItem({
      clock,
      journalStore,
      retryLedger: createDurableRetryLedger(store, "op-siblings"),
      name: "item-a",
      failTimes: 2,
    });
    const b = makeFlakyItem({
      clock,
      journalStore,
      retryLedger: createDurableRetryLedger(store, "op-siblings"),
      name: "item-b",
      failTimes: 2,
    });
    const c = makeFlakyItem({
      clock,
      journalStore,
      retryLedger: createDurableRetryLedger(store, "op-siblings"),
      name: "item-c",
      failTimes: 2,
    });

    const runtime: HandlerRuntime = { clock, journal };
    const ha = await spawn(a.spec, runtime);
    const ra = await ha.invoke({});
    await ha.stop();
    const hb = await spawn(b.spec, runtime);
    const rb = await hb.invoke({});
    await hb.stop();
    const hc = await spawn(c.spec, runtime);
    const rc = await hc.invoke({});
    await hc.stop();

    expect(isOk(ra)).toBe(true);
    expect(isErr(rb)).toBe(true);
    expect(isErr(rc)).toBe(true);

    const record = await store.get("op-siblings");
    expect(record?.drawn).toBe(3);

    // Note: each sibling above constructed its OWN client
    // (`createDurableRetryLedger(store, "op-siblings")`) rather than
    // sharing one object reference — proving the object itself carries no
    // state that matters. Round 0's mechanism required the SAME reference;
    // this one only requires the SAME (store, operationId) pair.
  });

  it("[unknown vs unlimited, half 1] drawing against a never-initialized operation refuses the step — not 0 attempts, not unlimited", async () => {
    const { clock, journal, journalStore } = setup();
    const store = createMemoryLedgerStore();
    // Deliberately never initialized.
    const ledger = createDurableRetryLedger(store, "op-never-declared");

    const stateStore = createMemoryStateStore({ initial: { kind: "pending" } as ItemState, clock });
    const spec = defineDurableStep(
      itemMachine,
      {
        name: "undeclared-op-item",
        eventType: "complete",
        toEvent: (): ItemEvent => ({ type: "complete" }),
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        fields: observe.fields({}),
        timeout: ms(5_000),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.fixed({ maxAttempts: 3, delay: ms(0) }),
        circuitBreaker: cb.none(),
        spend: spend.none(),
        proof: {},
        run: async () => ({ ok: true }), // would succeed on the FIRST try if ever reached
      },
      { clock, stateStore, retryLedger: ledger, journalStore },
    );

    const runtime: HandlerRuntime = { clock, journal };
    const handler = await spawn(spec, runtime);
    const result = await handler.invoke({});
    await handler.stop();

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.type === "HANDLER_ERROR" && isStepRefusal(result.error.cause)) {
      expect(result.error.cause.refusal).toEqual({ type: "LEDGER_NOT_INITIALIZED", operationId: "op-never-declared" });
    } else {
      throw new Error("expected a LEDGER_NOT_INITIALIZED StepRefusal");
    }

    await expect(ledger.remaining()).resolves.toBe("unknown");
  });

  it("[unknown vs unlimited, half 2] Number.POSITIVE_INFINITY is still the explicit, auditable unlimited declaration — now durable", async () => {
    const store = createMemoryLedgerStore();
    await store.initialize("op-unlimited", Number.POSITIVE_INFINITY);
    const ledger = createDurableRetryLedger(store, "op-unlimited");

    expect(await ledger.draw(1_000_000)).toBe(1_000_000);
    await expect(ledger.remaining()).resolves.toBe(Number.POSITIVE_INFINITY);
  });

  it("[closes round 0 headroom probe #2] a second declaration for the SAME operationId with a DIFFERENT budget is refused, not silently granted", async () => {
    const store: LedgerStore = createMemoryLedgerStore();
    const first = await store.initialize("op-shared-climb", 3);
    expect(isOk(first)).toBe(true);

    // The exact shape of round 0's mistake: a nested child, written without
    // visibility into what its ancestor already declared, tries to stand
    // up its own budget under the SAME operation identity. Unlike round 0
    // (where this was a silent, undetectable second pool), the durable
    // store has a record to compare against.
    const second = await store.initialize("op-shared-climb", 5);
    expect(isErr(second)).toBe(true);
    if (isErr(second)) {
      expect(second.error.type).toBe("ALREADY_INITIALIZED_WITH_DIFFERENT_BUDGET");
      expect(second.error.existing.totalExtraAttempts).toBe(3);
    }

    // And the budget genuinely wasn't touched by the refused attempt.
    const record = await store.get("op-shared-climb");
    expect(record?.totalExtraAttempts).toBe(3);
  });

  it("revival is safe: re-initializing with the SAME budget after attempts were already drawn is an idempotent no-op, not a reset", async () => {
    const store = createMemoryLedgerStore();
    await store.initialize("op-revived-climb", 5);
    const ledgerBeforeCrash = createDurableRetryLedger(store, "op-revived-climb");
    expect(await ledgerBeforeCrash.draw(2)).toBe(2); // 3 remain

    // Simulate a crash: the process holding `ledgerBeforeCrash` is gone.
    // A "different worker" resumes the climb and re-runs its own
    // start-of-climb code, which re-declares the SAME budget it always
    // declares — this must not look like round 0 headroom probe #2's
    // mistake, and it must not reset what's already been spent.
    const reinit = await store.initialize("op-revived-climb", 5);
    expect(isOk(reinit)).toBe(true);

    const ledgerAfterRevival = createDurableRetryLedger(store, "op-revived-climb");
    await expect(ledgerAfterRevival.remaining()).resolves.toBe(3); // NOT reset to 5
  });

  it("[handle, not object] a client reconstructed from nothing but the (store, operationId) pair sees the true, current balance", async () => {
    const store = createMemoryLedgerStore();
    await store.initialize("op-nested-call", 5);

    const clientAtParentFrame = createDurableRetryLedger(store, "op-nested-call");
    expect(await clientAtParentFrame.draw(2)).toBe(2);

    // A "nested child," one ordinary function call deeper, is handed only
    // the operationId string (not `clientAtParentFrame` itself — proving
    // the object reference was never what mattered) and reconstructs its
    // own client fresh.
    function nestedChildFrame(sameStore: LedgerStore, operationId: string): DurableRetryLedger {
      return createDurableRetryLedger(sameStore, operationId);
    }
    const clientAtChildFrame = nestedChildFrame(store, "op-nested-call");

    await expect(clientAtChildFrame.remaining()).resolves.toBe(3); // sees what the parent already drew
    expect(await clientAtChildFrame.draw(3)).toBe(3); // draws the true remainder, not a fresh 5
    await expect(clientAtParentFrame.remaining()).resolves.toBe(0); // the parent's OWN client sees the child's draw too
  });
});

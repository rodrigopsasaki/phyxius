import { elapsedSince, ms, type Clock, type Millis } from "@phyxiusjs/clock";
import type { HandlerEvent } from "@phyxiusjs/handler";
import type { Journal } from "@phyxiusjs/journal";
import type { JournalStore } from "@phyxiusjs/migration";

import { createDurableRetryLedger, type DurableRetryLedger } from "./retry-ledger.js";
import type { LedgerStore } from "./ledger-store.js";

// ── runClimb — making the invisible minute a NUMBER, not a prevention ──────
//
// Round 0's FINDING 5 (the hardest case, corpus item 3): work between two
// declared steps is invisible by construction — nothing notices it, let
// alone forbids it. Rounds 1-4 make every DECLARED step fully attributable
// across all four fitness axes. None of them can force declaration itself
// — that's not a composition an API can enforce; a bare `await` between two
// `handler.invoke()` calls is just JavaScript, and no type signature stops
// someone from writing one.
//
// `runClimb` doesn't try. Instead it turns the gap from an unknown-unknown
// into a known-unknown: it measures the WHOLE durable action's wall time,
// sums what every declared step inside that window actually accounted for
// (by querying the SAME `JournalStore` `spec.proof` already reads from —
// no new mechanism, just a different window), and journals the delta as
// `unaccountedMs`. A climb that is 35 minutes long with 10 minutes of
// declared steps now says so, explicitly, in one journaled number — instead
// of saying nothing at all.
//
// This is honestly partial. The MINUTE is now attributable; the WORK inside
// it still isn't — `runClimb` can name that 25 minutes are unaccounted for,
// not what happened during them. See the find-shape doc's closing synthesis
// for why that's the honest stopping point, not a gap this round hides.

export interface ClimbResult<T> {
  readonly output: T;
  readonly totalMs: Millis;
  readonly accountedMs: number;
  readonly unaccountedMs: number;
  readonly stepCount: number;
}

/**
 * Thrown when a climb's OWN declared `retryBudget` disagrees with what's
 * already durably recorded for `operationId` — e.g. a redeploy changed the
 * configured budget for a climb that's still mid-flight, or an operationId
 * collided with an unrelated climb. Never silently honored either number;
 * see `LedgerStore.initialize`'s own doc comment for why a disagreement is
 * refused rather than resolved by picking one side.
 */
export class ClimbBudgetMismatchError extends Error {
  readonly operationId: string;
  readonly declared: number;
  readonly recorded: number;

  constructor(operationId: string, declared: number, recorded: number) {
    super(
      `climb "${operationId}" declared a retryBudget of ${declared}, but ${recorded} is already durably recorded — refusing to silently pick one`,
    );
    this.name = "ClimbBudgetMismatchError";
    this.operationId = operationId;
    this.declared = declared;
    this.recorded = recorded;
  }
}

/**
 * Materialize a whole durable action AND own its conserved retry budget in
 * one place — the operation boundary the algebra names as where retry
 * authority belongs. `operationId` is the climb's durable identity: a
 * plain string, cheap to carry on a context scope or a queue message
 * across a real process hop (see `DurableRetryLedger`'s own doc comment),
 * unlike the budget's balance, which lives durably in `deps.ledgerStore`
 * keyed by that same id. `deps.retryBudget` is declared once per climb —
 * `Number.POSITIVE_INFINITY` is the explicit "not conserved" value, never
 * a default — and idempotently re-declaring it (a revived climb re-running
 * its own start-of-climb code) is a safe no-op; declaring a DIFFERENT
 * number for an operationId that's already recorded is refused
 * (`ClimbBudgetMismatchError`), the structural fix for a nested step
 * minting its own pool under the same identity.
 *
 * `fn` receives the constructed `retryLedger` so it can thread it (or just
 * `operationId`, reconstructing a fresh client wherever it's needed — see
 * round 1's "handle, not object" test) down to every nested
 * `defineDurableStep` call, no matter how deep.
 */
export async function runClimb<T>(
  name: string,
  operationId: string,
  deps: {
    readonly clock: Clock;
    readonly journal: Journal<HandlerEvent>;
    readonly journalStore: JournalStore;
    readonly ledgerStore: LedgerStore;
    readonly retryBudget: number;
  },
  fn: (tools: { readonly retryLedger: DurableRetryLedger }) => Promise<T>,
): Promise<ClimbResult<T>> {
  const initialized = await deps.ledgerStore.initialize(operationId, deps.retryBudget);
  if (initialized._tag === "Err") {
    throw new ClimbBudgetMismatchError(operationId, deps.retryBudget, initialized.error.existing.totalExtraAttempts);
  }
  const retryLedger = createDurableRetryLedger(deps.ledgerStore, operationId);

  const startedAt = deps.clock.now();
  const output = await fn({ retryLedger });
  const completedAt = deps.clock.now();
  const totalMs = elapsedSince(completedAt.monoMs, startedAt.monoMs);

  // Every step journaled by `defineDurableStep` (or any handler at all)
  // whose window falls inside this climb's span. `windowMs` only needs to
  // be at least `totalMs` — the `where` predicate does the real isolation.
  const events = await deps.journalStore.query(
    {
      where: (e) => e.startedAt.wallMs >= startedAt.wallMs && e.completedAt.wallMs <= completedAt.wallMs,
    },
    ms(totalMs + 1),
  );

  const accountedMs = events.reduce((sum, e) => sum + e.durationMs, 0);
  const unaccountedMs = Math.max(0, totalMs - accountedMs);

  const event: HandlerEvent = {
    name: `climb.${name}`,
    invocationId: `climb-${name}-${completedAt.monoMs.toString(36)}`,
    source: "climb",
    startedAt,
    completedAt,
    durationMs: totalMs,
    attempts: 1,
    outcome: "success",
    observed: { stepCount: events.length, accountedMs, unaccountedMs },
  };
  deps.journal.append(event);

  return { output, totalMs, accountedMs, unaccountedMs, stepCount: events.length };
}

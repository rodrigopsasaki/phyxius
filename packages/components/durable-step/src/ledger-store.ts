import { err, ok, type Result } from "@phyxiusjs/fp";

// ── LedgerStore — the durable write side of a conserved retry budget ───────
//
// `StateStore` and `@phyxiusjs/migration`'s `PhaseStore` are both already
// shaped for this: async, CAS, keyed by an identity that survives past any
// one process. The original `RetryLedger` (round 3 of the prior find-shape)
// was NOT — `draw(want): number`, synchronous, backed by nothing but a
// closure variable. A synchronous return type structurally cannot ever be
// backed by a real durable store (a network round-trip cannot resolve
// synchronously), which is the actual reason "how do I propagate this
// across a process hop" had no answer: the interface itself foreclosed one.
//
// `LedgerStore` fixes the shape-fit, not just the symptom: same async-CAS
// contract as `StateStore`/`PhaseStore`, keyed by `operationId` — the
// climb's own durable identity — instead of an object reference. A step
// resumed by a different worker doesn't need "the same ledger object"; it
// needs the SAME `operationId` string (cheap, serializable, exactly the
// kind of thing a context scope or a queue message CAN carry across a
// process hop) plus a client bound to whatever store this deployment uses.

export interface LedgerRecord {
  readonly operationId: string;
  /** The conserved budget declared for this operation. `Number.POSITIVE_INFINITY` is the explicit "not conserved" declaration — never a default. */
  readonly totalExtraAttempts: number;
  /** Extra attempts granted so far, across every step — anywhere in the tree — that has drawn from this operation. */
  readonly drawn: number;
}

export type LedgerInitializeError = {
  /**
   * A record for this `operationId` already exists with a DIFFERENT
   * declared budget. This is the structural fix for round 0's headroom
   * probe (item 2): a nested step that reaches for its own fresh
   * declaration instead of the one its ancestor already made is refused,
   * not silently granted a second pool. A second `initialize` call with
   * the SAME budget is treated as an idempotent replay (see
   * `createMemoryLedgerStore`) — that's the revival case, not the mistake
   * case, and the two must not be confused.
   */
  readonly type: "ALREADY_INITIALIZED_WITH_DIFFERENT_BUDGET";
  readonly existing: LedgerRecord;
};

export type LedgerDrawError = {
  /**
   * No step has ever declared a budget for this `operationId` on this
   * store. This is the `unknown` state the fitness question names
   * directly — it must never be silently read as 0 (which would strand a
   * legitimately-budgeted operation behind a store that just hasn't
   * caught up) or as unlimited (which mints exactly the capacity this
   * whole mechanism exists to prevent). The only legal response is to
   * refuse and say so.
   */
  readonly type: "NOT_INITIALIZED";
  readonly operationId: string;
};

export interface LedgerStore {
  /** The current record, or `undefined` if this operationId has never been initialized — the durable read side of the `unknown` state. */
  get(operationId: string): Promise<LedgerRecord | undefined>;

  /**
   * Durably declare `operationId`'s conserved budget, exactly once. A
   * second call with the SAME `totalExtraAttempts` is an idempotent
   * no-op (the record, unchanged — `drawn` is NOT reset) — this is what
   * lets a revived climb safely re-run its own start-of-climb
   * declaration without resetting attempts already spent. A second call
   * with a DIFFERENT `totalExtraAttempts` is refused
   * (`ALREADY_INITIALIZED_WITH_DIFFERENT_BUDGET`).
   */
  initialize(operationId: string, totalExtraAttempts: number): Promise<Result<LedgerRecord, LedgerInitializeError>>;

  /**
   * Atomically reserve up to `want` extra attempts against `operationId`'s
   * conserved pool. `0 <= granted <= min(want, remaining)` — an exhausted
   * ledger grants 0 rather than refusing; that is a normal operating
   * state (see `RetryLedger`'s own prior doc comment). `NOT_INITIALIZED`
   * is the only refusal, and only when the operation has no record at all.
   */
  draw(
    operationId: string,
    want: number,
  ): Promise<Result<{ readonly granted: number; readonly remaining: number }, LedgerDrawError>>;
}

/**
 * In-process `LedgerStore`, backed by a plain `Map`. Safe under concurrent
 * callers for the same reason `createMemoryStateStore` is: JavaScript is
 * single-threaded and neither `initialize` nor `draw` awaits between its
 * read and its write. Sufficient for single-container deployments and
 * tests — fleet deployments swap this for a durably-backed implementation
 * (Postgres row-level CAS, same horizon PHYXIUS_CODEX already names for
 * `StateStore`/`PhaseStore`), never built here.
 */
export function createMemoryLedgerStore(): LedgerStore {
  const records = new Map<string, LedgerRecord>();

  return {
    async get(operationId) {
      return records.get(operationId);
    },

    async initialize(operationId, totalExtraAttempts) {
      const existing = records.get(operationId);
      if (existing) {
        if (existing.totalExtraAttempts === totalExtraAttempts) {
          return ok(existing);
        }
        return err({ type: "ALREADY_INITIALIZED_WITH_DIFFERENT_BUDGET", existing });
      }
      const record: LedgerRecord = { operationId, totalExtraAttempts, drawn: 0 };
      records.set(operationId, record);
      return ok(record);
    },

    async draw(operationId, want) {
      const existing = records.get(operationId);
      if (!existing) {
        return err({ type: "NOT_INITIALIZED", operationId });
      }
      const remainingBefore = existing.totalExtraAttempts - existing.drawn;
      if (want <= 0) {
        return ok({ granted: 0, remaining: remainingBefore });
      }
      const granted = Math.min(want, remainingBefore);
      records.set(operationId, { ...existing, drawn: existing.drawn + granted });
      return ok({ granted, remaining: remainingBefore - granted });
    },
  };
}

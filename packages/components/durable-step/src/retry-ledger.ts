import { isErr } from "@phyxiusjs/fp";

import type { LedgerStore } from "./ledger-store.js";

// ── DurableRetryLedger — a conserved retry budget, revival-safe ────────────
//
// The `discipline-synthesis` corpus item's own shape: ~6 model calls per
// convention, over 98 conventions, each with its OWN internal retry policy
// declared independently — nothing conserved a ceiling across them, and on
// 2026-08-06 that produced 5,481 calls and a real multi-tenant outage.
//
// This is the durable successor to the prior find-shape's `RetryLedger`:
// same conserved-pool idea, reshaped so the balance lives in a
// `LedgerStore` keyed by `operationId` instead of a closure variable. A
// `DurableRetryLedger` is now a thin, DISPOSABLE client — cheap to
// reconstruct identically in a different process, because reconstructing
// it needs only two things a revived worker can always be handed: the
// `operationId` (a plain string — the kind of thing a context scope or a
// queue message CAN carry across a process hop) and a connection to
// whatever store backs this deployment. The state itself never lives on
// this object.

export interface DurableRetryLedger {
  readonly operationId: string;

  /**
   * The known remaining balance, or the literal string `"unknown"` if this
   * operation has never been initialized on the backing store. `"unknown"`
   * is a distinct return value on purpose — a caller that treats it as `0`
   * (deny) or as unlimited (mint) has made a choice this API refuses to
   * make for it.
   */
  remaining(): Promise<number | "unknown">;

  /**
   * Atomically reserve up to `want` extra attempts from the durable,
   * operation-keyed pool. Returns what was actually granted —
   * `0 <= granted <= want` — same "exhaustion is a normal state, not a
   * fault" posture the in-memory predecessor had. Throws
   * `LedgerNotInitializedError` if `operationId` has no record at all:
   * unlike exhaustion (a legitimate 0), an uninitialized ledger is the
   * `unknown` state, and `unknown` must never be silently coerced into a
   * grantable number.
   */
  draw(want: number): Promise<number>;
}

/** Thrown by `draw()` when `operationId` was never `initialize()`d on the backing store — see the doc comment above. */
export class LedgerNotInitializedError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(
      `retry ledger for operation "${operationId}" was never initialized — refusing to guess between "0 remaining" and "unlimited"`,
    );
    this.name = "LedgerNotInitializedError";
    this.operationId = operationId;
  }
}

/**
 * Bind a `LedgerStore` + `operationId` into the small client interface
 * `defineDurableStep` calls. Construct this wherever a step needs it —
 * at the top of a climb, inside a nested child's own function frame, or
 * freshly in a different process resuming the same operation — the
 * result is identical as long as `operationId` and the store agree,
 * because neither carries any state of its own.
 */
export function createDurableRetryLedger(store: LedgerStore, operationId: string): DurableRetryLedger {
  return {
    operationId,

    async remaining() {
      const record = await store.get(operationId);
      if (!record) return "unknown";
      return record.totalExtraAttempts - record.drawn;
    },

    async draw(want: number): Promise<number> {
      const result = await store.draw(operationId, want);
      if (isErr(result)) {
        throw new LedgerNotInitializedError(operationId);
      }
      return result.value.granted;
    },
  };
}

// ── RetryLedger — a conserved retry budget, shared across nested steps ──────
//
// The `discipline-synthesis` corpus item's own shape: ~6 model calls per
// convention, over 98 conventions, each with its OWN internal retry policy
// declared independently — nothing conserved a ceiling across them, and on
// 2026-08-06 that produced 5,481 calls and a real multi-tenant outage.
//
// A `RetryLedger` is the structural fix: one shared, atomically-debited
// pool of "extra" attempts (beyond each step's guaranteed first try) that
// every step drawing from the SAME ledger competes for. Decomposing one
// durable action into more steps cannot mint more retry capacity — there's
// exactly one pool, and `draw()` never grants more than what's left in it.

export interface RetryLedger {
  /** Attempts remaining in this conserved budget, across every step drawing from it. */
  remaining(): number;

  /**
   * Atomically reserve up to `want` extra attempts. Returns what was
   * actually granted — `0 <= granted <= min(want, remaining before the
   * call)`. Never throws, never blocks: an exhausted ledger degrades a
   * step to its guaranteed single attempt rather than refusing outright —
   * "no more retries available" is a normal operating state, not a fault.
   */
  draw(want: number): number;
}

/**
 * In-process `RetryLedger`, backed by a plain variable. JavaScript's
 * single-threaded execution + no `await` between the read and the write
 * inside `draw()` is what makes this atomic — the same reasoning
 * `createMemoryStateStore` and `@phyxiusjs/migration`'s
 * `createMemoryPhaseStore` rely on for their own CAS.
 *
 * `createRetryLedger(Number.POSITIVE_INFINITY)` is the explicit "this
 * step's retries are NOT conserved against anything" declaration — the
 * `retry.none()` / `cb.none()` pattern applied to conservation itself:
 * unconserved is a value you write, not a default you fall into.
 */
export function createRetryLedger(totalExtraAttempts: number): RetryLedger {
  let remaining = totalExtraAttempts;

  return {
    remaining: () => remaining,
    draw(want: number): number {
      if (want <= 0) return 0;
      const granted = Math.min(want, remaining);
      remaining -= granted;
      return granted;
    },
  };
}

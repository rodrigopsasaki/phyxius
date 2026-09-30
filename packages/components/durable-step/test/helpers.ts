import { createDurableRetryLedger, createMemoryLedgerStore, type DurableRetryLedger } from "../src/index.js";

/**
 * Test-only convenience for the common "this step's retries aren't
 * conserved against anything" case — every call site gets its own fresh
 * store + operationId, so concurrent tests never share a budget by
 * accident. Mirrors `createRetryLedger(Number.POSITIVE_INFINITY)` from
 * before this find-shape's round 1, updated for the durable, keyed shape:
 * `initialize` is async now, so this helper is too.
 */
export async function unlimitedLedger(
  operationId = `unlimited-${Math.random().toString(36).slice(2)}`,
): Promise<DurableRetryLedger> {
  const store = createMemoryLedgerStore();
  await store.initialize(operationId, Number.POSITIVE_INFINITY);
  return createDurableRetryLedger(store, operationId);
}

---
"@phyxiusjs/durable-step": minor
---

Make the conserved retry budget durable across a process hop

`createRetryLedger` conserved retry capacity across sibling steps, but the
pool lived in a plain closure variable. A step interrupted mid-flight and
revived by a different worker in a different process saw a fresh ledger,
not the one its predecessor had already partially spent, so decomposing an
operation across a process boundary could mint retry capacity the same way
decomposing it into more steps once could, before the original ledger
closed that case. The 2026-08-06 `discipline-synthesis` outage this
mechanism exists to prevent is exactly the failure mode a silently reset
budget would reopen.

`RetryLedger` (sync, closure-backed) is replaced by `DurableRetryLedger`
(async) plus a new `LedgerStore` port, shaped after `StateStore`'s own
async, CAS, keyed-by-identity contract instead of inventing a new one. The
client is now a thin, disposable pair, `(store, operationId)`, reconstructed
wherever it is needed rather than threaded by object reference.
`createMemoryLedgerStore` ships as the in-process reference implementation
for tests and single-container deployments. `runClimb` now owns the
budget's declaration for the whole operation: `initialize` is idempotent
when a revived climb re-declares the same budget, and refused
(`ClimbBudgetMismatchError`) when a second declaration disagrees, closing
the mint-by-mistake case a nested step could otherwise trigger. Drawing
against an operation nobody ever declared a budget for refuses the step
(`LEDGER_NOT_INITIALIZED`) rather than silently reading `unknown` as `0` or
as unlimited.

This is a breaking change to the retry-budget API: `createRetryLedger` and
`RetryLedger` are gone, and `runClimb` takes a new `operationId` argument
plus `ledgerStore` and `retryBudget` in its deps. Acceptable here because
the package is 0.1.x and not yet wired into the framework export.

Conservation across a real process boundary is proven with a test-only,
file-backed `LedgerStore` driven from genuinely separate
`child_process.fork()`ed workers, not two objects in one heap: a worker
that "crashes" after drawing part of a budget is followed by a second,
different OS process that resumes the same operation and draws only the
true remainder, never a fresh grant. That file-backed store is a proof
harness, not a production adapter, still test-local; a real deployment
needs its own `LedgerStore` backed by real durable storage (Postgres
row-level CAS is the same horizon already named for `StateStore` and
`PhaseStore`). `StateStore` itself is unchanged by this work and still
ships only an in-memory implementation, so a step's machine state
surviving a process hop remains open.

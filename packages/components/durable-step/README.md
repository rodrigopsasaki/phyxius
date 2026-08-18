# @phyxiusjs/durable-step

This package is the working artifact of two `find-shape` runs on Phyxius.

The first converged on what a **durable step** should be as a composition
of `@phyxiusjs/state-machine` (compile-time legality),
`@phyxiusjs/migration` (runtime earnedness / evidence), and
`@phyxiusjs/handler` (lifecycle, concurrency, journaling).

Full log: `docs/notes/2026-08-17-durable-step-find-shape.md`.
Raw per-round output: `docs/notes/durable-step-rounds/round-*.txt`.

The second converged on how the **conserved retry budget** that first run
introduced (`RetryLedger`) threads through genuinely nested steps and
survives a step being revived by a different worker in a different
process. `RetryLedger` was replaced by the async, operation-keyed
`DurableRetryLedger` / `LedgerStore` this package now ships, and `runClimb`
now owns the budget's declaration.

Full log: `docs/notes/2026-08-17-retry-budget-find-shape.md`.

## Status

Published (0.1.x), not wired into the framework export. Not a claim that
this is "the" durable-step primitive, it is the matured shape two bounded
find-shape runs converged on, kept clean enough to build on.

- **The retry ledger is durable and survives a process hop.** A step's
  conserved retry budget lives in a `LedgerStore`, keyed by the operation's
  own `operationId` rather than an in-memory object reference. A worker
  reviving an operation in a fresh process reconstructs a
  `DurableRetryLedger` from nothing but `(store, operationId)` and draws
  from the exact remainder its predecessor left, proven across a genuine
  `child_process.fork()` boundary in `test/retry-budget/`.
- **`LedgerStore` ships with an in-memory implementation.** Real
  durability across a real deployment means supplying your own backed by
  real storage (Postgres row-level CAS is the horizon already named for
  `StateStore`/`PhaseStore`); the interface is the contract,
  `createMemoryLedgerStore` is for tests and single-container deployments.
- **`StateStore` still ships with only an in-memory implementation.**
  Unlike the retry ledger, a step's own machine state surviving a real
  process hop has not been addressed, it is shaped correctly (async, CAS,
  keyed by identity) but only `createMemoryStateStore` exists.
- Shaped by two bounded `find-shape` runs against real workloads rather
  than designed in the abstract. The logs, including what they got wrong
  on the way, are in `docs/notes/`.

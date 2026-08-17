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
process — `RetryLedger` was replaced by the async, operation-keyed
`DurableRetryLedger` / `LedgerStore` this package now ships, and `runClimb`
now owns the budget's declaration.

Full log: `docs/notes/2026-08-17-retry-budget-find-shape.md`.
Raw per-round output: `docs/notes/retry-budget-rounds/round-*.txt`.

**Status: published (0.1.x), not wired into the framework export.** Not a
claim that this is "the" durable-step primitive — it is the matured shape
two bounded find-shape runs converged on, kept clean enough to build on.

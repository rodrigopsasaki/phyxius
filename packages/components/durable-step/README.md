# @phyxiusjs/durable-step (exploratory)

This package is the working artifact of a `find-shape` run on Phyxius:
converging on what a **durable step** should be as a composition of
`@phyxiusjs/state-machine` (compile-time legality), `@phyxiusjs/migration`
(runtime earnedness / evidence), and `@phyxiusjs/handler` (lifecycle,
concurrency, journaling).

Full log: `docs/notes/2026-08-17-durable-step-find-shape.md`.
Raw per-round output: `docs/notes/durable-step-rounds/round-*.txt`.

**Status: exploratory.** Not published, not wired into the framework
export, not a claim that this is "the" durable-step primitive — it is the
matured shape a bounded find-shape run converged on, kept clean enough to
build on.

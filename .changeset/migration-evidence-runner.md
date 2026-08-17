---
"@phyxiusjs/migration": minor
---

Export `runEvidenceBag` — the evidence-running primitive, lifted out of the
private phase-advance internals it had been buried in.

Nothing about running an evidence bag was specific to advancing a migration
phase; it was simply written there first. Any caller asking "has this been
earned" wants it, and `@phyxiusjs/durable-step` is the first such caller.
Behaviour is unchanged for existing users — this is a lift, not a rewrite,
and migration's own phase-advance path now consumes the shared function.

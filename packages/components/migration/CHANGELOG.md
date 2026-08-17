# @phyxiusjs/migration

## 0.3.0

### Minor Changes

- 6ecb37e: Export `runEvidenceBag` — the evidence-running primitive, lifted out of the
  private phase-advance internals it had been buried in.

  Nothing about running an evidence bag was specific to advancing a migration
  phase; it was simply written there first. Any caller asking "has this been
  earned" wants it, and `@phyxiusjs/durable-step` is the first such caller.
  Behaviour is unchanged for existing users — this is a lift, not a rewrite,
  and migration's own phase-advance path now consumes the shared function.

### Patch Changes

- Updated dependencies [ce429f2]
  - @phyxiusjs/clock@0.3.0
  - @phyxiusjs/handler@0.4.0
  - @phyxiusjs/atom@0.2.1
  - @phyxiusjs/journal@0.2.1
  - @phyxiusjs/fp@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies [9553db8]
  - @phyxiusjs/handler@0.3.0

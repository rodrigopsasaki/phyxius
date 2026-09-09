# @phyxiusjs/durable-step

## 0.1.1

### Patch Changes

- 6c6fafd: Close two shutdown paths that did less than they reported

  `drain.stop()` promised a final drain and could deliver nothing. `force`
  bypasses a backoff hold but never a live write, so a `stop()` that raced an
  in-flight flush was classified as "skip", and every entry buffered during that
  write was dropped without a word. Shutdown now waits for the write already in
  the sink, drains every batch rather than one, and reports `remaining` as what
  it could not deliver instead of what it happened to be holding when it began.
  The old value meant a clean shutdown still announced a non-zero remainder.

  `Supervisor` decided restarts through a boolean, so "not restarting" could not
  say which of three things it was, and two of them emitted nothing at all. The
  sharpest case: shutdown landing inside a restart's backoff sleep retired the
  child on a decision that said restart, after the restart budget had already
  been spent. `RestartDeclined` names the three reasons, the budget case keeps
  its existing `supervisor:giveup` event unchanged, and the other two now emit
  `supervisor:restart:abandoned`. `ProcessEvent`'s own contract already required
  this: a state transition a consumer would care about MUST produce an event.

  `createMemoryStateStore` now composes `@phyxiusjs/atom` instead of a hand-written
  compare over a bare `let`. The atom was already a declared dependency of the
  package and imported by nothing. `StateStore` stays async and `Result`-returning
  because durable state must outlive its process and a race has to name its winner;
  the atom implements the store, it cannot be the interface.

  Follow-up from Preston's review of this PR: the memory state store keeps the
  atom's default reference equality. A kind-based `equals` looked right, but in
  `createAtom` that predicate decides the CAS _and_ whether `swap` treats the
  write as a change, so a same-kind transition carrying a new payload was read
  as "nothing changed", the commit was skipped, and `trySet` returned `ok` over a
  stale value. A silent false success, in the store belonging to the package
  whose subject is that silence must not read as success. The kind comparison the
  contract wants already happens in `trySet`, before the CAS.
  - @phyxiusjs/handler@0.4.1
  - @phyxiusjs/migration@0.3.1

## 0.1.0

### Minor Changes

- 6ecb37e: Initial release: the durable step — a work step whose duration, spend, retry
  allowance and proof of completion are attributable by construction.

  Composes three pieces that already existed separately and had never been
  brought together: `state-machine` answers whether a transition is _legal_
  (pure, sync, no IO by type, so it can be checked before any work is spent),
  `migration`'s evidence vocabulary answers whether a transition has been
  _earned_ (inherently IO — the question can only be answered by looking at the
  world), and the handler supplies lifecycle and journalling.

  The two are deliberately composed rather than merged: merging would force one
  to lie about its own nature, since a state machine that can await is no longer
  checkable without mocks, and evidence that pretends to be synchronous cannot
  ask the world anything.

  Found by a bounded find-shape run over six rounds against three real climb
  phases; the log and per-round raw output are in `docs/notes/`.

### Patch Changes

- Updated dependencies [6ecb37e]
- Updated dependencies [ce429f2]
  - @phyxiusjs/migration@0.3.0
  - @phyxiusjs/clock@0.3.0
  - @phyxiusjs/handler@0.4.0
  - @phyxiusjs/atom@0.2.1
  - @phyxiusjs/journal@0.2.1
  - @phyxiusjs/fp@0.2.1
  - @phyxiusjs/retry@0.2.1
  - @phyxiusjs/state-machine@0.2.1
  - @phyxiusjs/validate@0.2.1

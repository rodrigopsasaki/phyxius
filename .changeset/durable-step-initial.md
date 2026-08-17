---
"@phyxiusjs/durable-step": minor
---

Initial release: the durable step — a work step whose duration, spend, retry
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

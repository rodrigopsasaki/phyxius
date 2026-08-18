---
"@phyxiusjs/process": minor
"@phyxiusjs/drain": minor
"@phyxiusjs/durable-step": patch
---

Close two shutdown paths that did less than they reported

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

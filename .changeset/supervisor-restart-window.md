---
"@phyxiusjs/process": minor
---

Key a supervised child's restart budget and backoff to its own address, not its incarnation

Every restart built the replacement process without passing an id, so each
incarnation minted a fresh `ProcessId`. `Supervisor` decided restarts and
computed backoff by looking up that same id in its restart-window bookkeeping,
so every restart found an empty window, started over at attempt one, and the
budget never accumulated: a child crashing on every message restarted forever
with no backoff growth and no `supervisor:giveup`. `spawn` now mints a stable
slot id up front and keys the window, the restart count, and the backoff
attempt on it across every incarnation underneath. The window itself is also
measured on the clock's monotonic reading instead of `wallMs`, so a wall-clock
jump can no longer open or close it on its own.

A failed re-init used to end supervision after a single
`supervisor:restart:failed`, with the child left with zero children and no
`supervisor:giveup`. It is retried now, under the same budget and the same
backoff, until the budget says stop.

The ref `spawn` returns is a stable address for the slot, not a snapshot of
one incarnation: `send` / `ask` / `stop` / `status` follow whichever
incarnation is currently live, so a caller that only ever holds the original
ref keeps reaching the child across restarts instead of reading back a
permanently `"failed"` status after the first one.

Backoff jitter took its randomness from `Math.random`, against this
package's own "time and randomness are injected" rule. `Supervisor`'s
constructor is now overloaded on the strategy it's given: a strategy whose
backoff has no jitter, or jitter pinned to the literal `0`, needs no
`random`. The moment a strategy's backoff declares a real, nonzero jitter
magnitude, the only overload that accepts it also requires
`random: () => number` — there is no default, and nothing in this package's
source reads the global `Math.random` anymore.

Breaking, at the type level: a caller who built a jittered strategy without
injecting `random` compiled before (and silently drew jitter from
`Math.random` at runtime) and does not compile now. The fix is to inject the
same `random` this package already asks for everywhere else time and
randomness matter. Nothing changes for a strategy with no jitter, including
the constructor's own default strategy, which has none.

Behavior note for existing consumers: `processId` (and the bare `id` on
`supervisor:restart`) on every supervisor-level event, that is
`supervisor:restart`, `supervisor:giveup`, `supervisor:restart:abandoned`,
`supervisor:supervising`, `supervisor:spawned`, `supervisor:child:stopped`,
`supervisor:escalated`, and `supervisor:child:stop:error`, now carries the
child's stable slot id rather than whichever incarnation happened to be
running when the event fired. A
consumer correlating those events by id across a restart will now find the
same id where it previously saw a new one each time; `oldProcessId` and
`newProcessId` on `supervisor:child:restarted` are unchanged and still name
the two actual incarnations being swapped.

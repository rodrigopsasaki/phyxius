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
attempt on it across every incarnation underneath. The window is measured on
the clock's monotonic reading instead of `wallMs`, so a wall-clock jump can no
longer open or close it on its own.

The window now slides. It used to restart from scratch the first time a restart
landed more than `within` after it opened, so a burst straddling that moment
spent the budget twice: `count: 3, within: 10s` admitted five restarts across
crashes at 0s, 9s and 10.001s to 10.003s. It now holds the restarts of the
trailing `within` (one exactly `within` old still counts), so no such span
contains more than `count`, and the backoff attempt is the number still inside
it. `count: 0` now means no restarts; it used to grant one.

A failed re-init used to end supervision after a single
`supervisor:restart:failed`, with the child left with zero children and no
`supervisor:giveup`. It is retried now, under the same budget and the same
backoff, until the budget says stop. With no `maxRestarts` the budget never
does: the retry backs off along the curve, capped at `backoff.max`, for as long
as re-init keeps failing, and waits at least 1 ms between tries, whatever the
curve computes to (an overflowed curve included), so it can never spin without
yielding to the event loop. With no `maxRestarts` there is no window to count
in, so the backoff attempt counts since the child last started: a crash of a
running child is attempt 1, each consecutive failed re-init after it is the
next, and a successful start resets the count. A child that crashes once in a
while waits `backoff.initial` every time, as it did before this change, rather
than backing off further with each crash.

The ref `spawn` returns is a stable address for the slot, not a snapshot of
one incarnation: `send` / `ask` / `stop` / `status` follow whichever
incarnation is currently live, so a caller that only ever holds the original
ref keeps reaching the child across restarts instead of reading back a
permanently `"failed"` status after the first one. `ref.stop()` is final: the
slot is retired, so a restart waiting in backoff or starting when the stop
lands is not carried out (and a replacement already starting is stopped rather
than left running), and a child whose own `onStop` throws is not restarted as
though it had crashed. A child stopped through its ref no longer appears in
`getChildren()`. A failure signalled from inside a `supervisor:child:restarted`
handler, for example by sending the new incarnation a message that crashes it,
is handled like any other; it used to be dropped.

Anything in the restart path that throws outside the re-init itself (the
backoff arithmetic, the clock, an emit sink) is no longer left as a failed
child in `getChildren()` with nothing coming. If a replacement was already
running the child stays supervised and the fault is reported as
`supervisor:restart:failed`; otherwise the slot is retired and
`supervisor:restart:abandoned` reports it. A sink that throws on
`supervisor:child:restarted` is no longer counted as a failed re-init, which
had created a second replacement alongside the first. A sink that throws on a
child's own `process:fail` no longer stops the failure being handled: the child
is restarted as usual and the sink's error is reported as
`supervisor:restart:failed`. It used to leave the child `failed` in
`getChildren()` with no restart and no supervisor event, and the throw as an
unhandled rejection.

`RestartDeclined`, the `because` on `supervisor:restart:abandoned`, gains two
reasons: `child-stopped` (the caller stopped the child through its ref while a
restart was pending) and `supervisor-fault` (the supervisor's own machinery
threw; the event carries the `error`). Code that switches over `because`
exhaustively needs the two new cases.

Backoff jitter took its randomness from the global `Math.random`, so a
controlled clock alone could not reproduce a backoff delay. `Supervisor` now
takes an optional `random: () => number`, injected the way the clock is, and
nothing in this package's source reads the global `Math.random` anymore. With a controlled clock and a fixed `random`
every backoff delay is reproducible; process and slot ids still come from
`createProcessId`, which is not injected, so they are not.

Breaking, and only for a strategy that declares jitter without `random`, since
that is the one case that used to draw from `Math.random`:

- A strategy literal with a nonzero `backoff.jitter` and no `random` no longer
  compiles. Inject `random`, or set the jitter to `0`.
- A strategy typed as the exported `SupervisionStrategy` compiles with or
  without `random`, because the type cannot say whether it carries jitter. One
  that does carry a nonzero jitter and arrives without `random` throws from
  the constructor, naming `random`, where it used to draw from `Math.random`.
- `jitter: 0`, and strategies with no jitter, need no `random`, including the
  constructor's own default strategy.

Behavior note for existing consumers: `processId` (and the bare `id` on
`supervisor:restart`) on every supervisor-level event, that is
`supervisor:restart`, `supervisor:giveup`, `supervisor:restart:abandoned`,
`supervisor:supervising`, `supervisor:spawned`, `supervisor:child:stopped`,
`supervisor:escalated`, and `supervisor:child:stop:error`, now carries the
child's stable slot id rather than whichever incarnation happened to be
running when the event fired. A consumer correlating those events by id across a
restart will now find the same id where it previously saw a new one each time;
`oldProcessId` and `newProcessId` on `supervisor:child:restarted` are unchanged
and still name the two actual incarnations being swapped. The `delayMs` on
`supervisor:restart` is the wait the supervisor actually takes.

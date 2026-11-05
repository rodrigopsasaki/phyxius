# Retry budget — find shape

## Premise

The prior find-shape (`docs/notes/2026-08-17-durable-step-find-shape.md`)
built `@phyxiusjs/durable-step`, and its round 3 introduced `RetryLedger` —
one shared, atomically-debited pool of "extra" attempts that sibling steps
draw from instead of each declaring its own independent retry policy. It
closed the flat case (several steps fanning out from one parent, sharing
one object reference) and left one thread explicitly open: how the budget
threads through **genuine nesting**, and what happens when a step is
interrupted mid-flight and resumed by a **different worker in a different
process**. Round 3's own write-up disclosed the friction honestly:
`HandlerEvent.attempts` goes stale once retry moves into this composition
layer, and the repo owner said plainly he didn't know the answer to
propagation — "it could live on the context that every handler has."

Three ratified decisions bear on this run directly: retry authority
belongs to the operation boundary and a step draws from its **parent's**
conserved budget, not a fresh one of its own; Phyxius exists to serve
Mycelium and changing Phyxius is the sanctioned path when the runtime
doesn't fit, not designing around it; and a climb step must be _defined_
before it can _run_, with its observability built in, not bolted on. The
premise held with confidence going in — context propagation alone cannot
carry the budget's balance, because an in-memory object does not survive a
process hop — was treated as testable, not assumed. It held; see Round 0.

## Fitness

Held constant across every round:

> Can a nested step draw retry capacity it was not granted — across a
> function call, an async boundary, and a process hop where the step is
> revived by a different worker? And is "no budget declared" distinguishable
> from "unlimited"?

Judged by whether capacity can be **minted**, never by API elegance.
`unknown` is graded as its own state throughout, never folded into "safe."

## Corpus

1. **Flat siblings** — the shape round 3 of the prior find-shape already
   proved (several items sharing one ledger reference, one process).
2. **`discipline-synthesis` at scale** — ~6 calls/convention over ~98
   conventions is healthy (~588, generously, if unconserved); the
   2026-08-06 outage ran ~274/convention (~5,481 total). Expressed as a
   climb with per-item children, each retrying internally.
3. **A revived child** — interrupted mid-flight, resumed by a different
   worker in a different process.

## Round 0 — baseline

`createRetryLedger` exactly as published on `main` (0.1.0/0.1.1),
unchanged. Formally scored against corpus item 1; two headroom probes ran
alongside using the same unchanged mechanism. Raw output:
`retry-budget-rounds/round-0.txt`. Full test source (moved out of the live
test tree once round 1 landed, since it can no longer compile against the
new `defineDurableStep`): `retry-budget-rounds/round-0-source/`.

| #            | Corpus item                    | Result                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (scored)   | Flat siblings                  | **Pass.** Three items sharing one `RetryLedger` reference conserve exactly as round 3 of the prior find-shape proved.                                                                                                                                                                                                                                                                           |
| 2 (headroom) | Nested, one function call deep | **Capacity minted.** A "nested child" that reaches for `createRetryLedger(3)` fresh — instead of the reference its ancestor already held — succeeds silently. Combined grant: 4 extra attempts against a declared 3. Nothing in the type signature or the runtime distinguishes the mistake from correct use.                                                                                   |
| 3 (headroom) | Real process hop               | **Capacity minted, deterministically, every time.** Two genuinely independent OS processes (`child_process.fork`, not two objects in one heap), each constructing `createRetryLedger(3)` for "the same operation," each get their own full grant of 3 — 6 total against a declared 3. There is no channel through which a second process could even ask "how much is left," let alone learn it. |

**Headroom this picked Round 1.** Item 1's pass confirms nothing new. Items
2 and 3 are the same defect at two different scales: the sync,
closure-backed `RetryLedger` interface cannot ever be backed by anything
durable — a network round-trip cannot resolve synchronously — so
"propagate the budget across a process hop" had no answer because the
_interface itself_ foreclosed one. `StateStore`/`PhaseStore` already solve
this exact shape (async, CAS, keyed by identity); reshaping the ledger to
match is the highest-leverage first move, not a smaller warm-up step.

## Round 1 — a durable, operation-keyed ledger

**Change.** `RetryLedger` (sync) replaced by `DurableRetryLedger` (async) +
a new `LedgerStore` port, shaped after `StateStore`'s own contract:
`get`/`initialize`/`draw`, CAS internally, keyed by `operationId` instead
of object identity. `createMemoryLedgerStore()` ships as the in-process
reference implementation (mirrors `createMemoryStateStore` exactly).
`createDurableRetryLedger(store, operationId)` is a thin, disposable
client — reconstructible anywhere with only two cheap, serializable
things. `initialize(operationId, n)` is idempotent when re-declaring the
**same** `n` (the revival case) and refused
(`ALREADY_INITIALIZED_WITH_DIFFERENT_BUDGET`) when a second declaration
disagrees (round 0's mistake, now structurally caught). `draw()` throws
`LedgerNotInitializedError` — never a silent 0, never a silent
unlimited — when `operationId` has no record at all.

**Hypothesis.** If the ledger's balance lives in a store keyed by
`operationId` instead of in the client's own closure, then (a) item 1
conservation survives unchanged, (b) an undeclared operation is a
distinguishable, refused `unknown` state, (c) a second declaration that
disagrees is refused rather than silently granted, and (d) a client
reconstructed from nothing but `(store, operationId)` — not the original
object reference — sees the true, current balance.

**Result.** Held. 6/6 new tests pass
(`test/retry-budget/round-1-durable-ledger.test.ts`, `round-1.txt`), plus
all 22 pre-existing durable-step tests kept passing after migrating their
own `createRetryLedger(Number.POSITIVE_INFINITY)` call sites to the new
shape (`test/round-1..5-*.test.ts`, `test/helpers.ts`). The sharp cases:
drawing against a never-initialized operation refuses the _step itself_
(`HandlerError.HANDLER_ERROR` with a `LEDGER_NOT_INITIALIZED` refusal),
not merely the ledger call; re-initializing with a different budget is
refused while re-initializing with the _same_ budget after attempts were
already drawn leaves `drawn` untouched (3 remaining stays 3, not reset to 5) — proving the idempotent-revival and refused-mistake paths are
genuinely distinct, not one check standing in for both. A client built
fresh in a "nested child" function frame, handed only the operationId
string, correctly saw 3 remaining (not a fresh 5) and its draw was visible
back at the parent's own (different) client object — the object reference
never mattered.

**Next.** Item 1 and the nested-mint half of item 2 are closed in-process.
The process-hop half (item 3) is not — an in-memory `Map`-backed store
proves the _shape_ can be durable, not that it _is_, across a real process
boundary.

## Round 2 — genuine process hop

**Change.** A test-only `LedgerStore` implementation backed by a real file
on disk (`test/retry-budget/support/file-ledger-store.mjs`), CAS'd via a
directory-mutex lock (`fs.mkdir` create-if-absent, no extra dependency) —
not exported from the package, a proof harness standing in for a real
durable store (Postgres row-level CAS is the horizon, same as
`StateStore`/`PhaseStore`). Exercised from genuinely separate
`child_process.fork()`ed Node processes
(`test/retry-budget/support/durable-ledger-worker.mjs`), each importing
the real built `@phyxiusjs/durable-step` package and handed nothing but a
file path and an `operationId` string via argv.

**Hypothesis.** If a worker resumed in a different OS process, handed only
that small handle, draws from the same conserved pool its predecessor
already partially spent — not a fresh one — the process-hop half of the
fitness question closes for real, not just in theory.

**Result.** Held, stable across 3 repeat runs
(`test/retry-budget/round-2-cross-process-revival.test.ts`, `round-2.txt`).
Worker A (budget 3) draws 2 and exits — modeling a crash, nothing more; it
simply never runs again. Worker B, a genuinely different PID, resumes with
`operationId` alone (no re-declaration — "skip") and is granted exactly 1,
not 3: **combined across both real processes, exactly 3 extra attempts,
never 6.** A third process attempting to re-declare the same operation
with a different number is refused even across the process boundary. A
worker asking about an operation nobody has ever declared, on a store
nobody has written to, sees `"unknown"` — the `LedgerNotInitializedError`
survives the hop, not just the in-memory case. One genuine harness bug
surfaced and was fixed, not swept in: `JSON.stringify(Infinity)` silently
serializes to `null` (both in the file and over the fork's own IPC
channel, which JSON-serializes messages internally) — a well-known JS
gotcha in the test's own plumbing, not a finding about the ledger's
design; fixed with a sentinel-string round-trip at both boundaries.

**Next.** Round 2 proved sequential handoff (A finishes, _then_ B starts).
Real distributed systems also produce split-brain: an orchestrator that
believes a worker died launches a replacement while the "dead" worker is
still actually running. That's a different, sharper stress on the same
CAS.

## Round 3 — concurrent processes, not just sequential handoff

**Change.** None to the mechanism — this round stress-tests round 2's
file-lock CAS under genuinely concurrent contention: N processes launched
simultaneously via `Promise.all`, not sequential `await`s.

**Hypothesis.** If the file-lock's CAS genuinely serializes
read-modify-write across concurrent OS processes, then 5 processes racing
to draw from the same finite budget at the same instant still never grant
more in total than the budget declares, and two processes racing to
_declare_ the same operation — whether they agree or disagree on the
number — converge on exactly one consistent outcome, never a corrupted
hybrid.

**Result.** Held, stable across 5 repeat runs
(`test/retry-budget/round-3-concurrent-processes.test.ts`, `round-3.txt`).
5 genuinely distinct PIDs racing for a budget of 3 (each wanting 2)
distribute exactly 3 in total, every individual grant a well-formed
non-negative integer. 5 processes racing to declare the _same_ budget
concurrently all report success (idempotent), and a probe afterward
confirms the store holds one uncorrupted record, not a torn write. Two
processes racing with _disagreeing_ declared budgets (3 vs. 300) converge
on exactly one winner and one refusal — never both silently accepted,
never an averaged or corrupted third value.

**Next.** The mechanism itself is now proven at three levels: in-process
(round 1), sequential cross-process (round 2), concurrent cross-process
(round 3). What's left is wiring it into the actual entry point a real
durable action calls, and proving it at the corpus's own scale rather than
3-item toy examples.

## Round 4 — wired into `runClimb`, proven at outage scale

**Change.** `runClimb(name, deps, fn)` becomes
`runClimb(name, operationId, deps, fn)`. `deps` gains `ledgerStore:
LedgerStore` and `retryBudget: number` — the climb now durably,
idempotently declares its own conserved budget at the operation boundary
(the ratified decision's own language), and hands `fn` a constructed
`retryLedger` to thread to every nested `defineDurableStep` call, no
matter how deep. A budget that disagrees with what's already recorded for
`operationId` throws `ClimbBudgetMismatchError` rather than silently
picking a side. All 5 pre-existing round-N test files retrofitted to the
new signature (declaring `Number.POSITIVE_INFINITY` where conservation
isn't what they're testing) and re-verified green.

**Hypothesis.** If every item in a `discipline-synthesis`-shaped climb,
no matter how many there are, draws its extra attempts from one
climb-owned ledger, then even the absolute worst case — every single item
persistently flaky, each demanding its full declared ceiling — cannot
exceed `itemCount + retryBudget` total attempts. The runaway becomes
**unreachable**, not merely detectable after the fact.

**Result.** Held, on the first run
(`test/retry-budget/round-4-outage-scale.test.ts`, `round-4.txt`). 98
items, every single one persistently flaky (never succeeds, the worst case
on purpose), each declaring `retry.fixed({ maxAttempts: 6 })` (the
corpus's own "healthy ~6 calls" figure) and sharing a climb-owned budget of
50: total attempts landed at exactly 148 — `98 + 50`, the hard ceiling,
reached exactly, never exceeded. That's ≈1.5 calls/convention in the
worst case the mechanism allows, next to the outage's actual ≈274 — nearly
two orders of magnitude below it, not merely "less." A second run with the
same 98 items well-behaved (succeed on the first, guaranteed try) spent
none of the conserved pool — conservation is dormant machinery in the
common case, not overhead the healthy path pays for.

**Next.** Both fitness-question halves are closed at every scale and
process topology the corpus names. Two consecutive rounds (3 and 4) held
on first run with no new structural finding requiring a mechanism change —
round 3 was pure stress-testing that _confirmed_ round 2's design, round 4
was pure wiring plus scale validation. That's the convergence signal, not
a slot left unfilled: stopping here.

## Closing synthesis

### The fitness question's honest answer

**Can a nested step draw retry capacity it was not granted?**

- **Across a function call:** the _published_ `RetryLedger` (Round 0) —
  yes, trivially: one extra `createRetryLedger(n)` call, indistinguishable
  from correct use. The _durable_ `DurableRetryLedger` (Round 1 on) — no:
  a second declaration under the same `operationId` that disagrees is
  refused; a client reconstructed fresh at any call depth reads the true
  shared balance, not a new one, because the balance was never in the
  client's own closure to begin with.
- **Across an async boundary:** every `LedgerStore` operation is
  `Promise`-returning by construction, so there is no synchronous window
  for a caller to observe stale state and act on it; Round 3 additionally
  proves this holds under _genuine_ OS-level concurrency (5 real processes
  racing simultaneously), not just single-threaded JS's own ordering
  guarantees.
- **Across a process hop where the step is revived by a different
  worker:** the published ledger — yes, deterministically, every single
  revival, because its interface gave a second process no channel to even
  ask the question. The durable ledger — no: Round 2 proves a genuinely
  separate OS process, handed only a file path and an operationId, draws
  from the exact remainder its predecessor left, not a fresh grant; Round
  3 proves this holds even when the "revival" is actually a split-brain
  race between two workers that both believe they're the legitimate
  resumer.

**Is "no budget declared" distinguishable from "unlimited"?** Yes,
structurally, at every level tested. `Number.POSITIVE_INFINITY` is the
explicit, auditable "not conserved" declaration (unchanged in spirit from
the prior find-shape's own `retry.none()`-shaped pattern, now durable).
An operation with no record at all is a third, distinct state —
`"unknown"` from `.remaining()`, a thrown, typed
`LedgerNotInitializedError` from `.draw()`, refused all the way up into a
`StepRefusal` the handler machinery already knows how to carry. Round 2
and Round 3 both confirm this survives the process hop and concurrent
contention, not just the single-process case.

### Did the durable-ledger constraint hold, or was it disproved?

**It held, and Round 0 is the reason it's not merely assumed.** The
premise stated context propagation alone cannot be the answer because an
in-memory object does not survive a process hop. Round 0's headroom probe
#3 didn't just illustrate this — it _measured_ it: two real, independent
`child_process.fork()`ed processes, zero shared memory, each constructing
the published ledger fresh, each granted a full independent budget. The
premise predicted exactly this failure mode before it was run. Nothing in
five rounds surfaced a case where the constraint was wrong; every round
that touched the process-hop question (0, 2, 3) reinforced it from a
different angle. The resolution matches the premise's own suggested shape
almost exactly: the ledger's _balance_ lives durably, keyed by the
operation's identity; context (or a queue message, or argv, as the test
harnesses stand in for) carries only the `operationId` — the "handle" the
premise named, cheap enough to serialize across any real hop.

### Does `@phyxiusjs/handler` need to change?

**No — considered, not skipped.** Zero files under
`packages/components/handler/` were touched across all five rounds. The
reason is structural, not incidental: since Round 3 of the _prior_
find-shape, `defineDurableStep` already always spawns the underlying
handler with `retry.none()` and owns retry orchestration entirely inside
its own composition layer — the handler's `spawn()`/`runInvocation()` never
sees the ledger, the operationId, or any of this round's machinery at all.
Reshaping the ledger from sync-and-closure-backed to async-and-durable is
therefore purely a `durable-step`-internal concern; the handler's contract
(`HandlerSpec`, `spawn`, `HandlerTools`) didn't need to widen to accommodate
it. This is the "Phyxius exists to serve Mycelium, change Phyxius rather
than design around it" decision applied honestly in both directions: the
prior find-shape's round 3 _did_ need that principle (moving retry
ownership out of the handler's own per-call loop into the composition
layer was itself a real behavioral change); this run's job — reshaping
what already lives in that composition layer — didn't need to reach back
into the primitive underneath it. The disclosed friction from the prior
run (`HandlerEvent.attempts` reads 1 regardless of how many attempts the
ledger granted; the truth lives only in `observed.retryAttemptsUsed`)
remains open, unchanged, and is not this run's job to close — it's a
different, narrower question (a stale native field) than the one this
find-shape was scoped to (whether capacity can be minted).

### What remains genuinely `unknown`

- **Whether `StateStore` needs the same durability treatment.** It's
  already shaped correctly (async, CAS, keyed) — unlike the old
  `RetryLedger`, it never structurally foreclosed a durable
  implementation — but only `createMemoryStateStore` ships. A step's
  _machine state_ surviving a real process hop is the natural next
  question this run's own corpus item 3 gestures at but doesn't answer:
  this run only proved the _retry budget_ survives revival, not that the
  whole step does. Genuinely open, not evaded.
- **Whether a real production `LedgerStore` (Postgres-backed, matching the
  horizon already named for `StateStore`/`PhaseStore`) behaves identically
  to the file-backed proof harness under real network partition and
  latency, not just local-disk CAS.** The file store proves the _shape_ of
  the contract is sufficient; it is deliberately not shipped as a
  production adapter (kept test-local, per PHYXIUS_CODEX's own "don't
  claim what you haven't built" convention), so this is unverified beyond
  what a local filesystem's atomicity guarantees actually cover.
- **Whether `runClimb`'s `ClimbBudgetMismatchError` is the right failure
  mode for a real redeploy that legitimately changes a climb's configured
  budget mid-flight**, versus some explicit migration path for the budget
  itself. Not exercised here — the tests only cover accidental/malicious
  disagreement, not intentional reconfiguration.
- **Whether `HandlerEvent.attempts` going stale (the prior find-shape's
  own disclosed friction) is worth a dedicated `@phyxiusjs/handler` change**
  — e.g., a hook letting composition layers like `durable-step` report a
  true attempts count back into the native field. Out of this run's scope;
  flagged, not resolved.

### What in the premise was wrong

Nothing load-bearing. The one correction is a scope note, not a
disproof: the premise's own phrasing ("it could live on the context that
every handler has") turned out to be half right in a way worth stating
precisely — context is exactly the right place for the **operationId
handle**, and exactly the wrong place for the **balance**. The repo
owner's own uncertainty ("I don't even know how to propagate it down")
was honest, not mistaken; this run's answer is that "it" was never one
thing to propagate — a handle (cheap, contextual, revivable) and a balance
(durable, keyed, queried fresh) were both hiding inside that one sentence,
and separating them is most of what made the rest of the shape fall out
cleanly.

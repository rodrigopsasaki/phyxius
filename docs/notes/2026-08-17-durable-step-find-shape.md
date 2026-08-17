# Durable step — find shape

## Premise

Three Phyxius primitives exist, built at different times, never composed:

- **`@phyxiusjs/state-machine`** — `define`/`apply`/`can`. Pure, sync, no IO
  by type. Answers _"is this transition legal?"_ at compile/inspect time.
- **`@phyxiusjs/migration`** — `defineMigration`/`createMigration`, phases
  carrying an evidence bag; a phase advances only when the next phase's
  evidence all resolves `Ok`. Answers _"has this transition been earned?"_
  at runtime. Wrong-until-proven-otherwise by construction.
- **`@phyxiusjs/handler`** — owns lifecycle, concurrency, backpressure, and
  mandatory journal events per invocation.

The hypothesis under test: these are two registers of one idea — compile-time
legality and runtime earnedness — and the durable step is what composes them
on top of the handler. The repo owner's instinct going in was that
state-machine and migration "have a lot of overlap and may actually be one
thing"; the working hypothesis was that they're complementary and should NOT
merge, because merging would collapse the pure/impure boundary that makes
each trustworthy on its own. Both readings were held open for this run to
overturn.

## Fitness

Held constant across every round:

> Can a new durable step be declared such that its duration, its spend, its
> retry allowance drawn from a parent budget, and its proof of completion are
> ALL attributable — without the step's author having written anything to
> make that true? And conversely: is an unattributed minute or an
> unattributed cent even expressible?

## Corpus

1. **`infer-standards`** — a synthesis pass, 4m23s. The easy case.
2. **`discipline-synthesis`** — ~6 model calls per convention × 98
   conventions, internal retries. The budget case; caused a real
   multi-tenant outage on 2026-08-06 at 5,481 calls.
3. **The invisible 25 minutes** — climb started 04:13:15, first recorded
   stage began 04:38:07. Today this isn't a step at all — the phase nobody
   had to declare, so nobody did. The hardest case.

## Round 0 — baseline

Expressed corpus item 1 using `state-machine` + `migration` + `handler`
exactly as shipped, unmodified. Five scored findings
(`packages/components/durable-step/test/round-0-baseline.test.ts`,
raw output in `docs/notes/durable-step-rounds/round-0.txt`):

| #   | Finding                                                                                                                                                                                                             | Verdict                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Duration is attributable with zero author effort — `HandlerEvent.durationMs` is mandatory, stamped by `spawn()` itself                                                                                              | **pass, free**             |
| 2   | Spend has no vocabulary to attribute it _with_ — not merely unattributed by default, inexpressible                                                                                                                  | **fail, sharp**            |
| 3   | State-machine legality is a disconnected island — `machine.apply` and `spawn` don't know about each other; nothing forces a step to reference its own machine                                                       | **fail**                   |
| 4   | Migration's evidence gate expresses proof-of-completion only by contorting a phase-progression primitive into a fake two-phase spec per step, and the handler's own "success" is journaled before any evidence runs | **fail, sharp**            |
| 5   | Work between two declared steps is invisible by construction — nothing notices a bare `await` sitting between two `handler.invoke()` calls, let alone forbids it                                                    | **fail, the hardest case** |

**Headroom this picked round 1:** of the four fitness-question attributes,
duration is already free and the other three (spend, retry-from-budget,
proof) are all open, plus the structural gap (Finding 3/5) that makes state
declaration itself optional. State-machine fusion was the single highest-
leverage first move: it's the cheapest of the three closes (pure, sync,
already-shaped-for-composition) and it's the mechanism the "define before you
can run" decision names directly.

## Round 1

**Change.** `defineDurableStep(machine, spec, deps) -> HandlerSpec`. The
wrapped `run` reads current state, pre-flight refuses an illegal `eventType`
_before_ the author's `run` executes, and on success applies the transition,
CAS-commits it to a `StateStore`, and stamps `fromState`/`toState`/`event`
into the same journal entry the handler already writes.

**Hypothesis.** If state transitions are structurally required to resolve a
step's invocation, an illegal-state call becomes a typed pre-flight refusal
instead of a silent handler success, and every successful invocation's
journal entry carries an accurate transition triple with zero further
per-invocation author code — closing Finding 3 the same way duration closes
for free.

**Result.** Held. 3/3 tests pass
(`test/round-1-state-fusion.test.ts`, `round-1.txt`). One genuine friction
surfaced during implementation, not a bug: `DurableStepSpec` could **not**
cleanly `extends HandlerSpec` the way `ConnectorSpec` does, because `run`'s
`tools` parameter widens to carry `currentState`, and TypeScript checks
function properties contravariantly — an interface extension that narrows
`run`'s signature either violates the base or needs an unsound cast. Kept as
a sibling interface with matching field names instead of forcing a fit that
isn't there. This is itself a shape-fits data point: the _almost-fit_ is
honest, not a failure to paper over.

**Next.** Round 0's remaining three open items (spend, retry-from-budget,
proof) are still untouched; Finding 5's deep form (nothing forces
declaration at all) is also untouched — round 1 only made _declared_ steps'
transitions structural.

## Round 2

**Change.** `DurableStepSpec` gains a mandatory `spend: SpendPolicy`
(`spend.none()` / `spend.metered({ unit })`, mirroring `retry.none()` /
`cb.none()`'s "no non-decision" shape exactly). `run` gains
`tools.spend.record(amount)`. A `metered` step that completes without ever
calling `record()` is refused (`SPEND_UNACCOUNTED`) before its state
transition commits. Calling `record()` under `spend.none()` is refused
symmetrically (`SPEND_DECLARED_NONE_BUT_RECORDED`).

**Hypothesis.** The fitness question's sharper half asks whether an
unattributed cent is _expressible_, not just discouraged. If completion and
attribution are fused the way `@phyxiusjs/migration` fuses completion and
proof, a metered step cannot successfully finish without recording spend —
not "should," but structurally cannot.

**Result.** Held. 4/4 tests pass (`test/round-2-spend-attribution.test.ts`,
`round-2.txt`), including the sharp test itself: a step that "forgets" to
record its spend is refused outright, not silently shipped with a missing
number. The symmetry case (declared `none`, recorded anyway) is caught too —
a contradicted declaration is a bug in the step, and now behaves like one.

**Next.** Retry-from-budget (corpus item 2, `discipline-synthesis`) hasn't
been exercised by any round yet — it's the only fitness attribute tied to a
real prior outage, and the corpus is ordered with it explicitly as "the
budget case."

## Round 3

**Change.** `DurableStepDeps` gains a mandatory `retryLedger: RetryLedger`
(`createRetryLedger(totalExtraAttempts)` — an atomically-debited shared
pool). `defineDurableStep` always spawns the underlying handler with
`retry.none()` and runs its own `runWithRetry` loop inside the wrapped
`run`, capped to `1 + retryLedger.draw(spec.retry.maxAttempts - 1)` — the
step's own declared ceiling is a _request_; the ledger's remaining balance
is the _grant_.

**Hypothesis.** If every sub-step draws its extra attempts from one shared
ledger instead of declaring an independent policy, decomposing work into
more steps cannot mint more retry capacity — exactly the shape that produced
5,481 calls on 2026-08-06.

**Result.** Held, on the first run — the arithmetic traced by hand matched
the test output exactly. 3/3 tests pass
(`test/round-3-retry-conservation.test.ts`, `round-3.txt`). Three flaky
items sharing a ledger of 3 extra attempts: item A gets its full request (2
granted, 1 left), item B gets only 1 of its 2 requested (0 left, doesn't
recover), item C gets 0 (fails immediately, its own declared ceiling of 3
attempts never honored) — the shared pool decides, not the per-item ask.

**Honest friction, surfaced and reported, not hidden.** Moving retry into
this composition layer means the underlying handler is always spawned with
`retry.none()`, so `HandlerEvent.attempts` — the native field — reads `1`
for every invocation regardless of how many attempts the ledger actually
granted. The true count lives only in `observed.retryAttemptsUsed`. This is
exactly the shape of the ratified decision that conserving one retry budget
across nested handlers "may require a change in Phyxius itself" — round 3
proves the workaround is _viable_ at the composition layer, but it leaves a
native field lying by omission. That's a real substrate gap, not solved
here (see Closing synthesis, "What remains unknown").

**Next.** Proof-of-completion (Finding 4) is the last of the four named
fitness attributes still open.

## Round 4

**Change.** `DurableStepSpec` gains a mandatory `proof: EvidenceBag` —
reused verbatim from `@phyxiusjs/migration`, not reinvented. This required a
small, deliberate touch to migration itself: `createMigration`'s private
evidence-running logic (`runEvidence`/`runOneEvidenceSource`) was lifted out
to a new exported `runEvidenceBag(bag, { journalStore })` in a new
`evidence-runner.ts`, because a second caller (durable-step) needed the
exact same "run every source, collect Ok/failed/errored" behavior with zero
phase or CAS semantics attached. `createMigration` now calls this same
function — behavior for existing migration callers is unchanged (all 34
pre-existing migration tests still pass; 4 new direct tests cover
`runEvidenceBag` itself). After `run` succeeds and spend is accounted,
`spec.proof` runs; any failure or error refuses the step
(`PROOF_FAILED`/`PROOF_ERRORED`) _before_ the state transition commits.

**Hypothesis.** If `run` returning a value is necessary but not _sufficient_
— if the declared proof must also resolve `Ok` before the journal can say
success and the state can advance — a step's output claim and its evidence
become the same fact, closing the last of the four named fitness
attributes.

**Result.** Held. 4/4 tests pass
(`test/round-4-proof-of-completion.test.ts`, `round-4.txt`). The sharp test:
a step whose `run` returns a plausible receipt but whose declared proof
always fails is refused outright — the state never advances, the journal
never says success. An empty `proof: {}` is preserved as the explicit,
auditable "no proof needed" declaration (still journaled as an empty
snapshot, not silence).

**This is also the round that answers the merge-vs-compose question** — see
Closing synthesis.

**Next.** All four fitness-question attributes are now closed. What
remains is Finding 5's deep form: nothing yet stops an author from skipping
this whole composition for a phase of a durable action. That's not closeable
by one more spec field — it needed its own, differently-shaped move.

## Round 5

**Change.** `runClimb(name, deps, fn)` wraps a whole durable action. It
measures the climb's total wall time, queries the _same_ `JournalStore`
every `proof` evidence source already reads from — windowed to the climb's
own span — sums every declared step's `durationMs` inside that window, and
journals the delta as `unaccountedMs`.

**Hypothesis.** No composition can force an author to declare a step — a
bare `await` between two `handler.invoke()` calls is just JavaScript. But
the _gap itself_ is computable from data the journal already has:
`climb total − Σ(declared step durations)`. If a climb wrapper journals that
number automatically, "35 minutes total, 10 minutes of declared stages"
stops being silence and becomes `unaccountedMs: 1_500_000` — turning an
unknown-unknown into a known-unknown, even though the work inside that gap
stays opaque.

**Result.** Held, and reproduced corpus item 3's own numbers exactly: a
35-minute climb (25 invisible minutes + a 4-minute clone-equivalent stage +
a 6-minute extraction-equivalent stage) journals `accountedMs: 600_000`,
`unaccountedMs: 1_500_000`. 3/3 tests pass
(`test/round-5-climb-unaccounted-time.test.ts`, `round-5.txt`), including a
control case (a climb built entirely from declared steps journals exactly
`0` unaccounted).

**Explicit ceiling, not swept under the rug.** `unaccountedMs` names the
_size_ of the gap, never what happened inside it. It cannot say "a clone and
a file-level extraction ran here" — only "25 minutes of this climb are not
covered by any declared step." That's real, alertable information an
operator didn't have before, but it is not declaration, and this round does
not claim otherwise.

**Convergence.** Five rounds, budget spent, and each round closed something
the fitness question named directly — no round was manufactured motion.
Stopping here: the remaining open edge (forcing declaration itself) is a
different _kind_ of intervention — lint rule, orchestrator boundary, code
review — not a composition move these three packages can make on their own.

## Closing synthesis

### The fitness question's honest answer

**Duration** — yes, for free, since round 0; the handler already gives this
away. **Spend** — yes, as of round 2, and the sharp form: a metered step
that doesn't record its cost cannot complete. **Retry allowance from a
parent budget** — yes, as of round 3, with one disclosed friction (the
native `attempts` field goes stale). **Proof of completion** — yes, as of
round 4: a step's own return value is necessary but not sufficient anymore.
**Is an unattributed minute or cent expressible?** For a _declared_ step: no
longer — all three (spend, proof, and now duration/retry too) are refused
into non-existence rather than shipped silently. For time that never entered
a declared step at all: the _minute_ is now expressible (round 5's
`unaccountedMs`), but the _work_ inside it is not, and nothing in this
composition can make that untrue.

### Should state-machine and migration merge?

**No — compose, don't merge.** The argument, grounded in what round 4 built:

State-machine is pure, sync, and has genuinely no IO _by type_ — a
`TransitionFn` cannot await, cannot query anything, cannot fail for a reason
other than "no transition declared for this cell." That's what makes
`machine.can()` safe to call as a cheap pre-flight check, before spending any
real work (round 1's whole value: an illegal call never runs `spec.run` at
all). Migration's evidence machinery is the opposite by necessity — a
`journal-window` or `schema-applied` check is _inherently_ IO, because the
question it answers ("has this actually happened") can only be answered by
looking at the world, not by inspecting a type. Merging the two would force
one of them to lie: either the state machine gains async escape hatches and
loses the guarantee that makes it trustworthy without mocks, or the evidence
engine pretends synchronicity it can't have. `defineDurableStep` needs
_both_, run at different points in the same invocation, for different
reasons — `can()` before `run()`, evidence after — and that two-phase,
two-epistemic-mode shape is exactly what a merged primitive would have to
collapse.

**What the repo owner's "a lot of overlap" instinct was actually pointing
at, and got right:** not the packages, but one concept buried inside
migration's phase-CAS internals — "run a bag of evidence sources and collect
Ok/failed/errored" — that had zero dependency on phase advancement or CAS at
all. That's PHYXIUS_CODEX's own documented shape-fits outcome #2 (the
substrate is missing a concept — lift it, both layers get stronger), not
outcome #3 (orthogonal, leave alone) and not "merge the packages." Migration
now calls the exact same `runEvidenceBag` durable-step calls; migration's
own 34 pre-existing tests are the proof nothing about its behavior changed
in the lift.

### What the shape turned out to be

```
DurableStepSpec  =  HandlerSpec-shaped fields
                  + eventType / toEvent          (state-machine's event, statically named)
                  + spend: SpendPolicy            (new — didn't exist before this run)
                  + proof: EvidenceBag             (migration's evidence, reused verbatim)

defineDurableStep(machine, spec, deps) -> HandlerSpec
  run = pre-flight can() check
      → spec.run, retried against a shared RetryLedger
      → spend accounted (metered ⇒ must record; none ⇒ must not)
      → proof run via runEvidenceBag (must all resolve Ok)
      → machine.apply() + StateStore CAS commit
      → fromState/toState/event/spend*/retry*/proofSnapshot stamped into the SAME journal entry
```

Plus `runClimb`, a thin wrapper answering the one question no per-step
primitive could: how much of this durable action wasn't covered by any of
them.

### What remains genuinely `unknown`

- Whether `runEvidenceBag`'s permanent home should be inside
  `@phyxiusjs/migration` (where this round left it, the minimal move) or a
  new independent primitive now that a second consumer exists. A third
  consumer would likely settle it; not manufactured here.
- Whether the retry-ledger's friction on `HandlerEvent.attempts` needs an
  actual Phyxius core change (an attempts-transparent hook, or a policy
  shape that isn't a flat `maxAttempts`) — this round proves the composition
  workaround _works_, not that it's where the concept should permanently
  live.
- Whether Finding 5's deep form (declaration itself isn't mandatory) is
  addressable by _any_ library-level composition, or whether it's
  irreducibly a tooling/process problem (lint rule, orchestrator boundary
  that only accepts `DurableStepSpec`s, code review). Not resolved either
  way here.
- Fleet/multi-process semantics for the two new stores this round
  introduced (`StateStore`, `RetryLedger`) — both are in-memory references
  only, same horizon note PHYXIUS_CODEX already carries for migration's own
  `PhaseStore`/`JournalStore`.

### What I found wrong in the premise

The brief's description of `@phyxiusjs/handler` — "the runtime owns
timeout, retry, circuit-breaking per call" — doesn't match the current
code. There is no separate `runtime.execute()` layer: `@phyxiusjs/handler`'s
own `spawn()` owns concurrency, backpressure, timeout, retry, _and_
circuit-breaking directly, all inside one package's `runInvocation`. The
`runtime` parameter passed to `spawn()` is just `{ clock, journal,
idGenerator?, includeExtra? }` — it holds no execution logic at all. This
reads like a description of an earlier, more layered architectural
iteration (adapter → handler → separate runtime.execute → user code) that
the actual package has since consolidated into two layers. Worth a
correction wherever that description lives outside this repo.

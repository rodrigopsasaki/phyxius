# PHYXIUS CODEX

> _"Phyxius is an epithet of Zeus. It means 'the god who gives escape'. To flee from flaky systems, to take refuge from opaque ones. You, running full steam ahead on that maze — I think there may be another way."_

---

## Table of contents

- [I. What this is](#i-what-this-is)
- [II. The invariants the substrate enforces](#ii-the-invariants-the-substrate-enforces)
- [III. What's actually built](#iii-whats-actually-built)
- [IV. How this is packaged](#iv-how-this-is-packaged)
- [V. What's honestly not there yet](#v-whats-honestly-not-there-yet)
- [VI. Earned principles](#vi-earned-principles)
- [VII. The horizon](#vii-the-horizon)

---

## I. What this is

A reliability substrate for TypeScript systems on Node.js.

Phyxius is a catalog of composable primitives that enforce production invariants structurally, plus a reference framework composition that wires them together. The core bet:

**You shouldn't be able to ship work that silently defaulted a stability decision.** Timeouts, retries, circuit breakers, concurrency limits, failure modes — all declared as values, all visible in the type, all carried on the same journal shape regardless of whether work enters your system through HTTP, a queue, a cron tick, a 3rd-party API call, or a schema migration.

It's not Express / Nest / Fastify. It's the substrate those would compete on if they'd been built for operators.

---

## II. The invariants the substrate enforces

Four structural invariants. The rest of the codebase is consequences of these.

### 1. No non-decision

Every stability field on a work-unit spec is required at the type level. You cannot ship a `defineHandler` call that silently defaulted a timeout, a retry, a breaker, or a concurrency shape. "No retry" is a value (`retry.none()`), not an absence. **This is structural, not rhetorical** — the type system refuses the code.

### 2. Every failure mode is a value

No throws cross primitive boundaries. Every work-unit produces a `Result<T, E>` where `E` is a discriminated union. Retry predicates narrow on it. Dashboards group by it. Pagers fire on specific variants. Failures are pattern-matchable, not vibes.

### 3. Time is injected

`Date.now()` and `setTimeout` live in exactly one place: `@phyxiusjs/clock/system-clock`. Every other timing decision flows through an injected `Clock`. A `ControlledClock` makes tests deterministic — no flaky backoff, no real timers, no race-condition flakes.

### 4. Transport-stable observability

One journal entry per invocation, same shape across every way work enters the system. HTTP, queue, cron, connector, migration — all produce `HandlerEvent`. One dashboard, one query layer, one alerting surface.

### The generative move: evidence as query

Load-bearing but discovered late: when a primitive needs to know "has X happened," the answer is never trust-based. It's a query the primitive runs against live substrate.

Migrations gate on evidence queries; the answer is _currently true_ or the transition doesn't happen. **"I checked three weeks ago" stops being a sentence that can be constructed**, because the check and the advance are the same action.

### The design test: shape-fits

Concretely: if a new primitive extends an existing primitive's shape naturally, the existing shape is right. If it doesn't, one of three things is true:

1. **The new primitive is wrong** — rework it.
2. **The substrate is missing a concept** — lift it into the substrate, both layers get stronger.
3. **They're legitimately orthogonal** — keep them so; don't force the extension.

The test is generative in all three outcomes. Each is useful information, and it keeps the substrate honest as it grows.

`ConnectorSpec extends HandlerSpec` cleanly. `MigrationSpec` almost-fit and revealed the fleet-store gap. Both were substrate wins.

---

## III. What's actually built

Three tiers, honestly labeled.

### Core primitives

Stable shape, battle-tested implementations.

- **`@phyxiusjs/clock`** — wall + monotonic time, `ControlledClock` for tests, `Budget` (deadline + AbortSignal as a value), sleep / deadline / interval with structured events.
- **`@phyxiusjs/atom`** — versioned observable state with CAS. Transactional, linearizable, bounded.
- **`@phyxiusjs/journal`** — bounded, ordered, append-only event log. Ring buffer — memory growth impossible by construction.
- **`@phyxiusjs/resource`** — acquire / use / release with guaranteed cleanup. Parallel + sequence compose lifecycles. Release errors never mask body errors.
- **`@phyxiusjs/process`** — lifecycle primitive. Start / stop / status / crash observation. Use for lifecycle coherence when you want it as a value. **Not an OTP-style supervisor** — Node is single-threaded, and that is not what this delivers.

### Work-unit primitives — the center of gravity

- **`@phyxiusjs/handler`** — the universal work-unit. Input/output validation, timeout, concurrency (with backpressure policy), retry, circuit breaker, observation fields — **all required**. `defineHandler` won't compile without them. Same spec runs behind HTTP today, a queue tomorrow, a cron tick next week, with identical stability guarantees and identical journal entries.
- **`@phyxiusjs/connector`** — 3rd-party integration. `ConnectorSpec extends HandlerSpec` + `provider` + `mapError`. Typed `ConnectorError` union (UNAUTHORIZED, FORBIDDEN, NOT_FOUND, VALIDATION, RATE_LIMITED, TIMEOUT, CONNECTION_ERROR, PROVIDER_ERROR). HTTP mapping helpers (`mapHttpStatus`, `mapFetchError`, `parseRetryAfter`).
- **`@phyxiusjs/migration`** — expand-and-contract as a typed value. Evidence-gated phase transitions. Wrong-until-proven-otherwise by construction. Evidence sources: `journalWindow`, `schemaApplied`, `attestation`.

### Supporting primitives

Composable building blocks.

- **`@phyxiusjs/context`** — typed `AsyncLocalStorage`. A scope is a value. Uses `Symbol.for` to share state across duplicate package installs — inherited from Vision's production-proven context pattern.
- **`@phyxiusjs/observe`** — typed field handles. `core` vs `extra` tiers, hot-reloadable at runtime. Snapshots into every journal entry.
- **`@phyxiusjs/handle`** — scoped observable handle. Low-level building block behind `Handler`.
- **`@phyxiusjs/drain`** — journal → sink pump with batching and per-entry filtering. Sink errors caught, never thrown.
- **`@phyxiusjs/stats`** — rolling p50/p95/p99 + error rate per handler, with edge-triggered threshold alerts. Poor-man's APM, bounded memory.
- **`@phyxiusjs/db`** — database boundary. Transaction-as-context (no prop-drilling), typed errors (`DEADLOCK`, `SERIALIZATION_FAILURE`, `UNIQUE_VIOLATION`, etc.), driver-agnostic. Ships with in-memory driver for tests.

### Utilities

Value-level building blocks.

- **`@phyxiusjs/fp`** — `Result<T, E>`, `Option<T>`, pattern-match, pipe. No throws as a value language.
- **`@phyxiusjs/validate`** — `Validator<T>` contract. Zod-compatible, framework-free.
- **`@phyxiusjs/retry`** — retry policies as values. `retry.none()`, `retry.fixed(...)`, `retry.exponential(...)`.
- **`@phyxiusjs/circuit-breaker`** — closed / open / half-open state machine with injected clock. `cb.none()` is a first-class decision.
- **`@phyxiusjs/temporal`** — clock-driven debounce / throttle. Deterministic in tests.
- **`@phyxiusjs/config`** — layered typed config with file-watching and first-wins precedence. Hot-reloadable.
- **`@phyxiusjs/strategy`** — pure named computation with shadow deployment. Primary + shadows for versioned rollouts. Mismatches are typed events.
- **`@phyxiusjs/state-machine`** — typed state machines. States are discriminated unions; transitions are strategies; the graph is the primitive.

### Adapters

How work enters the system, and how the DB boundary meets a real engine.

- **`@phyxiusjs/http`** — thin Node `http` adapter. Pure `handle(HttpRequest): Promise<HttpResponse>` core — testable without sockets. Every `HandlerError` mapped to a sensible HTTP status.
- **`@phyxiusjs/queue`** — broker-agnostic pull-based consumer. `MessageSource` contract, drop-in for SQS / Redis / Kafka. Every `HandlerError` mapped to ack / nack decisions. Memory reference source for tests.
- **`@phyxiusjs/scheduler`** — time-driven invocations. Pluggable `Schedule` values. Overlap / catchup / drift policies declared, none defaulted.
- **`@phyxiusjs/db-pg`** — Postgres driver for `@phyxiusjs/db`. Curated SQLSTATE → `DbError` mapping. The table is the real product.

### Framework — the convenience bow

- **`@phyxiusjs/framework`** — `createApp()` that wires Clock + Journal + Drain + Stats + Config and exposes `.route` / `.schedule` / `.consume` / `.use`. Every framework method is a documented composition. Transports are optional peer deps. Invariants pass through unchanged.

---

## IV. How this is packaged

Twenty-seven packages. **That's deliberate.**

This is not a framework with twenty-seven dependencies. It's a catalog of primitives, each usable independently, with one reference framework composition included. The publishing posture is "here are the building blocks — use them, test them, fork them, replace them." Each package is small, well-factored, and documented to stand on its own.

You can start at any level:

- **Day one:** `createApp()` and a working service.
- **Day two:** drop to `defineHandler()` + a transport when you outgrow the framework's defaults.
- **Day three:** compose primitives directly when you need something the components don't offer.

The breadth is respect for the reader's autonomy, not feature-list marketing. A fork of one package doesn't fork the whole system. An experiment on one primitive doesn't touch the others.

---

## V. What's honestly not there yet

Phyxius is opinionated. Opinionated only works if the claims match the code. Here's where the surface is narrower than a casual reading might suggest.

### Not built

- **LLM-enhanced operational summaries.** The journal's shape supports it, but no packages today produce those summaries.
- **Self-healing / automatic remediation.** Process gives lifecycle observation, not self-healing.
- **Fleet-backed stores.** `JournalStore` and `PhaseStore` interfaces exist; only memory implementations ship. Multi-process migration evidence needs Postgres / Datadog / CloudWatch adapters that don't exist yet.
- **Shadow-diff evidence variant.** Designed (`shadowDiff` composes onto `journalWindow` plus strategy-event wiring), not implemented.
- **Provider-specific connectors.** The primitive exists; Stripe / Slack / OpenAI / Twilio implementations don't.
- **OTP-style supervision.** Node is cooperatively scheduled; real actor supervision isn't possible here in the way Erlang does it. `Process` gives lifecycle observation, not actor semantics.

### Narrower than the language might imply

- **"Budget-bounded" still requires cooperation.** The handler declares a `Budget` (deadline + AbortSignal) and threads the signal into `run`. Honoring it is **cooperative** — Node has no preemption. User code that doesn't pass `signal` into `fetch` / streams / subprocess won't be interrupted when the deadline expires. The substrate gives you the budget; user code has to honor it. We use "budget" in conceptual prose for this reason; "timeout" is reserved for the API field name and the `TIMEOUT` outcome variant.
- **"Race conditions eliminated by construction."** Atom / Journal / Process eliminate races at primitive boundaries. User code that composes primitives incorrectly can still race.
- **"Resource leaks cannot happen."** The Resource primitive guarantees cleanup **if used**. Code that doesn't wrap acquisitions can still leak.

These aren't bugs. They're the honest boundary of what the substrate enforces versus what user-code discipline still owns. Calling it out matters — a promise the code doesn't deliver is how a project loses credibility.

---

## VI. Earned principles

The principles that actually drive the project, grounded in what the code does.

### 1. Correctness over convenience

A foot-gun dressed as convenience isn't convenient. We refuse to ship defaults that let users skip stability decisions. The discomfort of an explicit `retry.none()` is cheaper than the cost of accidental missing retries in production.

### 2. Composition over configuration

Small primitives you assemble. No framework lifecycle, no global registry, no surprise behavior. `createApp` is a composition, not a container. Every framework method is a documented wiring — the source reads as "here's how you'd have written it by hand."

### 3. The substrate teaches itself

When a new primitive fits the existing shape cleanly, the substrate is right. When it almost-fits, the substrate is one concept short of what it wanted to be — and the fix is to lift the missing concept into the substrate, not to force the extension. This has happened twice so far (Connector, Migration). Each made the whole system stronger.

### 4. Built for ourselves first

Express integration is a non-goal. Framework compatibility is a non-goal. Mass adoption is a non-goal. We build for the operators we've been. If those abstractions also serve others, good — but we don't write a single line thinking about hypothetical downstream users.

### 5. Don't claim what you haven't built

Versions of this codex used to claim LLM-enhanced ops, self-healing systems, the death of Datadog, and race-free concurrency by construction. Some of those are directional; some are marketing bravado; none belong in a document that describes the system. This version separates the earned from the aspirational, and labels the seam clearly.

### 6. `HandlerError` stays infrastructure-shaped

The `HandlerError` union describes how **the substrate failed to deliver a result**: `TIMEOUT` (budget expired), `BACKPRESSURE_REJECT` (queue full), `CIRCUIT_OPEN` (breaker tripped), `RETRY_EXHAUSTED` (all attempts spent), `HANDLER_NOT_RUNNING` (lifecycle), `HANDLER_ERROR` (run threw), `VALIDATION_ERROR` (input or output failed validation), `DROPPED` (backpressure policy dropped this work).

**Domain outcomes don't belong here.** Payment declined, account suspended, inventory unavailable, user not found — these are part of `TOutput`, expressed as a domain-specific `Result<Success, DomainFailure>` if the caller needs to pattern-match on them. They are not `HandlerError`.

The line is load-bearing. The discriminated `HandlerError` union is what makes retry policies deterministic, dashboards groupable, and pagers fire on the right things. If domain failure modes start migrating into it, the union becomes a junk drawer and every downstream consumer gets fuzzier.

A simple test: **would the substrate take a different action depending on this failure mode?** Retry, hold the breaker open, route to DLQ, abort the invocation cleanly. If yes, it might belong in `HandlerError`. If the only consumer is application code that knows what to do, it belongs in `TOutput`.

The same line applies to `ConnectorError`: it describes how the **provider** failed (`UNAUTHORIZED`, `RATE_LIMITED`, `PROVIDER_ERROR`), not what the provider's domain answer was. "Stripe charge declined" is a connector success that returned a domain failure, not a `ConnectorError`.

---

## VII. The horizon

Not promises. Not roadmap. Honest directions the substrate is pointing.

- **Fleet-backed stores** for migrations — `@phyxiusjs/migration-pg` is the first target. Postgres row-level CAS for `PhaseStore`, a `phyxius_events` table for `JournalStore`. v0.2 of migration.
- **Shadow-diff evidence variant** — ~30 lines of helper over `journalWindow` + a small strategy-package addition to wire its events into the handler journal. ~3-4 hours of focused work. Unlocks fully-automatic versioned rollouts.
- **Provider-specific connectors** — Stripe, Slack, OpenAI, Twilio. Each is a curated observability product for that provider, layered on the HTTP mapping helpers.
- **Fleet-aware primitives** — once `JournalStore` / `PhaseStore` exist, distributed circuit breakers, fleet-wide rate limits, and feature flags with evidence gating all compose naturally onto them. One pattern, multiple applications.
- **LLM-assisted incident narration** — the journal's shape is already right for it. Needs a consumer that reads the event stream and produces summaries. Open question whether it ships as a Phyxius package or as a separate tool.

The discipline: build the fleet-store abstractions when the migration primitive actually needs them at scale. Build the provider connectors when a real use case demands one. Build the LLM narrator when someone's willing to operate it in production.

The substrate is proving itself. The rest is patience.

---

_"The god who gives escape."_ Deliverance from the assumption that software must be painful, unreliable, and opaque — when the invariants are right and the primitives are small, it doesn't have to be.

---

**Document version:** 2.0
**Last updated:** 2026-04-24
**Scope:** What Phyxius currently is. What it is not. Where it's pointing.

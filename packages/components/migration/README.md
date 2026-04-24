# Migration

Evidence-gated schema and infrastructure migrations. Expand-and-contract as a typed value, with transitions that refuse to happen until the evidence is structurally produced.

---

## What this really is

The pattern everyone knows and nobody finishes.

**Expand-and-contract** is how you evolve a system safely: add the new thing (expand), make writes go to both old and new (dual-write), flip reads to the new, remove the old (contract). Every serious migration — renaming a column, swapping a queue, splitting a table, moving between providers — is this pattern. Everyone's seen it. Everyone's been burned by the half-finished version: "we'll drop the old column next sprint," and three months later the column is still there because nobody remembers whether it's safe.

The reason isn't that people don't know the pattern. It's that **the verification step between phases is trust-based and time-diffuse**. You checked the dual-write was matching, once, three weeks ago. You meant to check the old path was unused, but the query is ad-hoc and you never ran it. The pattern's correctness depends on vigilance that's not actually structural.

This package fixes that. Transitions require **evidence** — a typed, currently-valid, structurally-produced value — and the primitive refuses to advance without it. The halfway-state that used to be a memorized checklist stops being possible, because the type system and the runtime both demand proof.

---

## The load-bearing move: evidence as query, not evidence as data

The single most important thing about this primitive is that **evidence is not a parameter you pass in**. It's a query the primitive runs against live substrate every time you call `advance()`.

The weak version of "typed evidence" looks like this (**don't do this**):

```ts
// Trust-based — the snapshot is stale the moment it's taken.
await migration.advance({ writeParity: snapshotIJustTook });
```

The strong version, which is what this package does:

```ts
// The phase declares its evidence as queries. advance() runs them now.
await migration.advance();
```

The migration's phase type names the queries the next transition requires. `advance()` runs them. If they all produce `Ok`, the transition commits. If any produce `Err`, or throw, or time out, or return the wrong shape — the transition **doesn't happen**. The phase stays where it is. There is no parameter to fake and no cached "I already checked" path to shortcut.

That's the trick that makes "I checked three weeks ago" stop being a sentence you can construct — the check and the advance are the same action.

---

## Wrong-until-proven-otherwise

The primitive's core invariant:

**`advance()` transitions only if the next phase's evidence bag produces `Ok` for every declared source. Every other outcome — predicate returns `Err`, check throws, store unreachable, query times out, CAS lost to another caller — leaves the phase where it is.**

The failure mode "migration advanced when it shouldn't have" (data corruption, split state) is **structurally impossible**. The failure mode "migration didn't advance when it should have" (delay) is the one you can have. Between those two, you picked the survivable one.

Same structural invariant as the handler's required-stability fields, one layer up.

---

## Installation

```bash
npm install @phyxiusjs/migration @phyxiusjs/clock @phyxiusjs/journal @phyxiusjs/handler @phyxiusjs/fp
```

---

## Quick start

```ts
import { createSystemClock, ms, type Millis } from "@phyxiusjs/clock";
import { ok, err } from "@phyxiusjs/fp";
import { Journal } from "@phyxiusjs/journal";
import {
  attestation,
  createMemoryJournalStore,
  createMigration,
  defineMigration,
  journalWindow,
  schemaApplied,
} from "@phyxiusjs/migration";

const clock = createSystemClock();
const journal = new Journal({ clock });
const journalStore = createMemoryJournalStore({ journal, clock });

const quoteToSalesDocument = defineMigration({
  name: "quote-to-sales-document",
  phases: {
    expand: {
      evidence: {
        schemaReady: schemaApplied({
          check: async () => {
            const applied = await checkAlembicHead("0042_sales_documents");
            return applied ? ok({ revision: "0042" }) : err({ reason: "not at revision 0042" });
          },
        }),
      },
    },

    dualWrite: {
      evidence: {
        // TODO: shadow-diff evidence when the strategy integration lands.
        // For now, attestation — an engineer confirms the dashboards look right.
        parityVerified: attestation({
          check: async () => {
            const signed = await checkAttestationStore("quote-to-sales-document:dual-write-parity");
            return signed ? ok({ signer: signed.signer, at: signed.at }) : err({ reason: "not signed" });
          },
        }),
      },
    },

    flip: {
      evidence: {
        zeroLegacyReads: journalWindow({
          query: { name: "quote.read", outcome: "success" },
          windowMs: ms(14 * 24 * 60 * 60 * 1000) as Millis, // 14 days
          predicate: (events) =>
            events.length === 0
              ? ok({ count: 0 })
              : err({ reason: "saw legacy reads in window", details: { count: events.length } }),
        }),
      },
    },

    contract: {
      evidence: {
        zeroLegacyWrites: journalWindow({
          query: { name: "quote.write" },
          windowMs: ms(7 * 24 * 60 * 60 * 1000) as Millis,
          predicate: (events) =>
            events.length === 0
              ? ok({ count: 0 })
              : err({ reason: "saw legacy writes", details: { count: events.length } }),
        }),
      },
    },
  },
});

const running = createMigration(quoteToSalesDocument, { clock, journal, journalStore });

// ── Handler-side: read the live phase at dispatch time ────────────────────

async function processQuote(input: QuoteInput) {
  switch (await running.currentPhase()) {
    case "expand":
    case "dualWrite":
      await writeToBoth(input);
      break;
    case "flip":
    case "contract":
      await writeToNew(input);
      break;
  }
}

// ── Advance (called from a CLI / ops cron / dashboard button) ─────────────

const result = await running.advance();
if (result._tag === "Err") {
  console.log(`Refused: ${result.error.type}`);
  // The journal has the full audit: which evidence failed, why, at what time.
}
```

`advance()` is never automatic. It's a deliberate action taken by an operator (or a scheduled job) that _asks_ the primitive to transition. The primitive consults the evidence and decides.

---

## The three cases this primitive handles

Not every migration has the same requirements. Three cases, only one of which needs fleet-backed infrastructure:

### 1. Single-process migration

The journal is the fleet. Evidence queries read the in-process journal. Works with `createMemoryJournalStore` out of the box.

Applies to: CLIs, batch jobs, small SaaS, internal tools, anything running at scale 1. _Most migrations you'll ever write._

### 2. Migration between external services

Source and destination are already third-party (SQS → Kafka, Postgres → DynamoDB, Redis → Memcached). Evidence queries the providers through connectors:

```ts
evidence: {
  zeroSqsReads: journalWindow({
    query: { name: "sqs.consume", where: (e) => e.observed.queueUrl === LEGACY_QUEUE },
    windowMs: ms(14 * 24 * 60 * 60 * 1000) as Millis,
    predicate: (events) =>
      events.length === 0 ? ok(undefined) : err({ reason: "still consuming legacy queue" }),
  }),
}
```

No fleet-store infrastructure needed — the evidence is in **your** journal (what this system did), filtered by the queue URL the connector recorded. Every connector call already writes a journal event; you're just asking about the absence of a specific kind.

This case is the underrated one. **No framework today has a primitive for "migrate between external services with evidence-gated transitions."** The pattern exists everywhere, in runbooks and spreadsheets and on-call rotations — never in code.

### 3. Multi-process migration where evidence is this system's own activity

"No handler in this fleet wrote to `legacy_users` in the last 14 days" — the fleet is the thing producing the evidence, and each container only sees its own slice.

**This case needs a fleet-backed `JournalStore`** (Postgres, Datadog, CloudWatch, wherever your drain sinks to). The in-memory store would silently pass because each container only knows its own traffic.

The v0.1 package ships the interface and the memory reference. Fleet-backed adapters (`@phyxiusjs/migration-pg`, etc.) come in v0.2. The migration primitive itself doesn't change — only which store you pass in.

---

## The evidence union

Closed. Three variants in v0.1. Each has a clear handler-policy analogue: one place the evidence comes from, one way to satisfy it.

```ts
type EvidenceSource<T> = JournalWindowEvidence<T> | SchemaAppliedEvidence<T> | AttestationEvidence<T>;
```

| Variant          | Helper            | Good for                                                               |
| ---------------- | ----------------- | ---------------------------------------------------------------------- |
| `journal-window` | `journalWindow()` | "Did / didn't we do X in the last N days." The most powerful variant.  |
| `schema-applied` | `schemaApplied()` | "DDL ran, migration row exists, Alembic head is at revision X."        |
| `attestation`    | `attestation()`   | "Human signed off" — legal review, security approval, ops attestation. |

Each one produces `Result<T, EvidenceFailure>`. The `T` is your payload of "what did we learn" — a count, a revision string, an attester's name — and it ends up in the journal entry's `observed` snapshot for audit.

### `journalWindow` is the workhorse

```ts
journalWindow({
  query: {
    name?: string;
    outcome?: "success" | "failure";
    where?: (event: HandlerEvent) => boolean;
    limit?: number;
  },
  windowMs: Millis,
  predicate: (events: readonly HandlerEvent[]) => Result<T, EvidenceFailure>,
})
```

The predicate is where the claim lives. Canonical shapes:

- **"Nothing happened":** `events.length === 0 ? ok(undefined) : err({...})`.
- **"Every event carried the new field":** `events.every((e) => e.observed.newField !== undefined)`.
- **"Divergence rate is below threshold":** compute the ratio and compare.

Arbitrary logic over structured `HandlerEvent` data. No DSL, no query builder — just a function.

### `shadowDiff` is coming

`shadow-diff` isn't in v0.1 yet — it needs real integration with `@phyxiusjs/strategy` and a half-day of design that's separate from the migration shape itself. For now, express "write parity verified" as an `attestation` (which uses whatever process you already have for reviewing shadow-strategy dashboards) until the dedicated variant lands.

---

## Runtime — `currentPhase()` is a live query

Handlers read the current phase at dispatch time, not at startup. Flipping a phase is atomic (CAS against the `PhaseStore`), and the very next request sees the new phase. No coordinated rollout, no feature-flag indirection:

```ts
run: async (input) => {
  const phase = await running.currentPhase();
  return phase === "flip" || phase === "contract" ? writeToNew(input) : writeToBoth(input);
};
```

That's the payoff. The Atom-backed phase is a runtime value, same category as the clock — something handlers query when they need to know "what state is the world in right now."

---

## Journal entries — the audit trail

Every `advance()` call — success or refusal — writes a `HandlerEvent` to the journal with `source: "migration"` and `name: "migration.<spec.name>.advance"`. The `observed` bag carries:

- `migration` (the spec name)
- `from` (the phase we were at)
- `attempted` (the phase we tried to advance to)
- `snapshot` (the evidence payload, on success)
- `refusal` (the typed refusal, on failure — `{ type, message }`)

Three months later, your journal answers "how did this migration get to `contract`?" by returning a sequence of advance events with their evidence snapshots. The "we'll finish this later" failure mode isn't possible because "later" doesn't produce a journal entry.

---

## Stores

### `JournalStore` — the read side

```ts
interface JournalStore {
  query(q: JournalQuery, windowMs: Millis): Promise<readonly HandlerEvent[]>;
}
```

The migration primitive's `journal-window` evidence reads through this interface. For single-process or scale-1 use, `createMemoryJournalStore({ journal, clock })` reads the in-process journal directly.

For multi-process production:

- Your drain sinks to a shared store (Postgres table, Datadog, CloudWatch, Loki — whatever).
- A `JournalStore` adapter reads back from that store.
- The migration queries through the adapter; its data covers the whole fleet.

Adapter packages (`@phyxiusjs/migration-pg`, etc.) are v0.2.

### `PhaseStore` — the write side

```ts
interface PhaseStore {
  current(): Promise<string>;
  tryAdvance(
    from: string,
    to: string,
    evidence: EvidenceSnapshot,
  ): Promise<Result<{ at: Instant }, { actual: string }>>;
}
```

Defaults to an in-process atom wrapper — single-process-safe because JavaScript is single-threaded. Fleet deployments pass a store backed by Postgres row-level CAS, Redis WATCH/MULTI, or similar.

---

## Error shapes

Never throws. Every refusal is a typed value:

```ts
type AdvanceError =
  | { type: "ALREADY_AT_FINAL"; phase: string }
  | { type: "EVIDENCE_FAILED"; attemptedPhase: string; failures: Record<string, EvidenceFailure> }
  | { type: "EVIDENCE_ERRORED"; attemptedPhase: string; errors: Record<string, unknown> }
  | { type: "CAS_LOST"; expected: string; actual: string };
```

Pattern-match to decide what to do:

```ts
const result = await running.advance();
if (result._tag === "Err") {
  switch (result.error.type) {
    case "ALREADY_AT_FINAL":
      console.log("Migration complete.");
      break;
    case "EVIDENCE_FAILED":
      console.log(`Evidence didn't pass: ${Object.keys(result.error.failures).join(", ")}`);
      // Caller inspects the failures record for specific `reason`/`details`.
      break;
    case "EVIDENCE_ERRORED":
      console.log(`Evidence check errored — probably infra. ${Object.keys(result.error.errors).join(", ")}`);
      // Usually worth alerting on. The store might be down.
      break;
    case "CAS_LOST":
      console.log(`Another caller won the race. Current phase: ${result.error.actual}`);
      // Typically retryable: read current phase, decide if you still want to advance.
      break;
  }
}
```

---

## Testing

Deterministic by construction. `createControlledClock` + `createMemoryJournalStore` give you the full evidence-check machinery without any real infrastructure:

```ts
import { createControlledClock, type Millis } from "@phyxiusjs/clock";
import { ok, err } from "@phyxiusjs/fp";
import { Journal } from "@phyxiusjs/journal";
import { createMemoryJournalStore, createMigration, defineMigration, schemaApplied } from "@phyxiusjs/migration";

const clock = createControlledClock({ initialTime: 0 });
const journal = new Journal({ clock });
const journalStore = createMemoryJournalStore({ journal, clock });

const spec = defineMigration({
  /* ... */
});

// Simulate "evidence not yet satisfied"
const running = createMigration(spec, { clock, journal, journalStore });
const refused = await running.advance();
expect(refused._tag).toBe("Err");

// Simulate the data conditions that would produce Ok evidence, then advance again.
journal.append(/* ... events that make the predicate happy ... */);
const advanced = await running.advance();
expect(advanced._tag).toBe("Ok");
```

A migration spec is a pure value; a migration runtime has clock + journal + store injected; every behavior is exercisable from a test. The `happy path` isn't a mock-success; it's "set up the data that would produce evidence, run advance, observe it succeed." That's a more honest test than stubbing a store.

---

## What this does NOT do

- **No fleet-backed `JournalStore` / `PhaseStore` implementations.** Cases 1 and 2 work with the memory references; case 3 ships in v0.2 (`@phyxiusjs/migration-pg` is the obvious first target).
- **No `shadow-diff` evidence variant.** Needs `@phyxiusjs/strategy` integration and a half-day of design. Use `attestation` for shadow-parity claims until it ships.
- **No rollback.** Migrations are forward-only. "Rolling back" is a new migration in the reverse direction, with its own evidence. This is deliberate — a "rollback" concept introduces the symmetrical class of bugs we're eliminating.
- **No auto-advance.** `advance()` is always an explicit call. A continuous watcher that auto-promotes when evidence is satisfied could be built on top, but the primitive itself is manual-advance by design — it's one less hidden failure mode to reason about.
- **No dependency graph between migrations.** `migrationA.blocksUntil(migrationB.phase === "flip")` is a natural v0.3 addition but not day-one.

---

## What you get

- **Expand-and-contract, as a typed value.** The pattern everyone knows becomes the pattern whose halfway-states can't exist.
- **Evidence as a query.** Nothing advances without structurally produced proof. "I checked three weeks ago" stops being expressible.
- **Wrong-until-proven-otherwise by construction.** Every failure mode of an evidence query leaves the phase where it is. Data corruption from false-positive advances is structurally impossible.
- **Live-queryable phase.** Handlers branch on `currentPhase()` at dispatch time. Transitions are atomic. The next request sees the new state.
- **Transport-stable audit.** Every advance attempt (success or refusal) produces a journal entry with the evidence snapshot or refusal details. Same shape as every other Phyxius event.
- **AI-safe.** An AI asked to "advance quoteToSalesDocument from dualWrite to flip" cannot make a mistake, because the type demands a `zeroLegacyReads` evidence value and no shortcut produces one. Different canvas, different outcome, same AI — the structural discipline that made handler stability AI-safe, applied to schema evolution.

The migration primitive is small because the work it does is narrow: declare phases, demand evidence, refuse or transition. Everything that could vary per-deployment — which store, which kinds of checks, which rollout cadence — is a compose-in choice.

It's the discipline that turns "senior engineer's memorized checklist" into "a value whose phase has a type-checked answer."

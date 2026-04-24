import type { Instant, Millis } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { HandlerEvent } from "@phyxiusjs/handler";

// ── Evidence — the typed vocabulary for "can we advance" ────────────────────

/**
 * Why an evidence query didn't produce an `Ok` result. Every evidence
 * failure must be a structured value, not a thrown exception — the whole
 * point of the primitive is that "couldn't prove it" is a legible
 * outcome, not an error.
 */
export interface EvidenceFailure {
  readonly reason: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * A structured query against the journal. The store implementation decides
 * how to translate this to its storage substrate (in-memory scan, SQL,
 * Datadog query DSL, etc.); every adapter ships a conformance test that
 * proves it honors the semantics:
 *
 *   - Events returned are those whose `completedAt.wallMs` falls within
 *     the query's window, from the caller's perspective of `Clock.now()`.
 *   - `name` filters to an exact match. Case-sensitive.
 *   - `outcome` filters to `"success"` or `"failure"`.
 *   - `where` is an arbitrary predicate applied after name/outcome.
 *   - `limit` is an upper bound; implementations may return fewer.
 *
 * The predicate form is load-bearing: it lets callers express
 * domain-specific checks ("every order.create had observed.salesDocumentId
 * set") without the store needing to understand those fields.
 */
export interface JournalQuery {
  readonly name?: string;
  readonly outcome?: "success" | "failure";
  readonly where?: (event: HandlerEvent) => boolean;
  readonly limit?: number;
}

/**
 * Evidence sourced from a journal window. The predicate runs against the
 * events the store returns and either accepts (`Ok`) or rejects (`Err`)
 * with a structured failure.
 *
 * The canonical use: "no handler wrote to `legacy_table` in the last 14
 * days." You express that as a predicate on `events.length === 0` (or
 * stronger — assert on `observed` fields inside the predicate).
 */
export interface JournalWindowEvidence<T = unknown> {
  readonly type: "journal-window";
  readonly query: JournalQuery;
  readonly windowMs: Millis;
  readonly predicate: (events: readonly HandlerEvent[]) => Result<T, EvidenceFailure>;
}

/**
 * Evidence that a schema migration (DDL, Alembic revision, migrations
 * table row) has actually been applied. The check runs wherever the
 * schema lives — typically a `SELECT` against a migrations table or a
 * `pg_catalog` introspection.
 *
 * The check returns a `Result` so transient errors (DB down, permission
 * denied) are expressible without a throw crossing into the advance path.
 */
export interface SchemaAppliedEvidence<T = unknown> {
  readonly type: "schema-applied";
  readonly check: () => Promise<Result<T, EvidenceFailure>>;
}

/**
 * Evidence in the form of a named attestation — a human signoff, an
 * out-of-band verification. Still trust-based, but *named* trust: with a
 * principal, a timestamp, a trail. Use sparingly; journal-window and
 * schema-applied are preferred when the evidence can be queried.
 */
export interface AttestationEvidence<T = unknown> {
  readonly type: "attestation";
  readonly check: () => Promise<Result<T, EvidenceFailure>>;
}

/**
 * The closed union of evidence sources. Every variant has a handler-policy
 * analogue — one place the evidence comes from, one way to satisfy it.
 *
 * Adding a new variant is a deliberate substrate change. If you feel the
 * pull to add one, first check whether it could be expressed as a
 * `journal-window` predicate or an `attestation` check — those two cover
 * a surprising range.
 */
export type EvidenceSource<T = unknown> = JournalWindowEvidence<T> | SchemaAppliedEvidence<T> | AttestationEvidence<T>;

/**
 * A named bag of evidence sources. The keys are human-facing labels —
 * they appear in failure reports and journal entries, so name them after
 * the claim being proven (`"writeParity"`, `"zeroLegacyReads"`) rather
 * than the mechanism (`"shadowDiff"`, `"journalQuery"`).
 */
export type EvidenceBag = Readonly<Record<string, EvidenceSource>>;

/**
 * Per-evidence result of an advance attempt. Keyed by the same labels
 * as the `EvidenceBag`. Stored on the journal entry for audit.
 */
export type EvidenceSnapshot = Readonly<Record<string, unknown>>;

// ── Phase and migration spec ────────────────────────────────────────────────

/**
 * A phase is a named rest-state in the migration. To *leave* this phase —
 * to advance into the next one — the migration runs the *next* phase's
 * evidence queries and demands they all resolve `Ok`.
 *
 * The first phase's evidence is still declared (some migrations want a
 * pre-start attestation: "Alice signed off before we begin"); an empty
 * evidence bag is valid for phases that advance freely — often the final
 * `contract` phase, which has nothing to prove because it's terminal.
 */
export interface PhaseSpec {
  readonly evidence: EvidenceBag;
}

/**
 * The declared migration value. Phases are an ordered object — object key
 * order is insertion order in JavaScript, and that order is the phase
 * progression. Two phases minimum (otherwise there's nothing to migrate
 * between).
 */
export interface MigrationSpec<
  TPhases extends Readonly<Record<string, PhaseSpec>> = Readonly<Record<string, PhaseSpec>>,
> {
  readonly name: string;
  readonly phases: TPhases;
}

/** The phase names of a spec, as a string-literal union. */
export type PhaseName<TSpec extends MigrationSpec> = keyof TSpec["phases"] & string;

// ── Advance outcomes ────────────────────────────────────────────────────────

/**
 * Successful advance. The journal entry written by `advance()` also
 * carries these fields so later queries can reconstruct "how did we get
 * here" without the caller keeping its own log.
 */
export interface Advanced<TSpec extends MigrationSpec = MigrationSpec> {
  readonly from: PhaseName<TSpec>;
  readonly to: PhaseName<TSpec>;
  readonly evidence: EvidenceSnapshot;
  readonly at: Instant;
}

/**
 * Why an advance didn't happen. Each variant is legible and auditable —
 * the point of wrong-until-proven-otherwise is that refusing to advance
 * is structured, not silent.
 *
 * - `ALREADY_AT_FINAL`: called `advance()` at the terminal phase. Not an
 *   error, per se, but a refusal worth observing.
 * - `EVIDENCE_FAILED`: one or more evidence predicates returned `Err`.
 *   The next phase didn't prove itself; stay put.
 * - `EVIDENCE_ERRORED`: an evidence source threw or timed out — store
 *   unreachable, schema check blew up, attestation service down. Same
 *   outcome: stay put.
 * - `CAS_LOST`: the phase-store's compare-and-set failed because another
 *   caller won the race. The evidence passed; we just weren't the one to
 *   advance.
 */
export type AdvanceError =
  | { readonly type: "ALREADY_AT_FINAL"; readonly phase: string }
  | {
      readonly type: "EVIDENCE_FAILED";
      readonly attemptedPhase: string;
      readonly failures: Readonly<Record<string, EvidenceFailure>>;
    }
  | {
      readonly type: "EVIDENCE_ERRORED";
      readonly attemptedPhase: string;
      readonly errors: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "CAS_LOST";
      readonly expected: string;
      readonly actual: string;
    };

// ── Running migration ───────────────────────────────────────────────────────

export interface RunningMigration<TSpec extends MigrationSpec = MigrationSpec> {
  readonly name: string;

  /**
   * The current phase. Reads through the `PhaseStore`, so callers always
   * see the freshest committed value. Handlers can call this at dispatch
   * time to branch on the active phase — same way they read the clock.
   */
  currentPhase(): Promise<PhaseName<TSpec>>;

  /**
   * Attempt to advance to the next phase. Runs every evidence source on
   * the next phase's `evidence` bag; if all produce `Ok`, CAS-updates the
   * phase and writes a journal entry with the evidence snapshot. If any
   * produce `Err` or throw, refuses with a structured `AdvanceError`.
   *
   * Never throws. Never advances more than one phase per call — if you
   * need to jump two phases, call twice (and the intermediate phase's
   * evidence must still be satisfied).
   */
  advance(): Promise<Result<Advanced<TSpec>, AdvanceError>>;
}

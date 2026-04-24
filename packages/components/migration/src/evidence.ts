import type { Millis } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { HandlerEvent } from "@phyxiusjs/handler";

import type {
  AttestationEvidence,
  EvidenceFailure,
  JournalQuery,
  JournalWindowEvidence,
  SchemaAppliedEvidence,
} from "./types.js";

// ── Helpers for constructing evidence sources ──────────────────────────────
//
// These are deliberately thin constructors — the point is that the types
// in `types.ts` are the real artifact, and these helpers just make the
// call sites readable. Users can construct evidence values directly from
// the types if they want; these exist so that the common shapes have a
// short, obvious form.

/**
 * Evidence: "run a structured query against the journal store over a time
 * window, and a predicate over the results must produce `Ok`."
 *
 * The predicate is where the claim actually lives. `events.length === 0`
 * is the canonical "nothing happened" check, but the richer cases use
 * `events.every(...)` against `observed` fields to assert "every
 * invocation carried the new field."
 */
export function journalWindow<T = undefined>(args: {
  query: JournalQuery;
  windowMs: Millis;
  predicate: (events: readonly HandlerEvent[]) => Result<T, EvidenceFailure>;
}): JournalWindowEvidence<T> {
  return { type: "journal-window", ...args };
}

/**
 * Evidence: "a schema check — migrations table row, DDL introspection,
 * Alembic head — resolves `Ok`." The check is a function so implementations
 * can hit the database, introspect a file system, shell out to a tool,
 * whatever.
 */
export function schemaApplied<T = undefined>(args: {
  check: () => Promise<Result<T, EvidenceFailure>>;
}): SchemaAppliedEvidence<T> {
  return { type: "schema-applied", check: args.check };
}

/**
 * Evidence: "a named attestation exists." Still trust-based — the
 * attestation source decides what it means — but the trust is scoped,
 * timestamped, and auditable because the attestation record lives in the
 * same journal as everything else.
 *
 * Use sparingly. If the claim can be expressed as a journal window query
 * or a schema check, prefer those. Attestations are for decisions that
 * genuinely require a human signoff (legal review, security approval).
 */
export function attestation<T = undefined>(args: {
  check: () => Promise<Result<T, EvidenceFailure>>;
}): AttestationEvidence<T> {
  return { type: "attestation", check: args.check };
}

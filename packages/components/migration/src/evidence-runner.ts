import { isErr, type Result } from "@phyxiusjs/fp";

import type { JournalStore } from "./store.js";
import type { EvidenceBag, EvidenceFailure, EvidenceSnapshot, EvidenceSource } from "./types.js";

// ── runEvidenceBag — lifted out of `createMigration`, round-4 of the
//    2026-08-17 durable-step find-shape (docs/notes/2026-08-17-durable-step-
//    find-shape.md) ────────────────────────────────────────────────────────
//
// This was private to `migration.ts` until a second caller needed the exact
// same "run every evidence source, collect Ok/failed/errored" behavior
// without any phase or CAS semantics attached — `@phyxiusjs/durable-step`'s
// proof-of-completion gate. That's PHYXIUS_CODEX §II's "shape-fits" test,
// outcome 2: the substrate was missing a concept (evidence-running,
// independent of phase advancement), so it gets lifted here rather than
// duplicated. `createMigration` now calls this same function; behavior for
// existing migration callers is unchanged — this is a relocation, not a
// rewrite.

/** Per-evidence-bag run outcome: every source resolved, split into what succeeded, what failed, and what errored. */
export interface EvidenceRunResult {
  readonly snapshot: EvidenceSnapshot;
  readonly failures: Readonly<Record<string, EvidenceFailure>>;
  readonly errors: Readonly<Record<string, unknown>>;
}

/**
 * Run every evidence source in `bag` and collect the outcome. Never
 * throws — a source that throws is captured into `errors`, not
 * propagated, so a caller can always inspect what happened rather than
 * catching. `deps.journalStore` is required because `journal-window`
 * evidence reads through it; sources that don't need it ignore the dep.
 */
export async function runEvidenceBag(
  bag: EvidenceBag,
  deps: { readonly journalStore: JournalStore },
): Promise<EvidenceRunResult> {
  const snapshot: Record<string, unknown> = {};
  const failures: Record<string, EvidenceFailure> = {};
  const errors: Record<string, unknown> = {};

  const labels = Object.keys(bag);

  const results = await Promise.all(
    labels.map(async (label) => {
      const source = bag[label]!;
      try {
        const value = await runOneEvidenceSource(source, deps);
        return { label, result: value };
      } catch (cause) {
        return { label, result: "threw" as const, cause };
      }
    }),
  );

  for (const entry of results) {
    if (entry.result === "threw") {
      errors[entry.label] = entry.cause;
      continue;
    }
    if (isErr(entry.result)) {
      failures[entry.label] = entry.result.error;
      continue;
    }
    snapshot[entry.label] = entry.result.value;
  }

  return { snapshot, failures, errors };
}

async function runOneEvidenceSource(
  source: EvidenceSource,
  deps: { readonly journalStore: JournalStore },
): Promise<Result<unknown, EvidenceFailure>> {
  switch (source.type) {
    case "journal-window": {
      const events = await deps.journalStore.query(source.query, source.windowMs);
      return source.predicate(events);
    }
    case "schema-applied":
      return source.check();
    case "attestation":
      return source.check();
  }
}

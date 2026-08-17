import type { Clock } from "@phyxiusjs/clock";
import { err, isErr, ok, type Result } from "@phyxiusjs/fp";
import type { HandlerEvent } from "@phyxiusjs/handler";
import type { Journal } from "@phyxiusjs/journal";

import { runEvidenceBag } from "./evidence-runner.js";
import { createMemoryPhaseStore, type JournalStore, type PhaseStore } from "./store.js";
import type { Advanced, AdvanceError, EvidenceBag, MigrationSpec, PhaseName, RunningMigration } from "./types.js";

// ── defineMigration ─────────────────────────────────────────────────────────

/**
 * Declare a migration as a value. Validates the spec shape (at least two
 * phases, non-empty name) and returns it unchanged — the data is the
 * artifact. Pair with `createMigration` to get a running instance.
 */
export function defineMigration<TPhases extends Readonly<Record<string, import("./types.js").PhaseSpec>>>(
  spec: MigrationSpec<TPhases>,
): MigrationSpec<TPhases> {
  if (spec.name.length === 0) {
    throw new Error("migration: name must be non-empty");
  }
  const phaseNames = Object.keys(spec.phases);
  if (phaseNames.length < 2) {
    throw new Error(`migration "${spec.name}": at least two phases required`);
  }
  return spec;
}

// ── createMigration ─────────────────────────────────────────────────────────

export interface MigrationRuntime {
  readonly clock: Clock;
  readonly journal: Journal<HandlerEvent>;
  readonly journalStore: JournalStore;

  /**
   * Phase store for durable phase state. Defaults to an in-process atom
   * starting at the first phase of the spec (single-process safe). Fleet
   * deployments pass a store backed by Postgres / Redis / etc.
   */
  readonly phaseStore?: PhaseStore;

  /**
   * Override the starting phase. Useful in tests to begin from a
   * non-initial phase without executing prior transitions.
   */
  readonly initialPhase?: string;
}

/**
 * Materialize a migration spec into a runtime value. The running
 * migration exposes `currentPhase()` and `advance()` — the whole public
 * surface. Everything else (the evidence machinery, the CAS dance, the
 * journal event writing) is internal.
 */
export function createMigration<TPhases extends Readonly<Record<string, import("./types.js").PhaseSpec>>>(
  spec: MigrationSpec<TPhases>,
  runtime: MigrationRuntime,
): RunningMigration<MigrationSpec<TPhases>> {
  type Spec = MigrationSpec<TPhases>;
  type Phase = PhaseName<Spec>;

  const phaseOrder = Object.keys(spec.phases) as Phase[];
  const firstPhase = phaseOrder[0]!;

  // Resolve initial phase strictly — if the caller passes an initial
  // phase that's not in the spec, refuse to construct. Silent fallback
  // to `firstPhase` here would violate "no non-decision."
  if (runtime.initialPhase !== undefined && !phaseOrder.includes(runtime.initialPhase as Phase)) {
    throw new Error(
      `migration "${spec.name}": initialPhase "${runtime.initialPhase}" is not a declared phase. ` +
        `Phases are: ${phaseOrder.join(", ")}`,
    );
  }

  const phaseStore =
    runtime.phaseStore ??
    createMemoryPhaseStore({
      initial: runtime.initialPhase ?? firstPhase,
      clock: runtime.clock,
    });

  // ── Internal: next phase lookup ──────────────────────────────────────────

  function nextPhase(current: Phase): Phase | null {
    const idx = phaseOrder.indexOf(current);
    if (idx === -1) return null; // shouldn't happen; defensive
    const next = phaseOrder[idx + 1];
    return next ?? null;
  }

  // Evidence-running is delegated to `runEvidenceBag` (evidence-runner.ts) —
  // lifted out from here so `@phyxiusjs/durable-step`'s proof-of-completion
  // gate can run the exact same "collect Ok/failed/errored across a bag"
  // logic without any phase or CAS semantics attached. See that file's
  // header comment for the shape-fits reasoning. Behavior here is
  // unchanged — this is a relocation, not a rewrite.
  const runEvidence = (bag: EvidenceBag) => runEvidenceBag(bag, { journalStore: runtime.journalStore });

  // ── Internal: write a journal entry for an advance attempt ──────────────

  function writeJournalEntry(params: {
    outcome: "success" | "failure";
    from: Phase;
    attempted: Phase;
    observed: Readonly<Record<string, unknown>>;
    refusal?: AdvanceError;
  }): void {
    const now = runtime.clock.now();

    // A refusal is a structured outcome, not an exception — we don't
    // populate `error` (that field is reserved for handler-error variants
    // from @phyxiusjs/handler). Instead, the refusal type + details land
    // in `observed`, which is where migration-specific audit facts belong.
    const observed: Record<string, unknown> = {
      migration: spec.name,
      from: params.from,
      attempted: params.attempted,
      ...params.observed,
    };
    if (params.refusal !== undefined) {
      observed["refusal"] = {
        type: params.refusal.type,
        message: advanceErrorMessage(params.refusal),
      };
    }

    const event: HandlerEvent = {
      name: `migration.${spec.name}.advance`,
      invocationId: `${spec.name}-${params.from}-to-${params.attempted}-${now.monoMs.toString(36)}`,
      source: "migration",
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      attempts: 1,
      outcome: params.outcome,
      observed,
    };
    runtime.journal.append(event);
  }

  // ── advance() ────────────────────────────────────────────────────────────

  async function advance(): Promise<Result<Advanced<Spec>, AdvanceError>> {
    const current = (await phaseStore.current()) as Phase;

    const target = nextPhase(current);
    if (target === null) {
      const error: AdvanceError = { type: "ALREADY_AT_FINAL", phase: current };
      writeJournalEntry({
        outcome: "failure",
        from: current,
        attempted: current,
        observed: {},
        refusal: error,
      });
      return err(error);
    }

    const bag = spec.phases[target]!.evidence;
    const { snapshot, failures, errors } = await runEvidence(bag);

    // Errors trump failures — an unreachable store is a more urgent
    // condition than a predicate that produced `Err`, and we don't want
    // to mask it in the audit trail.
    if (Object.keys(errors).length > 0) {
      const error: AdvanceError = {
        type: "EVIDENCE_ERRORED",
        attemptedPhase: target,
        errors,
      };
      writeJournalEntry({
        outcome: "failure",
        from: current,
        attempted: target,
        observed: { failures, errorLabels: Object.keys(errors) },
        refusal: error,
      });
      return err(error);
    }

    if (Object.keys(failures).length > 0) {
      const error: AdvanceError = {
        type: "EVIDENCE_FAILED",
        attemptedPhase: target,
        failures,
      };
      writeJournalEntry({
        outcome: "failure",
        from: current,
        attempted: target,
        observed: { failures },
        refusal: error,
      });
      return err(error);
    }

    // All evidence produced Ok. Attempt the CAS.
    const casResult = await phaseStore.tryAdvance(current, target, snapshot);

    if (isErr(casResult)) {
      const error: AdvanceError = {
        type: "CAS_LOST",
        expected: current,
        actual: casResult.error.actual,
      };
      writeJournalEntry({
        outcome: "failure",
        from: current,
        attempted: target,
        observed: { snapshot, actualPhase: casResult.error.actual },
        refusal: error,
      });
      return err(error);
    }

    const advanced: Advanced<Spec> = {
      from: current,
      to: target,
      evidence: snapshot,
      at: casResult.value.at,
    };

    writeJournalEntry({
      outcome: "success",
      from: current,
      attempted: target,
      observed: { snapshot, at: casResult.value.at },
    });

    return ok(advanced);
  }

  // ── Public surface ──────────────────────────────────────────────────────

  return {
    name: spec.name,

    async currentPhase() {
      return (await phaseStore.current()) as Phase;
    },

    advance,
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

function advanceErrorMessage(error: AdvanceError): string {
  switch (error.type) {
    case "ALREADY_AT_FINAL":
      return `already at final phase "${error.phase}"`;
    case "EVIDENCE_FAILED":
      return `evidence failed for phase "${error.attemptedPhase}": ${Object.keys(error.failures).join(", ")}`;
    case "EVIDENCE_ERRORED":
      return `evidence errored for phase "${error.attemptedPhase}": ${Object.keys(error.errors).join(", ")}`;
    case "CAS_LOST":
      return `phase CAS lost (expected "${error.expected}", actual "${error.actual}")`;
  }
}

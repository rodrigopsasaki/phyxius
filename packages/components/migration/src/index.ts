// Runtime
export { defineMigration, createMigration, type MigrationRuntime } from "./migration.js";

// Evidence constructors — the common-path helpers
export { attestation, journalWindow, schemaApplied } from "./evidence.js";

// Evidence runner — independent of phase/CAS semantics. Lifted out for
// @phyxiusjs/durable-step's proof-of-completion gate; see
// evidence-runner.ts's header comment.
export { runEvidenceBag, type EvidenceRunResult } from "./evidence-runner.js";

// Stores — interfaces + memory references
export { createMemoryJournalStore, createMemoryPhaseStore, type JournalStore, type PhaseStore } from "./store.js";

// Types — the public vocabulary
export type {
  Advanced,
  AdvanceError,
  AttestationEvidence,
  EvidenceBag,
  EvidenceFailure,
  EvidenceSnapshot,
  EvidenceSource,
  JournalQuery,
  JournalWindowEvidence,
  MigrationSpec,
  PhaseName,
  PhaseSpec,
  RunningMigration,
  SchemaAppliedEvidence,
} from "./types.js";

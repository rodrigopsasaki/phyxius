// Runtime
export { defineMigration, createMigration, type MigrationRuntime } from "./migration.js";

// Evidence constructors — the common-path helpers
export { attestation, journalWindow, schemaApplied } from "./evidence.js";

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

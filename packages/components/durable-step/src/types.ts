import type { CircuitBreakerPolicy, ConcurrencyPolicy, HandlerTools, RetryPolicy } from "@phyxiusjs/handler";
import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { EvidenceBag, JournalStore } from "@phyxiusjs/migration";
import type { MachineEvent, MachineState } from "@phyxiusjs/state-machine";
import type { Validator } from "@phyxiusjs/validate";

import type { RetryLedger } from "./retry-ledger.js";

// ── StateStore — the write side of a durable step's machine state ──────────
//
// Mirrors `@phyxiusjs/migration`'s `PhaseStore` almost exactly (CAS advance,
// in-memory reference, fleet stores are the horizon) — deliberately. The
// shape that made migration's phase transitions safe under concurrent
// callers is the same shape a durable step's state transitions need. The
// one difference: migration's phase is a bare string; a durable step's
// state is a full `MachineState` value, because climb states carry payload
// (`{ kind: "succeeded", receiptId }`), not just a name.

export interface StateStore<S extends MachineState> {
  /** The currently-committed state. Reads through to the freshest value. */
  current(): Promise<S>;

  /**
   * Compare-and-set advance. Succeeds only if the committed state's `kind`
   * equals `from`; on success, commits `to`. On a lost CAS, returns the
   * actual current kind so the caller can build a structured refusal.
   */
  trySet(from: S["kind"], to: S): Promise<Result<{ readonly at: Instant }, { readonly actual: S["kind"] }>>;
}

// ── SpendPolicy — the missing vocabulary round 0's FINDING 2 named ─────────
//
// Mirrors `RetryPolicy` / `CircuitBreakerPolicy`'s own shape exactly: a
// named value, constructed through a namespace of factories, with an
// explicit "no decision" member (`spend.none()`) standing in for the
// decision retry.none()/cb.none() already model. There is no default —
// declaring `spend` is mandatory on every `DurableStepSpec`, the same way
// `timeout`/`retry`/`circuitBreaker` are mandatory on `HandlerSpec`.
//
// Declaring the policy is necessary but not sufficient. What makes an
// unattributed cent actually INexpressible (not just discouraged) is in
// `step.ts`: a step declared `metered` that completes without ever calling
// `tools.spend.record(...)` is refused, not silently accepted — completion
// and attribution become the same fact, the way `EvidenceBag` makes
// completion and proof the same fact in `@phyxiusjs/migration`.
export type SpendPolicy = { readonly kind: "none" } | { readonly kind: "metered"; readonly unit: string };

export const spend = {
  /** Explicit "this step spends nothing." Recording anyway is refused — symmetry with the metered case, not a loophole. */
  none: (): SpendPolicy => ({ kind: "none" }),
  /** This step spends real resources, denominated in `unit` (`"usd"`, `"tokens"`, ...). At least one `record()` call is required for the step to complete. */
  metered: (options: { readonly unit: string }): SpendPolicy => ({ kind: "metered", unit: options.unit }),
};

/** Handed to `run` via `tools.spend`. Additive — call once per billable unit (once per model call, once per API charge). */
export interface SpendRecorder {
  record(amount: number): void;
}

// ── DurableStepSpec ──────────────────────────────────────────────────────────
//
// Deliberately NOT `extends HandlerSpec` — the shape-fits test (PHYXIUS_CODEX
// §II) applied honestly: `run`'s tools parameter widens to carry
// `currentState`, and function parameters are checked contravariantly, so an
// interface that structurally extended `HandlerSpec` while narrowing `run`'s
// tools would either violate the base signature or require an unsound cast.
// `ConnectorSpec` gets to extend cleanly because it doesn't touch `tools` at
// all. This one almost-fits and doesn't — which is itself the honest
// round-1 finding, not a workaround to paper over.
export interface DurableStepSpec<S extends MachineState, E extends MachineEvent, TInput, TOutput, TFields> {
  readonly name: string;

  /**
   * The event type this step fires on a successful run. Declared
   * statically (not derived from the output) so illegality can be checked
   * BEFORE `run` executes — a step that can't legally fire from the
   * current state never spends the work it would gate.
   */
  readonly eventType: E["type"];

  /** Builds the full event (with payload) from the validated input + the run's output. */
  readonly toEvent: (input: TInput, output: TOutput) => E;

  readonly input: Validator<TInput>;
  readonly output: Validator<TOutput>;
  readonly fields: TFields;
  readonly timeout: Millis;
  readonly concurrency: ConcurrencyPolicy;
  readonly retry: RetryPolicy;
  readonly circuitBreaker: CircuitBreakerPolicy;

  /** No default. `spend.none()` is the explicit "this step spends nothing" — see `SpendPolicy`. */
  readonly spend: SpendPolicy;

  /**
   * Reused directly from `@phyxiusjs/migration` — no reinvention, the
   * closed union (`attestation` / `journalWindow` / `schemaApplied`) and
   * its "wrong-until-proven-otherwise" posture already say exactly what a
   * durable step's completion proof needs to say. Mandatory, same as
   * everywhere else in this spec: `{}` is the explicit, auditable "this
   * step needs no proof beyond its own success" — different from a proof
   * field nobody thought to add. A non-empty bag must ALL resolve `Ok`
   * for the step to actually complete; `run`'s own return value is
   * necessary but no longer sufficient.
   */
  readonly proof: EvidenceBag;

  /** The work itself. `tools.currentState` is the state read at the top of this invocation; `tools.spend` records this invocation's cost. */
  readonly run: (
    input: TInput,
    tools: HandlerTools & { readonly currentState: S; readonly spend: SpendRecorder },
  ) => Promise<TOutput>;
}

// ── StepRefusal — the typed vocabulary for "this transition doesn't happen" ─
//
// Mirrors `AdvanceError`'s posture from `@phyxiusjs/migration`: a refusal is
// a structured value, not a thrown mystery. Carried as the `cause` of a
// `HANDLER_ERROR` (see `StepRefusalThrown` in step.ts) so the handler's own
// retry/circuit-breaker/journal machinery — which only knows how to consume
// thrown values — doesn't need to know this vocabulary exists.
export type StepRefusal =
  | {
      readonly type: "ILLEGAL_TRANSITION";
      readonly machine: string;
      readonly from: string;
      readonly event: string;
    }
  | {
      readonly type: "STATE_RACE_LOST";
      readonly machine: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      /** `spend.metered(...)` was declared but `run` completed without ever calling `tools.spend.record(...)`. The unattributed cent, refused rather than shipped. */
      readonly type: "SPEND_UNACCOUNTED";
      readonly unit: string;
    }
  | {
      /** `spend.none()` was declared but `run` called `tools.spend.record(...)` anyway — the "no non-decision" symmetry: a contradicted declaration is refused, not silently honored either way. */
      readonly type: "SPEND_DECLARED_NONE_BUT_RECORDED";
      readonly amount: number;
    }
  | {
      /** One or more `spec.proof` evidence sources resolved `Err` — the step's own output claims success; the proof says it isn't earned yet. Mirrors `AdvanceError.EVIDENCE_FAILED`. */
      readonly type: "PROOF_FAILED";
      readonly failures: Readonly<Record<string, unknown>>;
    }
  | {
      /** One or more `spec.proof` evidence sources threw or timed out. Mirrors `AdvanceError.EVIDENCE_ERRORED` — errors trump failures in urgency, same reasoning as migration's. */
      readonly type: "PROOF_ERRORED";
      readonly errors: Readonly<Record<string, unknown>>;
    };

// ── Runtime wiring ───────────────────────────────────────────────────────────

export interface DurableStepDeps<S extends MachineState> {
  readonly clock: Clock;
  readonly stateStore: StateStore<S>;

  /**
   * The conserved retry budget this step draws its EXTRA attempts (beyond
   * its guaranteed first try) from. Mandatory — no non-decision: a step
   * that isn't part of any shared budget still names that explicitly via
   * `createRetryLedger(Number.POSITIVE_INFINITY)`, the same way `retry.none()`
   * names "no retry" instead of leaving the field unset.
   */
  readonly retryLedger: RetryLedger;

  /** Where `spec.proof`'s `journal-window` evidence sources read from. Reused verbatim from `@phyxiusjs/migration` — see `runEvidenceBag`. */
  readonly journalStore: JournalStore;
}

// Re-exported so call sites can name `Machine<S, E>` without a second
// import from `@phyxiusjs/state-machine`.
export type { Machine, MachineEvent, MachineState } from "@phyxiusjs/state-machine";
export type { RetryLedger } from "./retry-ledger.js";

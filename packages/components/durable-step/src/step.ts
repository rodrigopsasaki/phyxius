import { isErr } from "@phyxiusjs/fp";
import { defineHandler, retry, type HandlerSpec } from "@phyxiusjs/handler";
import { runEvidenceBag } from "@phyxiusjs/migration";
import { observe } from "@phyxiusjs/observe";
import { runWithRetry } from "@phyxiusjs/retry";
import { machine as machineOps } from "@phyxiusjs/state-machine";
import type { Machine, MachineEvent, MachineState } from "@phyxiusjs/state-machine";

import type { DurableStepDeps, DurableStepSpec, StepRefusal } from "./types.js";

// ── StepRefusalThrown — the thrown envelope ─────────────────────────────────
//
// Mirrors `ConnectorFailure` from `@phyxiusjs/connector` exactly: a typed
// refusal, thrown so the handler's retry/circuit-breaker/journal machinery
// (which only knows how to consume thrown values) carries it unmodified,
// and unwrapped back into a `Result` by the one place that knows the
// vocabulary — `isStepRefusal` / the caller's own narrowing of
// `HandlerError.cause`.
export class StepRefusalThrown extends Error {
  readonly refusal: StepRefusal;

  constructor(refusal: StepRefusal) {
    super(`durable-step refused: ${refusal.type}`);
    this.name = "StepRefusalThrown";
    this.refusal = refusal;
  }
}

/** Narrow an `unknown` (typically `HandlerError.cause`) to a `StepRefusalThrown`. */
export function isStepRefusal(x: unknown): x is StepRefusalThrown {
  return x instanceof StepRefusalThrown;
}

// ── defineDurableStep ────────────────────────────────────────────────────────

/**
 * Materialize a `DurableStepSpec` into a plain `HandlerSpec`, ready for the
 * ordinary `spawn()` from `@phyxiusjs/handler` — every bit of lifecycle,
 * concurrency, backpressure, retry, circuit-breaking, and journaling the
 * handler already owns keeps working unmodified. This function adds two
 * things: state-machine legality + transition, and spend attribution, both
 * as structural parts of the invocation rather than the author's discipline.
 *
 * The wrapped `run`:
 *
 *   1. Reads the current state from `deps.stateStore`.
 *   2. Pre-flight refuses (`StepRefusalThrown(ILLEGAL_TRANSITION)`) if
 *      `spec.eventType` isn't legal from that state — BEFORE `spec.run`
 *      executes, so an illegal call never spends the work it would gate.
 *   3. Runs `spec.run` with `tools.currentState` + `tools.spend` attached,
 *      retrying under `spec.retry`'s shape (delay/shouldRetry) but capped
 *      to `1 + deps.retryLedger.draw(spec.retry.maxAttempts - 1)` extra
 *      attempts — the step's own declared ceiling is a REQUEST, the
 *      ledger's remaining balance is the GRANT. `spec.retry` never reaches
 *      the underlying handler (it's always spawned with `retry.none()`):
 *      retry now happens once, in this wrapper, where the shared ledger
 *      can see and cap it. This is the deliberate tradeoff this round
 *      surfaced — see the doc's round-3 write-up for the friction it
 *      leaves on `HandlerEvent.attempts`.
 *   4. If `spec.spend.kind === "metered"` and `tools.spend.record(...)` was
 *      never called, refuses (`SPEND_UNACCOUNTED`) — a metered step cannot
 *      complete without attributing its cost, the same way an illegal
 *      transition cannot complete without a legal event. Calling `record`
 *      when `spec.spend` is `"none"` is refused symmetrically
 *      (`SPEND_DECLARED_NONE_BUT_RECORDED`) — a contradicted declaration,
 *      not a free pass either way.
 *   5. Runs `spec.proof` (an `@phyxiusjs/migration` `EvidenceBag`, reused
 *      verbatim) through `runEvidenceBag`. Any error refuses
 *      `PROOF_ERRORED`; any failure refuses `PROOF_FAILED`. `run`
 *      returning a value is necessary but no longer sufficient — the
 *      SAME wrong-until-proven-otherwise posture `advance()` applies to
 *      phase transitions now applies to this step's own completion.
 *   6. Applies the machine transition and CAS-commits it to the store;
 *      a lost race refuses with `STATE_RACE_LOST` rather than silently
 *      overwriting a concurrent winner.
 *   7. Stamps `fromState` / `toState` / `event` / `spendTotal` /
 *      `spendUnit` / `retryBudgeted` / `retryGranted` / `retryAttemptsUsed`
 *      / `proofSnapshot` into the SAME context scope `spec.run` executed
 *      in — unprefixed keys, so they survive
 *      `snapshotObservedFromCurrentScope`'s `__`-strip and land in every
 *      journal entry's `observed` bag with zero further author action.
 *
 * A step that never legally transitions, never accounts for its declared
 * spend, or never earns its declared proof, never journals a phantom
 * success: the refusal surfaces as `HandlerError.HANDLER_ERROR` with a
 * `StepRefusalThrown` cause, narrowable via `isStepRefusal`.
 *
 * `machineDef` is a separate leading argument, not a field on `spec`,
 * deliberately: TypeScript resolves generic inference left-to-right, so
 * fixing `S`/`E` from this single, unambiguous argument FIRST lets `spec`'s
 * `eventType: E["type"]` and `toEvent: (...) => E` get checked against the
 * concrete union instead of each contributing a competing, weaker inference
 * candidate for the same type parameters.
 */
export function defineDurableStep<S extends MachineState, E extends MachineEvent, TInput, TOutput, TFields>(
  machineDef: Machine<S, E>,
  spec: DurableStepSpec<S, E, TInput, TOutput, TFields>,
  deps: DurableStepDeps<S>,
): HandlerSpec<TInput, TOutput, TFields> {
  // Declared once per step (not per invocation) — unprefixed core fields,
  // written inside every invocation's context scope alongside whatever
  // `spec.fields` the author declared.
  const transitionFields = observe.fields({
    fromState: observe.field<string>(),
    toState: observe.field<string>(),
    event: observe.field<string>(),
    spendTotal: observe.field<number>(),
    spendUnit: observe.field<string>(),
    retryBudgeted: observe.field<number>(),
    retryGranted: observe.field<number>(),
    retryAttemptsUsed: observe.field<number>(),
    proofSnapshot: observe.field<Readonly<Record<string, unknown>>>(),
  });

  return defineHandler({
    name: spec.name,
    input: spec.input,
    output: spec.output,
    fields: spec.fields,
    timeout: spec.timeout,
    concurrency: spec.concurrency,
    // Always none() at THIS layer — retry now happens inside `run` below,
    // where `deps.retryLedger` can cap it against the conserved budget.
    // Letting the underlying handler ALSO retry would double-apply delay
    // and, worse, let this step draw attempts the ledger never granted.
    retry: retry.none(),
    circuitBreaker: spec.circuitBreaker,
    run: async (input, tools) => {
      const currentState = await deps.stateStore.current();

      if (!machineOps.can(machineDef, currentState, spec.eventType)) {
        throw new StepRefusalThrown({
          type: "ILLEGAL_TRANSITION",
          machine: machineDef.name,
          from: currentState.kind,
          event: spec.eventType,
        });
      }

      transitionFields.fromState.set(currentState.kind);
      transitionFields.event.set(spec.eventType);

      // Wrong-until-proven-otherwise, applied to spend: `record()` is the
      // only door. A `metered` step that never opens it can't complete;
      // a `none` step that opens it anyway is caught, not shrugged off.
      // Persists across every retry attempt below — a failed attempt can
      // still have spent real money, and that spend is still owed.
      let spendTotal = 0;
      let spendCalls = 0;
      const spendRecorder = {
        record(amount: number): void {
          if (spec.spend.kind === "none") {
            throw new StepRefusalThrown({ type: "SPEND_DECLARED_NONE_BUT_RECORDED", amount });
          }
          spendTotal += amount;
          spendCalls += 1;
        },
      };

      // The step's own ceiling is a REQUEST; the ledger's remaining
      // balance is the GRANT. Decomposing work into more steps cannot
      // mint more retry capacity — every step sharing this ledger draws
      // from the exact same conserved pool.
      const requestedExtra = Math.max(0, spec.retry.maxAttempts - 1);
      const grantedExtra = deps.retryLedger.draw(requestedExtra);
      transitionFields.retryBudgeted.set(requestedExtra);
      transitionFields.retryGranted.set(grantedExtra);

      let attemptsUsed = 0;
      const attemptOnce = async (): Promise<TOutput> => {
        attemptsUsed += 1;
        return spec.run(input, { ...tools, currentState, spend: spendRecorder });
      };

      const retryResult = await runWithRetry(
        attemptOnce,
        { ...spec.retry, maxAttempts: 1 + grantedExtra },
        deps.clock,
        { signal: tools.signal },
      );
      transitionFields.retryAttemptsUsed.set(attemptsUsed);

      if (isErr(retryResult)) {
        // Unwrap back to the underlying cause — the outer handler's own
        // error classification (TIMEOUT via the shared budget signal,
        // HANDLER_ERROR otherwise) and `isStepRefusal` narrowing both
        // still need to see what `spec.run` actually threw, not a
        // `RetryError` wrapper this layer introduced.
        throw retryResult.error.type === "REJECTED" ? retryResult.error.error : retryResult.error.lastError;
      }
      const output = retryResult.value;

      if (spec.spend.kind === "metered" && spendCalls === 0) {
        throw new StepRefusalThrown({ type: "SPEND_UNACCOUNTED", unit: spec.spend.unit });
      }
      if (spec.spend.kind === "metered") {
        transitionFields.spendTotal.set(spendTotal);
        transitionFields.spendUnit.set(spec.spend.unit);
      }

      // Wrong-until-proven-otherwise, applied to completion itself: `run`
      // returning is necessary but not sufficient. `spec.proof` reuses
      // `@phyxiusjs/migration`'s exact evidence vocabulary and runner —
      // errors trump failures in urgency, same reasoning `advance()` uses.
      const proofRun = await runEvidenceBag(spec.proof, { journalStore: deps.journalStore });
      if (Object.keys(proofRun.errors).length > 0) {
        throw new StepRefusalThrown({ type: "PROOF_ERRORED", errors: proofRun.errors });
      }
      if (Object.keys(proofRun.failures).length > 0) {
        throw new StepRefusalThrown({ type: "PROOF_FAILED", failures: proofRun.failures });
      }
      transitionFields.proofSnapshot.set(proofRun.snapshot);

      const event = spec.toEvent(input, output);
      const applied = machineOps.apply(machineDef, currentState, event);
      if (isErr(applied)) {
        // Structurally shouldn't happen — `can` already checked legality
        // for `spec.eventType` — but a hand-rolled machine or a
        // throwing transition fn could still land here. Refuse rather
        // than silently accept a phantom state.
        throw new StepRefusalThrown({
          type: "ILLEGAL_TRANSITION",
          machine: machineDef.name,
          from: currentState.kind,
          event: spec.eventType,
        });
      }

      const cas = await deps.stateStore.trySet(currentState.kind, applied.value);
      if (isErr(cas)) {
        throw new StepRefusalThrown({
          type: "STATE_RACE_LOST",
          machine: machineDef.name,
          expected: currentState.kind,
          actual: cas.error.actual,
        });
      }

      transitionFields.toState.set(applied.value.kind);
      return output;
    },
  });
}

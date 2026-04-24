import { err, ok, type Result } from "@phyxiusjs/fp";

import type { InvalidTransition, Machine, MachineEvent, MachineOptions, MachineState } from "./types.js";

// ── Public: define ─────────────────────────────────────────────────────────

/**
 * Build a machine from a name and a transition table. No runtime work —
 * this is effectively an identity function with type inference. The value
 * it returns is the machine you pass to `apply`.
 *
 * Adding a new state to the `S` union *breaks the compile here* until you
 * declare its outbound transitions (or mark it terminal with `{}`). That's
 * the primary correctness property this primitive provides: you cannot
 * ship a machine that silently ignores a state you added.
 */
export function define<S extends MachineState, E extends MachineEvent>(options: MachineOptions<S, E>): Machine<S, E> {
  return { name: options.name, transitions: options.transitions };
}

// ── Public: apply ──────────────────────────────────────────────────────────

/**
 * Apply an event to a state. Returns the new state on a legal transition,
 * or a typed `InvalidTransition` when no transition is declared for the
 * (state.kind, event.type) pair.
 *
 * Pure by design — no clock, no emit, no side effects. The caller decides
 * whether to journal the transition, what to do with the new state, and
 * how to handle failures. That separation is what lets the same machine
 * drive a handler, a scheduler, a queue consumer, or a pure unit test —
 * no runtime adaptation needed.
 *
 * If the declared transition function itself throws, the throw propagates
 * unchanged. A throwing transition is a bug in user code, not a domain
 * failure; hiding it would be wrong.
 */
export function apply<S extends MachineState, E extends MachineEvent>(
  machine: Machine<S, E>,
  state: S,
  event: E,
): Result<S, InvalidTransition> {
  // Defensive lookup: the types should have caught missing state kinds at
  // compile time, but hand-rolled machines or `any`-typed callers could
  // reach here. We return `InvalidTransition` rather than throwing, so the
  // runtime contract stays consistent regardless of how the machine was
  // constructed.
  const stateRow = (machine.transitions as Record<string, Record<string, unknown>>)[state.kind];
  if (stateRow === undefined) {
    return err({
      type: "INVALID_TRANSITION",
      from: state.kind,
      event: event.type,
      machine: machine.name,
    });
  }

  const transition = stateRow[event.type] as ((s: S, e: E) => S) | undefined;

  if (transition === undefined) {
    return err({
      type: "INVALID_TRANSITION",
      from: state.kind,
      event: event.type,
      machine: machine.name,
    });
  }

  return ok(transition(state, event));
}

// ── Public: can ────────────────────────────────────────────────────────────

/**
 * Check whether a given (state, event) pair would succeed under `apply`,
 * *without* running the transition function. Useful for exhaustiveness
 * queries, UI gating ("is this button enabled?"), and guards-as-strategies
 * that need to answer "is this event even legal?" before running richer
 * checks.
 *
 * `can` is purely structural — it inspects the transition table. If the
 * transition function itself would throw, `can` still returns `true`; the
 * function's correctness is its own concern.
 */
export function can<S extends MachineState, E extends MachineEvent>(
  machine: Machine<S, E>,
  state: S,
  eventType: E["type"],
): boolean {
  const stateRow = (machine.transitions as Record<string, Record<string, unknown>>)[state.kind];
  if (stateRow === undefined) return false;
  return stateRow[eventType] !== undefined;
}

// ── Namespace ──────────────────────────────────────────────────────────────

/**
 * Ergonomic grouping — mirrors `retry`, `cb`, `schedule`, `resource`,
 * `strategy`. Call sites read as `machine.define({...})` /
 * `machine.apply(m, state, event)` / `machine.can(m, state, "pay")`.
 */
export const machine = {
  define,
  apply,
  can,
} as const;

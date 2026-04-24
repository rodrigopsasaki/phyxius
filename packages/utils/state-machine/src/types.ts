// ── Shape constraints ─────────────────────────────────────────────────────

/**
 * Every state must be a discriminated union member tagged by `kind`. States
 * are *nouns* — the reader opening the file should instantly know they're
 * looking at what a thing currently IS, not an event it received.
 *
 * Convention:
 *
 *   type OrderState =
 *     | { kind: "placed";    customerId: string; total: number }
 *     | { kind: "paid";      customerId: string; total: number; paidAt: string }
 *     | { kind: "shipped";   customerId: string; trackingNumber: string }
 *     | { kind: "cancelled"; customerId: string; reason: string };
 */
export interface MachineState {
  readonly kind: string;
}

/**
 * Every event must be a discriminated union member tagged by `type`. Events
 * are *verbs* — what JUST HAPPENED, not what the thing currently is.
 *
 * Convention:
 *
 *   type OrderEvent =
 *     | { type: "pay";    paidAt: string }
 *     | { type: "ship";   trackingNumber: string }
 *     | { type: "cancel"; reason: string };
 *
 * The `kind` / `type` discriminator split isn't aesthetic — it's so a
 * reader's eye can tell a state from an event without reading the schema.
 */
export interface MachineEvent {
  readonly type: string;
}

// ── Transition function ────────────────────────────────────────────────────

/**
 * A transition is a pure, sync function from (state, event) to a new state.
 * Transitions are *strategies* — the same shape we established in
 * `@phyxiusjs/strategy`. Sync-by-type is the fence: no IO, no clock, no
 * network, no logging. If you want to do something side-effecting when a
 * transition fires, that's a *handler*, and it runs on the caller's side
 * after `apply` returns the new state.
 */
export type TransitionFn<
  S extends MachineState,
  E extends MachineEvent,
  FromK extends S["kind"],
  EventT extends E["type"],
> = (state: Extract<S, { kind: FromK }>, event: Extract<E, { type: EventT }>) => S;

// ── The transition graph ───────────────────────────────────────────────────

/**
 * The transition table. One key per state kind. Per state, a Partial
 * mapping from event type to transition function.
 *
 * - **Every state must be declared** (including terminals — use `{}`).
 *   Adding a new state to `S` breaks the compile here until you handle it.
 *   That's the "no non-decision" rule: silence isn't a legal answer.
 *
 * - **Events per state are partial.** Not every state accepts every event
 *   (a `shipped` order can't be paid again). Missing entries mean the
 *   transition is illegal; `apply` returns `Err(INVALID_TRANSITION)` at
 *   runtime.
 *
 * - **Transition fn signatures are inferred.** The compiler knows the
 *   `state` param has the specific kind and the `event` param has the
 *   specific type for that cell of the table. The return must be a
 *   valid `S`.
 */
export type Transitions<S extends MachineState, E extends MachineEvent> = {
  readonly [K in S["kind"]]: {
    readonly [T in E["type"]]?: TransitionFn<S, E, K, T>;
  };
};

// ── Machine ────────────────────────────────────────────────────────────────

/**
 * A machine is a value. It holds a name (for identity in journals/events)
 * and the transition graph. `apply` is the only operation — everything
 * else composes around it.
 */
export interface Machine<S extends MachineState, E extends MachineEvent> {
  readonly name: string;
  readonly transitions: Transitions<S, E>;
}

// ── Invalid transition ────────────────────────────────────────────────────

/**
 * The typed error returned by `apply` when the (state, event) pair has no
 * transition declared. The union is left open (no `| ...` yet) so callers
 * can't exhaustive-match on every concrete variant until we actually add
 * more. When a richer reason is needed ("transition legal but a guard
 * failed"), it gets a new `type`, not a string squashed into an existing
 * one.
 */
export type InvalidTransition = {
  readonly type: "INVALID_TRANSITION";
  readonly from: string;
  readonly event: string;
  readonly machine: string;
};

// ── Options ───────────────────────────────────────────────────────────────

export interface MachineOptions<S extends MachineState, E extends MachineEvent> {
  readonly name: string;
  readonly transitions: Transitions<S, E>;
}

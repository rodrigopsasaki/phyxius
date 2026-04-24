# State Machine

Typed state machines as a primitive. States are discriminated unions, transitions are strategies, the graph is the only new thing. Invalid transitions are typed errors, not throws. No interpreter, no event queue, no hidden runtime — just `(state, event) → Result<newState, InvalidTransition>`.

This primitive exists because most real systems already have state machines embedded in them; they just aren't named. An order lifecycle, a session, a workflow, a payment — all state machines, implemented as `if (order.isPaid && order.isShipped) { ... }`. That implicitness is where bugs live. The fix isn't elaborate state-machine machinery; it's making the graph explicit, typed, and enforced.

---

## The idea in one sentence

**We're not making state machines hard. We're modeling what they actually are.**

A transition is happening every time a state changes. The only question is whether your code acknowledges it. Setters acknowledge nothing; transitions acknowledge everything.

---

## Installation

```bash
npm install @phyxiusjs/state-machine @phyxiusjs/fp
```

---

## Quick start

```ts
import { machine } from "@phyxiusjs/state-machine";

// States are nouns (what the thing IS). Discriminator: `kind`.
type OrderState =
  | { kind: "placed"; customerId: string; total: number }
  | { kind: "paid"; customerId: string; total: number; paidAt: string }
  | { kind: "shipped"; customerId: string; trackingNumber: string }
  | { kind: "cancelled"; customerId: string; reason: string };

// Events are verbs (what JUST HAPPENED). Discriminator: `type`.
type OrderEvent =
  | { type: "pay"; paidAt: string }
  | { type: "ship"; trackingNumber: string }
  | { type: "cancel"; reason: string };

// The graph. Every state must be declared; terminals use `{}`. Missing
// events per state are *legal* (they'll return InvalidTransition at runtime).
const orderMachine = machine.define<OrderState, OrderEvent>({
  name: "order",
  transitions: {
    placed: {
      pay: (s, e) => ({ kind: "paid", customerId: s.customerId, total: s.total, paidAt: e.paidAt }),
      cancel: (s, e) => ({ kind: "cancelled", customerId: s.customerId, reason: e.reason }),
    },
    paid: {
      ship: (s, e) => ({ kind: "shipped", customerId: s.customerId, trackingNumber: e.trackingNumber }),
      cancel: (s, e) => ({ kind: "cancelled", customerId: s.customerId, reason: e.reason }),
    },
    shipped: {},
    cancelled: {},
  },
});

// Apply an event. Result<newState, InvalidTransition>.
const result = machine.apply(orderMachine, currentState, { type: "pay", paidAt: "2026-04-24" });

if (result._tag === "Ok") {
  // New state. Exhaustive dispatch via native switch — exhaustiveness is TypeScript's job.
  switch (result.value.kind) {
    case "paid":
      return handlePaid(result.value);
    case "shipped":
      return handleShipped(result.value);
    // ...every case or the compile fails. Adding a new state breaks it intentionally.
  }
}
```

---

## The kind / type split

States use `kind`, events use `type`. This isn't aesthetic — it's so the reader's eye can tell a state from an event without reading the schema:

- `kind` = **noun**. What the thing IS right now.
- `type` = **verb**. What JUST HAPPENED.

When you're maintaining code that says `order.kind === "paid"` vs `event.type === "pay"`, the distinction saves you a mental stack frame every time you read it. Over a codebase, that compounds.

---

## Transitions ARE strategies

A transition is `(state, event) => newState`. Sync, pure, data-in-data-out — the exact shape we established in [`@phyxiusjs/strategy`](../strategy). Which means:

- **Every correctness rule about strategies applies.** No IO, no clock, no network, no logging. If you want a side effect, that's a handler, not a transition.
- **Transitions are unit-testable as pure functions.** `expect(paidFromPlaced(state, event)).toEqual({...})`. No mocks, no clock injection.
- **Transitions can be shadow-tested.** A new version of a transition rule can run alongside the old one via `@phyxiusjs/strategy` before being promoted.

The machine itself is a _namespace_ for a set of related strategies that share the structural constraint of the state graph. That constraint is the only new thing this package provides.

---

## Actions on transition ARE handlers

This package deliberately does NOT let you attach actions (side effects) to transitions. Actions live outside the machine — they're handlers, the caller runs them after `apply` returns the new state:

```ts
const result = machine.apply(orderMachine, current, event);

if (result._tag === "Ok") {
  // Side effects run here, not inside the transition.
  await notifyWarehouse.invoke(result.value);
  await persist(result.value);
}
```

That separation is load-bearing. The two blog posts behind this primitive
([implicit state machines](https://rodrigopsasaki.com/blog/implicit-state-machines),
[know where you are](https://rodrigopsasaki.com/blog/know-where-you-are))
make the argument: classification and commitment are two operations pretending to be one, and fusing them is where bugs live. The machine classifies; the handler commits. Pulling them apart is the whole point.

---

## Guards ARE strategies

"Can I actually fire this event right now?" is a pure predicate — a classifier. Run it before `apply`, don't bake it into the transition:

```ts
import { strategy } from "@phyxiusjs/strategy";

const canPay = strategy.define("order.can-pay", (order: Order): boolean => {
  return order.total > 0 && !order.isFraudulent;
});

if (canPay.compute(order) && machine.can(orderMachine, current, "pay")) {
  const result = machine.apply(orderMachine, current, { type: "pay", paidAt: "..." });
  // ...
}
```

Two questions, two answers, both data-shaped: _"is the transition legal?"_ (`machine.can`) and _"does domain policy allow it?"_ (`strategy.compute`). Together they tell you whether to fire. If you bake the predicate into the transition, you can't shadow-test it, and failure becomes "transition returned the wrong thing" instead of "policy said no." Different debugging shapes.

---

## `machine.apply`

```ts
apply<S, E>(machine: Machine<S, E>, state: S, event: E): Result<S, InvalidTransition>
```

Pure. No clock, no emit, no side effects. Returns the new state on a legal transition, or:

```ts
type InvalidTransition = {
  readonly type: "INVALID_TRANSITION";
  readonly from: string; // state.kind
  readonly event: string; // event.type
  readonly machine: string;
};
```

If the declared transition function itself throws, the throw propagates. A throwing transition is a bug — strategies are supposed to be pure — not a domain failure to be typed.

---

## `machine.can`

```ts
can<S, E>(machine: Machine<S, E>, state: S, eventType: E["type"]): boolean
```

Structural lookup — _is there a transition declared for this (state.kind, eventType) pair?_ No transition function runs; no side effect, no state change. Use it for UI gating ("should this button be enabled?"), exhaustiveness queries, and pre-flight guards.

---

## Observability (the caller's call)

`apply` is deliberately silent. No events, no journal, no emit callback. The caller decides what to log:

```ts
function transition(current: OrderState, event: OrderEvent) {
  const result = machine.apply(orderMachine, current, event);
  if (result._tag === "Ok") {
    journal.append({
      type: "machine:transitioned",
      machine: "order",
      from: current.kind,
      to: result.value.kind,
      event: event.type,
    });
  } else {
    journal.append({ type: "machine:invalid-transition", ...result.error });
  }
  return result;
}
```

Three lines of glue. The alternative — bundling observability into the primitive — creates surface we don't need and forces every caller to opt out of something they didn't ask for. Separation wins.

---

## What this does NOT do

- **No actions / side effects on transition.** Transitions are pure. Side effects are handlers.
- **No guards inside transitions.** Guards are strategies, called before `apply`.
- **No hierarchical / parallel states (statecharts).** Huge feature; huge interpretation cost. If you genuinely need it, model it as multiple machines + composing strategies.
- **No persistence.** States are plain values; write them wherever — DB, Redis, memory. The machine is stateless.
- **No event queue, no interpreter, no services.** XState has all of these. They're runtime machinery on top of the fact that "state machine" is doing too much. This package stops at `(state, event) → Result<newState, InvalidTransition>`.
- **No serialization format / wire protocol.** Serialize states with `JSON.stringify` if you want. The machine definition lives in code, not in a YAML file.

---

## What you get

- **Graph as a typed value.** Adding a state breaks the compile everywhere until you handle it. The "no non-decision" rule, expressed at the type level.
- **Invalid transitions as typed values.** No throws crossing the boundary. `result.error.from` / `.event` / `.machine` is always inspectable.
- **Pure transitions.** Strategy-shape means pure unit tests, shadow-deployable rules, and zero runtime coupling.
- **Cheap to understand.** Someone opening your codebase can read the `transitions` object and know every legal state change in one glance. No stepping through conditionals, no "what happens when..." — just a graph.

The "I JUST WANT TO SET THE STATE" anti-request is the failure mode this primitive prevents. A transition is happening whether you acknowledge it or not. Setters hide the transition and leave you to reconstruct it from context every time you read the code. Machines make it legible by construction.

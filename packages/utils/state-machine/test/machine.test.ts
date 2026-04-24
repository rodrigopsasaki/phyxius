import { describe, expect, it } from "vitest";

import { machine } from "../src/machine.js";

// ── Test fixtures — an order lifecycle ────────────────────────────────────

type OrderState =
  | { kind: "placed"; customerId: string; total: number }
  | { kind: "paid"; customerId: string; total: number; paidAt: string }
  | { kind: "shipped"; customerId: string; trackingNumber: string }
  | { kind: "cancelled"; customerId: string; reason: string };

type OrderEvent =
  | { type: "pay"; paidAt: string }
  | { type: "ship"; trackingNumber: string }
  | { type: "cancel"; reason: string };

const orderMachine = machine.define<OrderState, OrderEvent>({
  name: "order",
  transitions: {
    placed: {
      pay: (s, e) => ({
        kind: "paid",
        customerId: s.customerId,
        total: s.total,
        paidAt: e.paidAt,
      }),
      cancel: (s, e) => ({
        kind: "cancelled",
        customerId: s.customerId,
        reason: e.reason,
      }),
    },
    paid: {
      ship: (s, e) => ({
        kind: "shipped",
        customerId: s.customerId,
        trackingNumber: e.trackingNumber,
      }),
      cancel: (s, e) => ({
        kind: "cancelled",
        customerId: s.customerId,
        reason: e.reason,
      }),
    },
    shipped: {},
    cancelled: {},
  },
});

const placed: OrderState = { kind: "placed", customerId: "alice", total: 99 };
const paid: OrderState = { kind: "paid", customerId: "alice", total: 99, paidAt: "2026-04-24" };
const shipped: OrderState = { kind: "shipped", customerId: "alice", trackingNumber: "TRK-1" };
const cancelled: OrderState = { kind: "cancelled", customerId: "alice", reason: "customer request" };

// ── machine.define ─────────────────────────────────────────────────────────

describe("machine.define", () => {
  it("returns a machine value carrying the name and transitions", () => {
    expect(orderMachine.name).toBe("order");
    expect(orderMachine.transitions).toBeDefined();
  });

  it("is a pure value — construction has no side effects", () => {
    // Build the same machine twice; both should be independent values.
    const a = machine.define<OrderState, OrderEvent>({
      name: "copy-a",
      transitions: orderMachine.transitions,
    });
    const b = machine.define<OrderState, OrderEvent>({
      name: "copy-b",
      transitions: orderMachine.transitions,
    });
    expect(a.name).toBe("copy-a");
    expect(b.name).toBe("copy-b");
  });
});

// ── machine.apply — legal transitions ─────────────────────────────────────

describe("machine.apply — legal transitions", () => {
  it("placed + pay → paid", () => {
    const result = machine.apply(orderMachine, placed, { type: "pay", paidAt: "2026-04-24" });
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value.kind).toBe("paid");
      if (result.value.kind === "paid") {
        expect(result.value.customerId).toBe("alice");
        expect(result.value.total).toBe(99);
        expect(result.value.paidAt).toBe("2026-04-24");
      }
    }
  });

  it("paid + ship → shipped", () => {
    const result = machine.apply(orderMachine, paid, { type: "ship", trackingNumber: "TRK-7" });
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value.kind === "shipped") {
      expect(result.value.trackingNumber).toBe("TRK-7");
    }
  });

  it("placed + cancel → cancelled", () => {
    const result = machine.apply(orderMachine, placed, {
      type: "cancel",
      reason: "payment failed",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value.kind === "cancelled") {
      expect(result.value.reason).toBe("payment failed");
    }
  });

  it("paid + cancel → cancelled (cancel is legal from multiple states)", () => {
    const result = machine.apply(orderMachine, paid, {
      type: "cancel",
      reason: "out of stock",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok" && result.value.kind === "cancelled") {
      expect(result.value.reason).toBe("out of stock");
    }
  });
});

// ── machine.apply — invalid transitions ───────────────────────────────────

describe("machine.apply — invalid transitions", () => {
  it("returns INVALID_TRANSITION when the event is illegal from this state", () => {
    // Can't ship a placed order — must pay first.
    const result = machine.apply(orderMachine, placed, {
      type: "ship",
      trackingNumber: "TRK-1",
    });
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error.type).toBe("INVALID_TRANSITION");
      expect(result.error.from).toBe("placed");
      expect(result.error.event).toBe("ship");
      expect(result.error.machine).toBe("order");
    }
  });

  it("returns INVALID_TRANSITION for every event from a terminal state", () => {
    // Shipped is terminal — no outbound transitions.
    for (const event of [
      { type: "pay" as const, paidAt: "2026-04-24" },
      { type: "ship" as const, trackingNumber: "TRK-1" },
      { type: "cancel" as const, reason: "late regret" },
    ]) {
      const result = machine.apply(orderMachine, shipped, event);
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.from).toBe("shipped");
      }
    }
  });

  it("never throws even when the state kind is unknown at runtime", () => {
    // A machine typed as `any` or a hand-rolled state could carry a kind
    // the transition table doesn't know about. apply must handle that
    // defensively without a throw.
    const bogusState = { kind: "ghost-state", customerId: "x" } as unknown as OrderState;
    const result = machine.apply(orderMachine, bogusState, {
      type: "pay",
      paidAt: "2026-04-24",
    });
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error.from).toBe("ghost-state");
    }
  });

  it("propagates throws from the transition function itself (bug, not domain failure)", () => {
    const buggy = machine.define<OrderState, OrderEvent>({
      name: "buggy",
      transitions: {
        placed: {
          pay: () => {
            throw new Error("oops");
          },
        },
        paid: {},
        shipped: {},
        cancelled: {},
      },
    });

    expect(() => machine.apply(buggy, placed, { type: "pay", paidAt: "2026-04-24" })).toThrow("oops");
  });
});

// ── machine.can ────────────────────────────────────────────────────────────

describe("machine.can", () => {
  it("returns true when the transition is declared", () => {
    expect(machine.can(orderMachine, placed, "pay")).toBe(true);
    expect(machine.can(orderMachine, paid, "ship")).toBe(true);
    expect(machine.can(orderMachine, placed, "cancel")).toBe(true);
  });

  it("returns false when the transition is not declared", () => {
    expect(machine.can(orderMachine, placed, "ship")).toBe(false);
    expect(machine.can(orderMachine, shipped, "pay")).toBe(false);
    expect(machine.can(orderMachine, cancelled, "ship")).toBe(false);
  });

  it("returns false for terminal states regardless of event", () => {
    for (const event of ["pay", "ship", "cancel"] as const) {
      expect(machine.can(orderMachine, shipped, event)).toBe(false);
      expect(machine.can(orderMachine, cancelled, event)).toBe(false);
    }
  });

  it("returns false for unknown state kinds at runtime", () => {
    const bogusState = { kind: "ghost-state", customerId: "x" } as unknown as OrderState;
    expect(machine.can(orderMachine, bogusState, "pay")).toBe(false);
  });
});

// ── Multi-step scenarios ───────────────────────────────────────────────────

describe("multi-step transitions compose by passing the Result", () => {
  it("placed → paid → shipped", () => {
    const step1 = machine.apply(orderMachine, placed, {
      type: "pay",
      paidAt: "2026-04-24",
    });
    if (step1._tag !== "Ok") throw new Error("step1 should have succeeded");

    const step2 = machine.apply(orderMachine, step1.value, {
      type: "ship",
      trackingNumber: "TRK-9",
    });
    if (step2._tag !== "Ok") throw new Error("step2 should have succeeded");

    expect(step2.value.kind).toBe("shipped");
    if (step2.value.kind === "shipped") {
      expect(step2.value.customerId).toBe("alice");
      expect(step2.value.trackingNumber).toBe("TRK-9");
    }
  });

  it("placed → paid → cancel works even after payment", () => {
    const step1 = machine.apply(orderMachine, placed, {
      type: "pay",
      paidAt: "2026-04-24",
    });
    if (step1._tag !== "Ok") throw new Error("step1 failed");

    const step2 = machine.apply(orderMachine, step1.value, {
      type: "cancel",
      reason: "customer regret",
    });
    expect(step2._tag).toBe("Ok");
  });
});

// ── Exhaustive dispatch via native switch ─────────────────────────────────

describe("exhaustive dispatch is the caller's job — native switch is the tool", () => {
  it("switching on state.kind with no default covers every variant", () => {
    // Adding a new state to OrderState would break compile here via `never`.
    function describe(state: OrderState): string {
      switch (state.kind) {
        case "placed":
          return `placed ${state.customerId}`;
        case "paid":
          return `paid at ${state.paidAt}`;
        case "shipped":
          return `shipped ${state.trackingNumber}`;
        case "cancelled":
          return `cancelled: ${state.reason}`;
      }
    }

    expect(describe(placed)).toBe("placed alice");
    expect(describe(paid)).toBe("paid at 2026-04-24");
    expect(describe(shipped)).toBe("shipped TRK-1");
    expect(describe(cancelled)).toBe("cancelled: customer request");
  });
});

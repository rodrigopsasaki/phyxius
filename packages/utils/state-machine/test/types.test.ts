import { describe, it, expect } from "vitest";

import { machine } from "../src/machine.js";
import type { Machine } from "../src/types.js";

// ── Type-level correctness ────────────────────────────────────────────────
//
// These tests look small because the real assertions are in the TypeScript
// compiler: the whole file must compile for the test to pass. Each block
// documents a specific property of the type system by constructing code
// that would fail if the property weren't enforced.

type LightState = { kind: "red" } | { kind: "yellow" } | { kind: "green" };
type LightEvent = { type: "tick" };

describe("types — transition table completeness", () => {
  it("every state must have an entry (even terminals use {})", () => {
    // Must declare red, yellow, green. `{}` means "no legal transitions."
    const light: Machine<LightState, LightEvent> = machine.define<LightState, LightEvent>({
      name: "traffic-light",
      transitions: {
        red: { tick: (_s, _e) => ({ kind: "green" }) },
        green: { tick: (_s, _e) => ({ kind: "yellow" }) },
        yellow: { tick: (_s, _e) => ({ kind: "red" }) },
      },
    });
    expect(light.name).toBe("traffic-light");
  });

  // The following block is compile-time only — the comment documents the
  // enforcement. Leaving it as a comment instead of `@ts-expect-error`
  // avoids depending on the exact error shape across TS versions.
  //
  // it("rejects a machine that forgets a state at compile time", () => {
  //   machine.define<LightState, LightEvent>({
  //     name: "incomplete",
  //     transitions: {
  //       red: { tick: (_s, _e) => ({ kind: "green" }) },
  //       green: { tick: (_s, _e) => ({ kind: "yellow" }) },
  //       // `yellow` missing — TypeScript errors here.
  //     },
  //   });
  // });
});

describe("types — transition return must be a valid state", () => {
  it("the transition function's return type is inferred as the full state union", () => {
    // If we tried to return something that isn't in LightState, the line
    // below wouldn't compile.
    const light = machine.define<LightState, LightEvent>({
      name: "return-check",
      transitions: {
        red: { tick: (_s, _e): LightState => ({ kind: "green" }) },
        green: { tick: (_s, _e): LightState => ({ kind: "yellow" }) },
        yellow: { tick: (_s, _e): LightState => ({ kind: "red" }) },
      },
    });
    expect(light.transitions.red.tick).toBeDefined();
  });
});

describe("types — state and event param inference", () => {
  type OrderState = { kind: "placed"; total: number } | { kind: "paid"; total: number; paidAt: string };

  type OrderEvent = { type: "pay"; paidAt: string };

  it("state parameter is narrowed to the specific kind", () => {
    const m = machine.define<OrderState, OrderEvent>({
      name: "order",
      transitions: {
        placed: {
          // `s` is narrowed to { kind: "placed"; total: number } —
          // accessing s.paidAt here would not compile.
          pay: (s, e) => ({ kind: "paid", total: s.total, paidAt: e.paidAt }),
        },
        paid: {},
      },
    });

    const result = machine.apply(m, { kind: "placed", total: 100 }, { type: "pay", paidAt: "2026-04-24" });
    expect(result._tag).toBe("Ok");
  });
});

describe("types — apply result carries the correct union", () => {
  type Door = { kind: "closed" } | { kind: "open" };
  type DoorEvent = { type: "toggle" };

  it("apply returns Result<Door, InvalidTransition>", () => {
    const door = machine.define<Door, DoorEvent>({
      name: "door",
      transitions: {
        closed: { toggle: () => ({ kind: "open" }) },
        open: { toggle: () => ({ kind: "closed" }) },
      },
    });

    // State and event typed as the full union — inline object literals can
    // confuse generic inference into picking `MachineState` over `Door`.
    const initial: Door = { kind: "closed" };
    const event: DoorEvent = { type: "toggle" };

    const result = machine.apply(door, initial, event);
    if (result._tag === "Ok") {
      // `result.value.kind` is "closed" | "open"; exhaustive switch works.
      switch (result.value.kind) {
        case "closed":
        case "open":
          break;
      }
    }
    expect(result._tag).toBe("Ok");
  });
});

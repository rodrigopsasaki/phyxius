import { describe, it, expect } from "vitest";

import { resolveGate } from "../src/parsers/gate";

describe("resolveGate", () => {
  it("is open when the value is unset", () => {
    expect(resolveGate(undefined)).toBe(true);
  });

  it("is closed only for an explicit false", () => {
    expect(resolveGate("false")).toBe(false);
    expect(resolveGate("FALSE")).toBe(false);
    expect(resolveGate("  false  ")).toBe(false);
  });

  it("is open for any other value", () => {
    expect(resolveGate("true")).toBe(true);
    expect(resolveGate("1")).toBe(true);
    expect(resolveGate("yes")).toBe(true);
  });
});

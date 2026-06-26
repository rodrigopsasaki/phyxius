import { describe, it, expect } from "vitest";

import { resolveGate } from "../src/parsers/gate";

describe("resolveGate", () => {
  it("is open when the value is unset", () => {
    expect(resolveGate(undefined)).toBe("open");
  });

  it("is closed only for an explicit false", () => {
    expect(resolveGate("false")).toBe("closed");
    expect(resolveGate("FALSE")).toBe("closed");
    expect(resolveGate("  false  ")).toBe("closed");
  });

  it("is open for any other value", () => {
    expect(resolveGate("true")).toBe("open");
    expect(resolveGate("1")).toBe("open");
    expect(resolveGate("yes")).toBe("open");
  });

  it("is open for empty or whitespace-only input (distinct from unset)", () => {
    expect(resolveGate("")).toBe("open");
    expect(resolveGate("   ")).toBe("open");
  });
});

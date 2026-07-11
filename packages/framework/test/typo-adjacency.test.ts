import { describe, expect, it } from "vitest";

import { editDistance, findTypoOfReservedKey } from "../src/typo-adjacency.js";

// ── editDistance ────────────────────────────────────────────────────────

describe("editDistance", () => {
  it("is 0 for identical strings", () => {
    expect(editDistance("observability", "observability")).toBe(0);
    expect(editDistance("", "")).toBe(0);
  });

  it("is the length of the other string against an empty string", () => {
    expect(editDistance("", "server")).toBe(6);
    expect(editDistance("server", "")).toBe(6);
  });

  it("is 1 for a single substitution", () => {
    expect(editDistance("server", "servor")).toBe(1);
  });

  it("is 1 for a single insertion", () => {
    expect(editDistance("server", "servver")).toBe(1);
  });

  it("is 1 for a single deletion — the brief's own example", () => {
    // "observabilty" is "observability" missing the second "i".
    expect(editDistance("observability", "observabilty")).toBe(1);
  });

  it("is 2+ for multiple edits", () => {
    expect(editDistance("observability", "observabilities")).toBeGreaterThanOrEqual(2);
    expect(editDistance("server", "client")).toBeGreaterThan(1);
  });

  it("is symmetric", () => {
    expect(editDistance("observabilty", "observability")).toBe(editDistance("observability", "observabilty"));
  });

  it("is case-sensitive by itself — callers decide whether to lowercase", () => {
    expect(editDistance("Server", "server")).toBe(1);
  });
});

// ── findTypoOfReservedKey ──────────────────────────────────────────────────

const RESERVED = ["server", "observability"] as const;

describe("findTypoOfReservedKey", () => {
  it("returns undefined for an exact match — it's the real key, not a typo", () => {
    expect(findTypoOfReservedKey("server", RESERVED)).toBeUndefined();
    expect(findTypoOfReservedKey("observability", RESERVED)).toBeUndefined();
  });

  it("flags the brief's own example — a missing letter", () => {
    expect(findTypoOfReservedKey("observabilty", RESERVED)).toBe("observability");
  });

  it("flags a single substitution against server", () => {
    expect(findTypoOfReservedKey("servr", RESERVED)).toBe("server");
    expect(findTypoOfReservedKey("servor", RESERVED)).toBe("server");
  });

  it("flags a pure case slip as a typo of the reserved key", () => {
    expect(findTypoOfReservedKey("Observability", RESERVED)).toBe("observability");
    expect(findTypoOfReservedKey("SERVER", RESERVED)).toBe("server");
  });

  it("does not flag an unrelated app key", () => {
    expect(findTypoOfReservedKey("features", RESERVED)).toBeUndefined();
    expect(findTypoOfReservedKey("database", RESERVED)).toBeUndefined();
  });

  it("does not flag a key that is far from any reserved name — narrow by design", () => {
    // A flattened-looking key like "server_port" is a legitimate app key
    // under this rule, not a near-miss of "server" — it's 5 edits away.
    expect(findTypoOfReservedKey("server_port", RESERVED)).toBeUndefined();
  });
});

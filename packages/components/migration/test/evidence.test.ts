import { describe, expect, it } from "vitest";

import { type Millis } from "@phyxiusjs/clock";
import { ok } from "@phyxiusjs/fp";

import { attestation, journalWindow, schemaApplied } from "../src/evidence.js";

// Thin tests — the constructors are thin wrappers around the evidence
// source union. The point here is to lock the discriminant shape so no
// renaming accident ships.

describe("evidence constructors", () => {
  it("journalWindow produces type 'journal-window' with the expected fields", () => {
    const ev = journalWindow({
      query: { name: "x" },
      windowMs: 1_000 as Millis,
      predicate: () => ok(undefined),
    });

    expect(ev.type).toBe("journal-window");
    expect(ev.query).toEqual({ name: "x" });
    expect(ev.windowMs).toBe(1_000);
    expect(typeof ev.predicate).toBe("function");
  });

  it("schemaApplied produces type 'schema-applied' with a check function", () => {
    const ev = schemaApplied({
      check: async () => ok({ applied: true }),
    });

    expect(ev.type).toBe("schema-applied");
    expect(typeof ev.check).toBe("function");
  });

  it("attestation produces type 'attestation' with a check function", () => {
    const ev = attestation({
      check: async () => ok({ signer: "alice" }),
    });

    expect(ev.type).toBe("attestation");
    expect(typeof ev.check).toBe("function");
  });
});

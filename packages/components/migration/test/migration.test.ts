import { describe, expect, it } from "vitest";

import { createControlledClock, type Millis } from "@phyxiusjs/clock";
import { err, isErr, isOk, ok } from "@phyxiusjs/fp";
import type { HandlerEvent } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";

import {
  attestation,
  createMemoryJournalStore,
  createMigration,
  defineMigration,
  journalWindow,
  schemaApplied,
} from "../src/index.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRuntime() {
  const clock = createControlledClock({ initialTime: 1_000_000 });
  const journal = new Journal<HandlerEvent>({ clock });
  const journalStore = createMemoryJournalStore({ journal, clock });
  return { clock, journal, journalStore };
}

// The canonical 4-phase shape. These tests exercise the full expand-and-
// contract lifecycle — each phase declares its own evidence, advance()
// runs the evidence, and failures leave the phase where it is.

// ── defineMigration ────────────────────────────────────────────────────────

describe("defineMigration", () => {
  it("validates that at least two phases are declared", () => {
    expect(() =>
      defineMigration({
        name: "too-few",
        phases: {
          only: { evidence: {} },
        },
      }),
    ).toThrow(/at least two phases/);
  });

  it("validates that name is non-empty", () => {
    expect(() =>
      defineMigration({
        name: "",
        phases: {
          a: { evidence: {} },
          b: { evidence: {} },
        },
      }),
    ).toThrow(/name must be non-empty/);
  });

  it("returns the spec unchanged when valid", () => {
    const spec = defineMigration({
      name: "ok",
      phases: {
        a: { evidence: {} },
        b: { evidence: {} },
      },
    });
    expect(spec.name).toBe("ok");
    expect(Object.keys(spec.phases)).toEqual(["a", "b"]);
  });
});

// ── createMigration — starting state ───────────────────────────────────────

describe("createMigration — starting state", () => {
  it("starts at the first declared phase by default", async () => {
    const spec = defineMigration({
      name: "test",
      phases: {
        expand: { evidence: {} },
        dualWrite: { evidence: {} },
        flip: { evidence: {} },
        contract: { evidence: {} },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });

    expect(await running.currentPhase()).toBe("expand");
  });

  it("honors an explicit initial phase", async () => {
    const spec = defineMigration({
      name: "test",
      phases: {
        expand: { evidence: {} },
        dualWrite: { evidence: {} },
        flip: { evidence: {} },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore, initialPhase: "dualWrite" });

    expect(await running.currentPhase()).toBe("dualWrite");
  });

  it("refuses to construct with an unknown initial phase", () => {
    const spec = defineMigration({
      name: "test",
      phases: {
        expand: { evidence: {} },
        dualWrite: { evidence: {} },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    expect(() => createMigration(spec, { clock, journal, journalStore, initialPhase: "not-a-phase" })).toThrow(
      /not a declared phase/,
    );
  });
});

// ── advance() — happy path ─────────────────────────────────────────────────

describe("advance — happy path", () => {
  it("advances when all evidence resolves Ok", async () => {
    const spec = defineMigration({
      name: "happy",
      phases: {
        expand: { evidence: {} },
        dualWrite: {
          evidence: {
            schemaReady: schemaApplied({
              check: async () => ok({ revision: "abc123" }),
            }),
          },
        },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });

    const result = await running.advance();

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.from).toBe("expand");
      expect(result.value.to).toBe("dualWrite");
      expect(result.value.evidence).toEqual({ schemaReady: { revision: "abc123" } });
    }
    expect(await running.currentPhase()).toBe("dualWrite");
  });

  it("runs multiple evidence sources in parallel and merges the snapshot", async () => {
    const spec = defineMigration({
      name: "multi-evidence",
      phases: {
        start: { evidence: {} },
        next: {
          evidence: {
            schemaReady: schemaApplied({ check: async () => ok({ applied: true }) }),
            humanApproved: attestation({ check: async () => ok({ signer: "alice" }) }),
          },
        },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });
    const result = await running.advance();

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.evidence).toEqual({
        schemaReady: { applied: true },
        humanApproved: { signer: "alice" },
      });
    }
  });

  it("writes a success journal entry on advance", async () => {
    const spec = defineMigration({
      name: "audit-check",
      phases: {
        a: { evidence: {} },
        b: { evidence: { ok: attestation({ check: async () => ok(undefined) }) } },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });
    await running.advance();

    const { entries } = journal.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data.name).toBe("migration.audit-check.advance");
    expect(entries[0]!.data.source).toBe("migration");
    expect(entries[0]!.data.outcome).toBe("success");
    expect(entries[0]!.data.observed).toMatchObject({
      migration: "audit-check",
      from: "a",
      attempted: "b",
    });
  });
});

// ── advance() — wrong-until-proven-otherwise ───────────────────────────────

describe("advance — wrong-until-proven-otherwise", () => {
  it("refuses when an evidence predicate returns Err", async () => {
    const spec = defineMigration({
      name: "fail-check",
      phases: {
        a: { evidence: {} },
        b: {
          evidence: {
            hasIt: schemaApplied({
              check: async () => err({ reason: "migration not applied" }),
            }),
          },
        },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });

    const result = await running.advance();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.type).toBe("EVIDENCE_FAILED");
      if (result.error.type === "EVIDENCE_FAILED") {
        expect(result.error.attemptedPhase).toBe("b");
        expect(result.error.failures["hasIt"]!.reason).toBe("migration not applied");
      }
    }
    // Phase is unchanged.
    expect(await running.currentPhase()).toBe("a");
  });

  it("refuses when an evidence source throws", async () => {
    const spec = defineMigration({
      name: "error-check",
      phases: {
        a: { evidence: {} },
        b: {
          evidence: {
            storeDown: schemaApplied({
              check: async () => {
                throw new Error("database unreachable");
              },
            }),
          },
        },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });

    const result = await running.advance();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.type).toBe("EVIDENCE_ERRORED");
      if (result.error.type === "EVIDENCE_ERRORED") {
        expect(result.error.attemptedPhase).toBe("b");
        expect(Object.keys(result.error.errors)).toContain("storeDown");
      }
    }
    // Phase is unchanged.
    expect(await running.currentPhase()).toBe("a");
  });

  it("reports EVIDENCE_ERRORED when errors and failures both exist (errors trump)", async () => {
    const spec = defineMigration({
      name: "mixed",
      phases: {
        a: { evidence: {} },
        b: {
          evidence: {
            predicateFail: schemaApplied({ check: async () => err({ reason: "not yet" }) }),
            threw: schemaApplied({
              check: async () => {
                throw new Error("boom");
              },
            }),
          },
        },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });
    const result = await running.advance();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.type).toBe("EVIDENCE_ERRORED");
    }
  });

  it("writes a failure journal entry for refused advance — outcome=failure, refusal in observed", async () => {
    const spec = defineMigration({
      name: "refused",
      phases: {
        a: { evidence: {} },
        b: { evidence: { fails: schemaApplied({ check: async () => err({ reason: "nope" }) }) } },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });
    await running.advance();

    const { entries } = journal.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data.outcome).toBe("failure");
    expect(entries[0]!.data.observed).toMatchObject({
      refusal: { type: "EVIDENCE_FAILED" },
    });
    // No `error` field — the refusal lives in `observed` because it's
    // not a handler-error variant.
    expect(entries[0]!.data.error).toBeUndefined();
  });

  it("refuses when already at the final phase", async () => {
    const spec = defineMigration({
      name: "terminal",
      phases: {
        a: { evidence: {} },
        b: { evidence: {} },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore, initialPhase: "b" });
    const result = await running.advance();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.type).toBe("ALREADY_AT_FINAL");
    }
  });
});

// ── advance() — journalWindow evidence ─────────────────────────────────────

describe("advance — journalWindow evidence", () => {
  function appendEvent(journal: Journal<HandlerEvent>, overrides: Partial<HandlerEvent>): void {
    journal.append({
      name: "test.handler",
      invocationId: "inv-x",
      source: "test",
      startedAt: { wallMs: 0, monoMs: 0 },
      completedAt: { wallMs: 0, monoMs: 0 },
      durationMs: 0,
      attempts: 1,
      outcome: "success",
      observed: {},
      ...overrides,
    });
  }

  it("advances when the window query returns zero matching events", async () => {
    const { clock, journal, journalStore } = makeRuntime();

    // The journal has events, just not of the legacy type.
    appendEvent(journal, {
      name: "order.create-new",
      completedAt: { wallMs: 999_500, monoMs: 999_500 },
    });

    const spec = defineMigration({
      name: "zero-legacy",
      phases: {
        flip: { evidence: {} },
        contract: {
          evidence: {
            zeroLegacyWrites: journalWindow({
              query: { name: "order.create-legacy" },
              windowMs: 100_000 as Millis,
              predicate: (events) =>
                events.length === 0
                  ? ok({ count: 0 })
                  : err({ reason: "saw legacy events", details: { count: events.length } }),
            }),
          },
        },
      },
    });

    const running = createMigration(spec, { clock, journal, journalStore });
    const result = await running.advance();

    expect(isOk(result)).toBe(true);
    expect(await running.currentPhase()).toBe("contract");
  });

  it("refuses when the window query finds matching events", async () => {
    const { clock, journal, journalStore } = makeRuntime();

    // A single legacy write in the window — enough to refuse.
    appendEvent(journal, {
      name: "order.create-legacy",
      completedAt: { wallMs: 999_500, monoMs: 999_500 },
    });

    const spec = defineMigration({
      name: "has-legacy",
      phases: {
        flip: { evidence: {} },
        contract: {
          evidence: {
            zeroLegacyWrites: journalWindow({
              query: { name: "order.create-legacy" },
              windowMs: 100_000 as Millis,
              predicate: (events) =>
                events.length === 0
                  ? ok({ count: 0 })
                  : err({ reason: "saw legacy events", details: { count: events.length } }),
            }),
          },
        },
      },
    });

    const running = createMigration(spec, { clock, journal, journalStore });
    const result = await running.advance();

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.type === "EVIDENCE_FAILED") {
      expect(result.error.failures["zeroLegacyWrites"]!.reason).toBe("saw legacy events");
      expect(result.error.failures["zeroLegacyWrites"]!.details).toEqual({ count: 1 });
    }
    expect(await running.currentPhase()).toBe("flip");
  });

  it("uses the `observed` field predicate for richer claims", async () => {
    const { clock, journal, journalStore } = makeRuntime();

    // Every order.create in window has a salesDocumentId — the "new
    // path was used" claim.
    appendEvent(journal, {
      name: "order.create",
      observed: { salesDocumentId: "sd_1" },
      completedAt: { wallMs: 999_500, monoMs: 999_500 },
    });
    appendEvent(journal, {
      name: "order.create",
      observed: { salesDocumentId: "sd_2" },
      completedAt: { wallMs: 999_600, monoMs: 999_600 },
    });

    const spec = defineMigration({
      name: "every-new-path",
      phases: {
        dualWrite: { evidence: {} },
        flip: {
          evidence: {
            everyNewPath: journalWindow({
              query: { name: "order.create" },
              windowMs: 100_000 as Millis,
              predicate: (events) => {
                const missing = events.filter((e) => e.observed["salesDocumentId"] === undefined);
                return missing.length === 0
                  ? ok({ checked: events.length })
                  : err({
                      reason: "some events missing salesDocumentId",
                      details: { missing: missing.length },
                    });
              },
            }),
          },
        },
      },
    });

    const running = createMigration(spec, { clock, journal, journalStore });
    const result = await running.advance();

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.evidence).toEqual({ everyNewPath: { checked: 2 } });
    }
  });
});

// ── CAS / concurrent advance ───────────────────────────────────────────────

describe("advance — concurrent calls", () => {
  it("only one of two concurrent advances succeeds; the other sees CAS_LOST", async () => {
    const spec = defineMigration({
      name: "concurrent",
      phases: {
        a: { evidence: {} },
        b: {
          evidence: {
            ok: schemaApplied({ check: async () => ok(undefined) }),
          },
        },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });

    const [r1, r2] = await Promise.all([running.advance(), running.advance()]);

    const wins = [r1, r2].filter(isOk);
    const losses = [r1, r2].filter(isErr);

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);

    // The loser either saw CAS_LOST (evidence ran then we lost the race)
    // or ALREADY_AT_FINAL (in a 2-phase spec the winner moved us to b,
    // and the loser then has no further phase to advance to). Both are
    // valid — what matters is only one winner.
    if (isErr(losses[0]!)) {
      expect(["CAS_LOST", "ALREADY_AT_FINAL"]).toContain(losses[0]!.error.type);
    }
    expect(await running.currentPhase()).toBe("b");
  });
});

// ── Runtime query — handlers branch on currentPhase ────────────────────────

describe("currentPhase — runtime query for dispatch-time branching", () => {
  it("reflects the latest committed phase on every read", async () => {
    const spec = defineMigration({
      name: "live-phase",
      phases: {
        expand: { evidence: {} },
        dualWrite: { evidence: { ok: attestation({ check: async () => ok(undefined) }) } },
        flip: { evidence: { ok: attestation({ check: async () => ok(undefined) }) } },
      },
    });

    const { clock, journal, journalStore } = makeRuntime();
    const running = createMigration(spec, { clock, journal, journalStore });

    expect(await running.currentPhase()).toBe("expand");
    await running.advance();
    expect(await running.currentPhase()).toBe("dualWrite");
    await running.advance();
    expect(await running.currentPhase()).toBe("flip");
  });
});

import { describe, expect, it } from "vitest";

import { createControlledClock } from "@phyxiusjs/clock";
import { err, ok } from "@phyxiusjs/fp";
import type { HandlerEvent } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";

import { attestation } from "../src/evidence.js";
import { runEvidenceBag } from "../src/evidence-runner.js";
import { createMemoryJournalStore } from "../src/store.js";

// `runEvidenceBag` was lifted out of `createMigration`'s internals (see
// evidence-runner.ts's header) so it can run independently of any phase or
// CAS semantics. These tests exercise it directly — `migration.test.ts`
// already exercises it indirectly through `advance()`.

function makeDeps() {
  const clock = createControlledClock({ initialTime: 0 });
  const journal = new Journal<HandlerEvent>({ clock });
  const journalStore = createMemoryJournalStore({ journal, clock });
  return { journalStore };
}

describe("runEvidenceBag", () => {
  it("returns an all-ok snapshot when every source resolves Ok", async () => {
    const deps = makeDeps();
    const result = await runEvidenceBag(
      { a: attestation({ check: async () => ok("a-value") }), b: attestation({ check: async () => ok("b-value") }) },
      deps,
    );

    expect(result.snapshot).toEqual({ a: "a-value", b: "b-value" });
    expect(result.failures).toEqual({});
    expect(result.errors).toEqual({});
  });

  it("collects Err results into `failures`, keyed by label", async () => {
    const deps = makeDeps();
    const result = await runEvidenceBag({ a: attestation({ check: async () => err({ reason: "not yet" }) }) }, deps);

    expect(result.snapshot).toEqual({});
    expect(result.failures).toEqual({ a: { reason: "not yet" } });
    expect(result.errors).toEqual({});
  });

  it("collects thrown values into `errors`, keyed by label, without propagating", async () => {
    const deps = makeDeps();
    const result = await runEvidenceBag(
      {
        a: attestation({
          check: async () => {
            throw new Error("store unreachable");
          },
        }),
      },
      deps,
    );

    expect(result.snapshot).toEqual({});
    expect(result.failures).toEqual({});
    expect(Object.keys(result.errors)).toEqual(["a"]);
  });

  it("an empty bag resolves with everything empty", async () => {
    const deps = makeDeps();
    const result = await runEvidenceBag({}, deps);

    expect(result).toEqual({ snapshot: {}, failures: {}, errors: {} });
  });
});

import { describe, expect, it } from "vitest";

import { createControlledClock, type Instant, type Millis } from "@phyxiusjs/clock";
import { isErr, isOk } from "@phyxiusjs/fp";
import type { HandlerEvent } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";

import { createMemoryJournalStore, createMemoryPhaseStore } from "../src/store.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Test-only fixture: an Instant with both faces set to the same number.
 * `as Instant` is the sanctioned escape hatch for fabricating one outside a
 * real clock reading — see @phyxiusjs/clock's MonoMs docs.
 */
function instant(ms: number): Instant {
  return { wallMs: ms, monoMs: ms } as Instant;
}

function makeEvent(overrides: Partial<HandlerEvent>): HandlerEvent {
  return {
    name: "test.handler",
    invocationId: "inv-1",
    source: "test",
    startedAt: instant(0),
    completedAt: instant(0),
    durationMs: 0,
    attempts: 1,
    outcome: "success",
    observed: {},
    ...overrides,
  };
}

// ── createMemoryJournalStore ───────────────────────────────────────────────

describe("createMemoryJournalStore", () => {
  it("returns events inside the window", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<HandlerEvent>({ clock });

    journal.append(makeEvent({ completedAt: instant(900) }));
    journal.append(makeEvent({ completedAt: instant(950) }));

    const store = createMemoryJournalStore({ journal, clock });
    const events = await store.query({}, 200 as Millis);

    expect(events).toHaveLength(2);
  });

  it("excludes events older than the window", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<HandlerEvent>({ clock });

    journal.append(makeEvent({ completedAt: instant(500) })); // out
    journal.append(makeEvent({ completedAt: instant(850) })); // in
    journal.append(makeEvent({ completedAt: instant(950) })); // in

    const store = createMemoryJournalStore({ journal, clock });
    const events = await store.query({}, 200 as Millis);

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.completedAt.wallMs >= 800)).toBe(true);
  });

  it("filters by name", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<HandlerEvent>({ clock });

    journal.append(makeEvent({ name: "order.create", completedAt: instant(900) }));
    journal.append(makeEvent({ name: "order.cancel", completedAt: instant(900) }));
    journal.append(makeEvent({ name: "order.create", completedAt: instant(950) }));

    const store = createMemoryJournalStore({ journal, clock });
    const events = await store.query({ name: "order.create" }, 200 as Millis);

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.name === "order.create")).toBe(true);
  });

  it("filters by outcome", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<HandlerEvent>({ clock });

    journal.append(makeEvent({ outcome: "success", completedAt: instant(900) }));
    journal.append(makeEvent({ outcome: "failure", completedAt: instant(900) }));

    const store = createMemoryJournalStore({ journal, clock });
    const events = await store.query({ outcome: "failure" }, 200 as Millis);

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("failure");
  });

  it("applies custom where predicate", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<HandlerEvent>({ clock });

    journal.append(
      makeEvent({
        observed: { table: "legacy_users" },
        completedAt: instant(900),
      }),
    );
    journal.append(
      makeEvent({
        observed: { table: "users" },
        completedAt: instant(900),
      }),
    );

    const store = createMemoryJournalStore({ journal, clock });
    const events = await store.query({ where: (e) => e.observed["table"] === "legacy_users" }, 200 as Millis);

    expect(events).toHaveLength(1);
  });

  it("respects the limit cap", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<HandlerEvent>({ clock });

    for (let i = 0; i < 10; i++) {
      journal.append(makeEvent({ completedAt: instant(900 + i) }));
    }

    const store = createMemoryJournalStore({ journal, clock });
    const events = await store.query({ limit: 3 }, 200 as Millis);

    expect(events).toHaveLength(3);
  });

  it("returns empty array when no events match", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<HandlerEvent>({ clock });

    const store = createMemoryJournalStore({ journal, clock });
    const events = await store.query({ name: "never-emitted" }, 200 as Millis);

    expect(events).toEqual([]);
  });
});

// ── createMemoryPhaseStore ─────────────────────────────────────────────────

describe("createMemoryPhaseStore", () => {
  it("starts at the initial phase", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const store = createMemoryPhaseStore({ initial: "expand", clock });

    expect(await store.current()).toBe("expand");
  });

  it("advances when the CAS matches the current phase", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const store = createMemoryPhaseStore({ initial: "expand", clock });

    const result = await store.tryAdvance("expand", "dualWrite", {});

    expect(isOk(result)).toBe(true);
    expect(await store.current()).toBe("dualWrite");
  });

  it("rejects when the CAS does NOT match", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const store = createMemoryPhaseStore({ initial: "expand", clock });

    // Try to advance from a phase we're not at.
    const result = await store.tryAdvance("dualWrite", "flip", {});

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.actual).toBe("expand");
    }
    // Phase is unchanged — the whole point of CAS.
    expect(await store.current()).toBe("expand");
  });

  it("serializes concurrent advances — only one wins", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const store = createMemoryPhaseStore({ initial: "expand", clock });

    // Two callers both try to advance from expand → dualWrite at once.
    // Because the store is single-threaded JS, whichever resolves its
    // `await` first wins; the other sees the new phase.
    const [a, b] = await Promise.all([
      store.tryAdvance("expand", "dualWrite", {}),
      store.tryAdvance("expand", "dualWrite", {}),
    ]);

    const wins = [a, b].filter(isOk);
    const losses = [a, b].filter(isErr);

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
  });

  it("returns the clock's current Instant on successful advance", async () => {
    const clock = createControlledClock({ initialTime: 42 });
    const store = createMemoryPhaseStore({ initial: "expand", clock });

    const result = await store.tryAdvance("expand", "dualWrite", {});

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.at.wallMs).toBe(42);
    }
  });
});

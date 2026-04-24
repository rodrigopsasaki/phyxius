import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock, ms } from "@phyxiusjs/clock";

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be defined");
  return value;
}

describe("Atom Versioning Basic", () => {
  it("should follow version monotonicity and equal write behavior", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const changes: Array<{ from: number; to: number; version: number }> = [];

    // Track all changes
    atom.watch((change) => {
      changes.push({ from: change.from, to: change.to, version: change.versionTo });
    });

    // Initial state
    expect(atom.version()).toBe(0);
    expect(atom.deref()).toBe(0);

    // Equal write should not increment version or notify
    atom.reset(0);
    expect(atom.version()).toBe(0); // No change
    expect(changes).toHaveLength(0); // No notification

    // Advance time and make first real change
    clock.advanceBy(ms(100));
    atom.swap((n) => n + 1);
    expect(atom.version()).toBe(1);
    expect(atom.deref()).toBe(1);

    // Advance time and make second change
    clock.advanceBy(ms(50));
    atom.swap((n) => n + 1);
    expect(atom.version()).toBe(2);
    expect(atom.deref()).toBe(2);

    // Verify notifications happened in order
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual({ from: 0, to: 1, version: 1 });
    expect(changes[1]).toEqual({ from: 1, to: 2, version: 2 });

    // Verify monotonic time across watch events (the durable observability channel)
    for (let i = 1; i < changes.length; i++) {
      const prev = changes[i - 1];
      const curr = changes[i];
      if (!prev || !curr) continue;
      expect(curr.version).toBeGreaterThan(prev.version);
    }

    // When opted in, history also reflects monotonic time
    const atomWithHistory = createAtom(0, clock, { historySize: 10 });
    clock.advanceBy(ms(10));
    atomWithHistory.swap((n) => n + 1);
    clock.advanceBy(ms(10));
    atomWithHistory.swap((n) => n + 1);
    const history = atomWithHistory.history();
    for (let i = 1; i < history.length; i++) {
      expect(defined(history[i]).at.monoMs).toBeGreaterThanOrEqual(defined(history[i - 1]).at.monoMs);
    }
  });
});

import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Atom History Ring Buffer", () => {
  it("should maintain ring buffer with specified size", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("x", clock, { historySize: 2 });

    // Initial state should be in history
    expect(atom.history().map((s) => s.value)).toEqual(["x"]);
    expect(atom.history()).toHaveLength(1);

    clock.advanceBy(ms(100));
    atom.reset("y");
    expect(atom.history().map((s) => s.value)).toEqual(["x", "y"]);
    expect(atom.history()).toHaveLength(2);

    clock.advanceBy(ms(100));
    atom.reset("z");
    expect(atom.history().map((s) => s.value)).toEqual(["y", "z"]);
    expect(atom.history()).toHaveLength(2);

    clock.advanceBy(ms(100));
    atom.reset("w");
    expect(atom.history().map((s) => s.value)).toEqual(["z", "w"]);
    expect(atom.history()).toHaveLength(2);
  });

  it("should handle historySize of 1 (default)", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(10, clock); // Default historySize is 1

    expect(atom.history()).toHaveLength(1);
    expect(atom.history()[0]!.value).toBe(10);

    atom.reset(20);
    expect(atom.history()).toHaveLength(1);
    expect(atom.history()[0]!.value).toBe(20);

    atom.reset(30);
    expect(atom.history()).toHaveLength(1);
    expect(atom.history()[0]!.value).toBe(30);
  });

  it("should clear history but preserve current value", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("initial", clock, { historySize: 3 });

    clock.advanceBy(ms(50));
    atom.reset("first");
    clock.advanceBy(ms(50));
    atom.reset("second");
    clock.advanceBy(ms(50));
    atom.reset("third");

    // Should have 3 snapshots
    expect(atom.history()).toHaveLength(3);
    expect(atom.history().map((s) => s.value)).toEqual(["first", "second", "third"]);

    // Clear history
    atom.clearHistory();

    // History should contain only current snapshot, but current value unchanged
    expect(atom.history()).toHaveLength(1);
    expect(atom.deref()).toBe("third");
    expect(atom.version()).toBe(3); // Version unchanged

    // New changes should start building history again
    clock.advanceBy(ms(50));
    atom.reset("after-clear");
    expect(atom.history()).toHaveLength(2);
    expect(atom.history()[1]!.value).toBe("after-clear");
  });

  it("should preserve version and timestamp info in history", () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const atom = createAtom(0, clock, { historySize: 3, baseVersion: 5 });

    clock.advanceBy(ms(100));
    atom.swap((n) => n + 1);

    clock.advanceBy(ms(200));
    atom.swap((n) => n + 1);

    const history = atom.history();
    expect(history).toHaveLength(3);

    // Check first snapshot (after first change)
    expect(history[1]!.value).toBe(1);
    expect(history[1]!.version).toBe(6); // baseVersion + 1
    expect(history[1]!.at.monoMs).toBe(1100);

    // Check second snapshot (after second change)
    expect(history[2]!.value).toBe(2);
    expect(history[2]!.version).toBe(7); // baseVersion + 2
    expect(history[2]!.at.monoMs).toBe(1300);
  });

  it("should not add to history on equal writes", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("value", clock, { historySize: 5 });

    expect(atom.history()).toHaveLength(1);

    // Equal write should not add to history
    atom.reset("value");
    expect(atom.history()).toHaveLength(1);
    expect(atom.history()[0]!.value).toBe("value");

    // Different write should add to history
    atom.reset("new-value");
    expect(atom.history()).toHaveLength(2);
    expect(atom.history().map((s) => s.value)).toEqual(["value", "new-value"]);
  });
});

import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Atom Deterministic Time", () => {
  it("should use clock.now() for all timestamps", () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const atom = createAtom("initial", clock);
    const changes: Array<{ at: { wallMs: number; monoMs: number } }> = [];

    atom.watch((change) => {
      changes.push({ at: change.at });
    });

    // Initial snapshot should have correct timestamp
    const initialSnapshot = atom.snapshot();
    expect(initialSnapshot.at.wallMs).toBe(1000);
    expect(initialSnapshot.at.monoMs).toBe(1000);

    // Advance time and make change
    clock.advanceBy(ms(500));
    atom.reset("first-change");

    expect(changes).toHaveLength(1);
    expect(changes[0]!.at.wallMs).toBe(1500);
    expect(changes[0]!.at.monoMs).toBe(1500);

    // Advance time again
    clock.advanceBy(ms(300));
    atom.reset("second-change");

    expect(changes).toHaveLength(2);
    expect(changes[1]!.at.wallMs).toBe(1800);
    expect(changes[1]!.at.monoMs).toBe(1800);

    // Verify current snapshot
    const currentSnapshot = atom.snapshot();
    expect(currentSnapshot.at.wallMs).toBe(1800);
    expect(currentSnapshot.at.monoMs).toBe(1800);
  });

  it("should maintain monotonic time in successive changes", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock, { historySize: 10 });

    // Make several changes with time advances
    const timeAdvances = [100, 50, 200, 25, 75];

    for (let i = 0; i < timeAdvances.length; i++) {
      clock.advanceBy(ms(timeAdvances[i]!));
      atom.swap((n) => n + 1);
    }

    const history = atom.history();
    expect(history).toHaveLength(6); // Initial + 5 changes

    // Verify monotonic time (skip initial snapshot at index 0)
    let expectedTime = 0;
    for (let i = 1; i < history.length; i++) {
      expectedTime += timeAdvances[i - 1]!;
      expect(history[i]!.at.monoMs).toBe(expectedTime);
      expect(history[i]!.at.wallMs).toBe(expectedTime);

      // Ensure monotonic property
      if (i > 0) {
        expect(history[i]!.at.monoMs).toBeGreaterThanOrEqual(history[i - 1]!.at.monoMs);
      }
    }
  });

  it("should handle wall time jumps correctly", () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const atom = createAtom("start", clock);
    const timestamps: Array<{ wallMs: number; monoMs: number }> = [];

    atom.watch((change) => {
      timestamps.push({
        wallMs: change.at.wallMs,
        monoMs: change.at.monoMs,
      });
    });

    // Normal time advancement
    clock.advanceBy(ms(100));
    atom.reset("change1");

    // Jump wall time (but keep monotonic continuous)
    clock.jumpWallTime(5000);
    atom.reset("change2");

    // Advance time normally again
    clock.advanceBy(ms(200));
    atom.reset("change3");

    expect(timestamps).toHaveLength(3);

    // Verify monotonic time is always increasing
    expect(timestamps[0]!.monoMs).toBe(1100); // 1000 + 100
    expect(timestamps[1]!.monoMs).toBe(1100); // Same monotonic time after jump
    expect(timestamps[2]!.monoMs).toBe(1300); // 1100 + 200

    // Verify wall time reflects the jump
    expect(timestamps[0]!.wallMs).toBe(1100);
    expect(timestamps[1]!.wallMs).toBe(5000); // Jumped
    expect(timestamps[2]!.wallMs).toBe(5200); // 5000 + 200
  });

  it("should synchronize timestamps across multiple atoms with same clock", () => {
    const clock = createControlledClock({ initialTime: 2000 });
    const atom1 = createAtom("atom1", clock);
    const atom2 = createAtom("atom2", clock);

    const atom1Changes: Array<{ at: any }> = [];
    const atom2Changes: Array<{ at: any }> = [];

    atom1.watch((change) => atom1Changes.push({ at: change.at }));
    atom2.watch((change) => atom2Changes.push({ at: change.at }));

    // Make changes at the same time
    atom1.reset("changed1");
    atom2.reset("changed2");

    // Both should have same timestamp
    expect(atom1Changes[0]!.at.wallMs).toBe(2000);
    expect(atom2Changes[0]!.at.wallMs).toBe(2000);
    expect(atom1Changes[0]!.at.monoMs).toBe(2000);
    expect(atom2Changes[0]!.at.monoMs).toBe(2000);

    // Advance and make more changes
    clock.advanceBy(ms(150));
    atom1.reset("changed1-again");
    atom2.reset("changed2-again");

    expect(atom1Changes[1]!.at.wallMs).toBe(2150);
    expect(atom2Changes[1]!.at.wallMs).toBe(2150);
    expect(atom1Changes[1]!.at.monoMs).toBe(2150);
    expect(atom2Changes[1]!.at.monoMs).toBe(2150);
  });

  it("should preserve exact timing in history", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock, { historySize: 5 });

    const plannedSchedule = [
      { advance: 100, value: 1 },
      { advance: 250, value: 2 },
      { advance: 50, value: 3 },
      { advance: 300, value: 4 },
    ];

    for (const step of plannedSchedule) {
      clock.advanceBy(ms(step.advance));
      atom.reset(step.value);
    }

    const history = atom.history();
    expect(history).toHaveLength(5); // Initial + 4 changes

    // Verify each entry has exactly the expected timestamp (skip initial at index 0)
    const expectedTimes = [100, 350, 400, 700];
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.at.wallMs).toBe(expectedTimes[i - 1]);
      expect(history[i]!.at.monoMs).toBe(expectedTimes[i - 1]);
      expect(history[i]!.value).toBe(i);
    }
  });

  it("should not use Date.now() anywhere (deterministic test)", () => {
    // This test ensures the atom uses only the injected clock
    const clock = createControlledClock({ initialTime: 42 });
    const atom = createAtom("test", clock);

    // Mock Date.now to return a different value
    const originalDateNow = Date.now;
    Date.now = () => 999999;

    try {
      atom.reset("changed");
      const snapshot = atom.snapshot();

      // Should use clock time (42), not Date.now() (999999)
      expect(snapshot.at.wallMs).toBe(42);
      expect(snapshot.at.monoMs).toBe(42);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

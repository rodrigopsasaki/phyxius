import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Atom Compare-and-Set Semantics", () => {
  it("should fail CAS with Object.is by default (reference equality)", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom({ n: 1 }, clock);
    const changes: unknown[] = [];

    atom.watch(() => changes.push("notified"));

    // CAS should fail - different object reference
    const success = atom.compareAndSet({ n: 1 }, { n: 2 });

    expect(success).toBe(false);
    expect(atom.deref()).toEqual({ n: 1 }); // Value unchanged
    expect(atom.version()).toBe(0); // Version unchanged
    expect(changes).toHaveLength(0); // No notification
  });

  it("should succeed CAS with Object.is when reference matches", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const initialValue = { n: 1 };
    const atom = createAtom(initialValue, clock);
    const changes: unknown[] = [];

    atom.watch(() => changes.push("notified"));

    // CAS should succeed - same reference
    const success = atom.compareAndSet(initialValue, { n: 2 });

    expect(success).toBe(true);
    expect(atom.deref()).toEqual({ n: 2 }); // Value changed
    expect(atom.version()).toBe(1); // Version incremented
    expect(changes).toHaveLength(1); // Notification sent
  });

  it("should use custom equals function for CAS", () => {
    const deepEquals = (a: { n: number }, b: { n: number }) => a.n === b.n;
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom({ n: 1 }, clock, { equals: deepEquals });
    const changes: Array<{ from: any; to: any }> = [];

    atom.watch((change) => changes.push({ from: change.from, to: change.to }));

    // CAS should succeed with deep equality
    const success = atom.compareAndSet({ n: 1 }, { n: 2 });

    expect(success).toBe(true);
    expect(atom.deref()).toEqual({ n: 2 });
    expect(atom.version()).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ from: { n: 1 }, to: { n: 2 } });
  });

  it("should fail CAS when current value doesn't match expected", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(5, clock);
    const changes: unknown[] = [];

    atom.watch(() => changes.push("notified"));

    // Change the value first
    atom.reset(10);
    expect(changes).toHaveLength(1);

    // CAS should fail - expected value doesn't match current
    const success = atom.compareAndSet(5, 15);

    expect(success).toBe(false);
    expect(atom.deref()).toBe(10); // Value unchanged from first reset
    expect(atom.version()).toBe(1); // No additional version increment
    expect(changes).toHaveLength(1); // No additional notification
  });

  it("should support cause metadata in CAS", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("initial", clock);
    let capturedChange: any;

    atom.watch((change) => {
      capturedChange = change;
    });

    const success = atom.compareAndSet("initial", "updated", { cause: "test-cas" });

    expect(success).toBe(true);
    expect(capturedChange.cause).toBe("test-cas");
    expect(capturedChange.from).toBe("initial");
    expect(capturedChange.to).toBe("updated");
  });

  it("should handle concurrent CAS operations", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);

    // Simulate concurrent CAS operations
    const result1 = atom.compareAndSet(0, 1);
    const result2 = atom.compareAndSet(0, 2); // Should fail, value is now 1

    expect(result1).toBe(true);
    expect(result2).toBe(false);
    expect(atom.deref()).toBe(1);
    expect(atom.version()).toBe(1); // Only one successful update
  });

  it("should work with custom equals for strings (case-insensitive)", () => {
    const caseInsensitiveEquals = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("Hello", clock, { equals: caseInsensitiveEquals });

    // Should succeed with different case
    const success1 = atom.compareAndSet("HELLO", "World");
    expect(success1).toBe(true);
    expect(atom.deref()).toBe("World");

    // Should fail with wrong value
    const success2 = atom.compareAndSet("hello", "Failed");
    expect(success2).toBe(false);
    expect(atom.deref()).toBe("World");
  });
});

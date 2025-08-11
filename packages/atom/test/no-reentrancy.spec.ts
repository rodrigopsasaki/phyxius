import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Atom Reentrancy Prevention", () => {
  it("should throw error on reentrant swap in watch callback", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const changes: number[] = [];

    // Register a watch that attempts reentrant update
    atom.watch((change) => {
      changes.push(change.to);
      if (change.to === 1) {
        // This should throw
        expect(() => {
          atom.swap((n) => n + 10);
        }).toThrow(/reentrant|reentrancy/i);
      }
    });

    // Initial change should succeed
    atom.swap((n) => n + 1);

    // Verify the outer change still committed exactly once
    expect(atom.version()).toBe(1);
    expect(atom.deref()).toBe(1);
    expect(changes).toEqual([1]); // Only one notification
  });

  it("should throw error on reentrant reset in watch callback", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("initial", clock);
    let errorThrown = false;

    atom.watch((change) => {
      if (change.to === "first") {
        try {
          atom.reset("reentrant");
        } catch (error) {
          errorThrown = true;
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/reentrant|reentrancy/i);
        }
      }
    });

    atom.reset("first");

    expect(errorThrown).toBe(true);
    expect(atom.deref()).toBe("first"); // Original change succeeded
    expect(atom.version()).toBe(1); // Only one version increment
  });

  it("should throw error on reentrant compareAndSet in watch callback", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(5, clock);
    let errorThrown = false;

    atom.watch((change) => {
      if (change.to === 10) {
        try {
          atom.compareAndSet(10, 20);
        } catch (error) {
          errorThrown = true;
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/reentrant|reentrancy/i);
        }
      }
    });

    atom.reset(10);

    expect(errorThrown).toBe(true);
    expect(atom.deref()).toBe(10); // Original change succeeded
    expect(atom.version()).toBe(1); // Only one version increment
  });

  it("should allow updates after watch callback completes", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const changes: number[] = [];

    atom.watch((change) => {
      changes.push(change.to);
      // No reentrant update here
    });

    // First update
    atom.swap((n) => n + 1);
    expect(atom.deref()).toBe(1);

    // Second update after callback completed - should work fine
    atom.swap((n) => n + 1);
    expect(atom.deref()).toBe(2);
    expect(atom.version()).toBe(2);
    expect(changes).toEqual([1, 2]);
  });
});

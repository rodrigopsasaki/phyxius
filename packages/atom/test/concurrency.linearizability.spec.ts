import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Atom Concurrency Linearizability", () => {
  it("should handle interleaved async swap operations correctly", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock, { baseVersion: 0 });
    const capturedVersions: number[] = [];

    // Track all version changes
    atom.watch((change) => {
      capturedVersions.push(change.versionTo);
    });

    // Schedule 100 swap operations via microtasks
    const promises = Array.from({ length: 100 }, () =>
      Promise.resolve().then(() => {
        return atom.swap((n) => n + 1);
      }),
    );

    // Wait for all operations to complete
    await Promise.all(promises);

    // Verify final state
    expect(atom.deref()).toBe(100);
    expect(atom.version()).toBe(100); // baseVersion (0) + 100

    // Verify all versions are captured and strictly increasing
    expect(capturedVersions).toHaveLength(100);
    for (let i = 0; i < capturedVersions.length; i++) {
      expect(capturedVersions[i]).toBe(i + 1);
    }

    // Verify versions are strictly increasing
    for (let i = 1; i < capturedVersions.length; i++) {
      expect(capturedVersions[i]).toBe(capturedVersions[i - 1]! + 1);
    }
  });

  it("should handle mixed swap and reset operations", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const operations: Array<{ type: string; result: number; version: number }> = [];

    atom.watch((change) => {
      operations.push({
        type: "change",
        result: change.to,
        version: change.versionTo,
      });
    });

    // Mix of different operations
    const promises = [
      // Swaps
      Promise.resolve().then(() => atom.swap((n) => n + 10)),
      Promise.resolve().then(() => atom.swap((n) => n + 1)),
      Promise.resolve().then(() => atom.swap((n) => n * 2)),
      // Resets
      Promise.resolve().then(() => atom.reset(100)),
      Promise.resolve().then(() => atom.reset(200)),
      // More swaps
      Promise.resolve().then(() => atom.swap((n) => n + 5)),
    ];

    await Promise.all(promises);

    // Should have exactly 6 operations
    expect(operations).toHaveLength(6);
    expect(atom.version()).toBe(6);

    // All versions should be unique and increasing
    const versions = operations.map((op) => op.version);
    const uniqueVersions = [...new Set(versions)].sort((a, b) => a - b);
    expect(uniqueVersions).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("should maintain atomicity with compareAndSet in concurrent context", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const successes: boolean[] = [];
    const failures: boolean[] = [];

    // Multiple concurrent CAS operations trying to update from 0 to different values
    const promises = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => {
        const success = atom.compareAndSet(0, i + 1);
        if (success) {
          successes.push(true);
        } else {
          failures.push(false);
        }
        return success;
      }),
    );

    await Promise.all(promises);

    // Only one CAS should succeed
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(9);
    expect(atom.version()).toBe(1);

    // Final value should be one of the attempted values (1-10)
    const finalValue = atom.deref();
    expect(finalValue).toBeGreaterThanOrEqual(1);
    expect(finalValue).toBeLessThanOrEqual(10);
  });

  it("should handle rapid succession of updates with watchers", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom<string[]>([], clock);
    const allChanges: Array<{ from: string[]; to: string[]; version: number }> = [];

    atom.watch((change) => {
      allChanges.push({
        from: change.from,
        to: change.to,
        version: change.versionTo,
      });
    });

    // Rapid array updates
    const promises = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => {
        return atom.swap((arr) => [...arr, `item-${i}`]);
      }),
    );

    await Promise.all(promises);

    expect(atom.deref()).toHaveLength(50);
    expect(atom.version()).toBe(50);
    expect(allChanges).toHaveLength(50);

    // Verify each change added exactly one item
    for (let i = 0; i < allChanges.length; i++) {
      const change = allChanges[i]!;
      expect(change.to.length).toBe(change.from.length + 1);
      expect(change.version).toBe(i + 1);
    }
  });

  it("should preserve order in high-concurrency scenario", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const results: number[] = [];

    // Create many promises that will execute in microtask order
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 200; i++) {
      promises.push(
        Promise.resolve().then(() => {
          const result = atom.swap((n) => {
            const newValue = n + 1;
            results.push(newValue);
            return newValue;
          });
          return result;
        }),
      );
    }

    await Promise.all(promises);

    expect(atom.deref()).toBe(200);
    expect(atom.version()).toBe(200);
    expect(results).toHaveLength(200);

    // Results should be in order 1, 2, 3, ..., 200
    for (let i = 0; i < results.length; i++) {
      expect(results[i]).toBe(i + 1);
    }
  });
});

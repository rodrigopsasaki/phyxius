import { describe, it, expect } from "vitest";
import { createAtom } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";

describe("Atom Error Propagation", () => {
  it("should leave state unchanged when swap updater throws", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(5, clock);
    const changes: unknown[] = [];

    atom.watch(() => changes.push("notified"));

    const initialVersion = atom.version();
    const initialValue = atom.deref();

    // Updater that throws
    expect(() => {
      atom.swap(() => {
        throw new Error("Updater error");
      });
    }).toThrow("Updater error");

    // State should be unchanged
    expect(atom.deref()).toBe(initialValue);
    expect(atom.version()).toBe(initialVersion);
    expect(changes).toHaveLength(0); // No notification
  });

  it("should preserve history when updater throws", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("initial", clock, { historySize: 3 });

    // Make a successful change first
    atom.reset("first");
    const historyBeforeError = atom.history();

    // Attempt update that throws
    expect(() => {
      atom.swap(() => {
        throw new Error("Test error");
      });
    }).toThrow("Test error");

    // History should be unchanged
    expect(atom.history()).toEqual(historyBeforeError);
  });

  it("should not affect other watchers when one watcher throws", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const notifications: string[] = [];

    // First watcher - throws an error
    atom.watch(() => {
      throw new Error("Watcher error");
    });

    // Second watcher - should still receive notifications
    atom.watch((change) => {
      notifications.push(`notified: ${change.to}`);
    });

    // Make a change - should not throw (error should be caught)
    expect(() => {
      atom.reset(1);
    }).not.toThrow();

    // Second watcher should have received the notification
    expect(notifications).toEqual(["notified: 1"]);
    expect(atom.deref()).toBe(1);
    expect(atom.version()).toBe(1);
  });

  it("should handle errors in multiple watchers", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("start", clock);
    const successfulNotifications: string[] = [];

    // Multiple watchers that throw
    atom.watch(() => {
      throw new Error("First watcher error");
    });

    atom.watch(() => {
      throw new Error("Second watcher error");
    });

    // One successful watcher
    atom.watch((change) => {
      successfulNotifications.push(`${change.from}->${change.to}`);
    });

    // Another error watcher
    atom.watch(() => {
      throw new Error("Third watcher error");
    });

    // Change should succeed despite watcher errors
    expect(() => {
      atom.reset("end");
    }).not.toThrow();

    expect(successfulNotifications).toEqual(["start->end"]);
    expect(atom.deref()).toBe("end");
    expect(atom.version()).toBe(1);
  });

  it("should propagate error from compareAndSet condition check", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const throwingEquals = () => {
      throw new Error("Equals function error");
    };

    const atom = createAtom(10, clock, { equals: throwingEquals });

    // compareAndSet should propagate the error from equals function
    expect(() => {
      atom.compareAndSet(10, 20);
    }).toThrow("Equals function error");

    // State should remain unchanged
    expect(atom.deref()).toBe(10);
    expect(atom.version()).toBe(0);
  });

  it("should handle errors during snapshot creation gracefully", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom({ value: 1 }, clock);

    // This should not throw - snapshot should work normally
    expect(() => {
      const snapshot = atom.snapshot();
      expect(snapshot.value).toEqual({ value: 1 });
      expect(snapshot.version).toBe(0);
    }).not.toThrow();
  });

  it("should maintain version consistency despite errors", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom(0, clock);
    const versions: number[] = [];

    atom.watch((change) => {
      versions.push(change.versionTo);
      if (change.to === 2) {
        throw new Error("Watcher error on version 2");
      }
    });

    // Successful changes
    atom.reset(1); // Should succeed
    atom.reset(2); // Should succeed but watcher throws
    atom.reset(3); // Should succeed

    expect(versions).toEqual([1, 2, 3]);
    expect(atom.deref()).toBe(3);
    expect(atom.version()).toBe(3);
  });

  it("should handle async errors in watch callbacks appropriately", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const atom = createAtom("initial", clock);

    atom.watch(async () => {
      // This async error should not affect the atom operation
      throw new Error("Async watcher error");
    });

    // Set up global error handler to catch unhandled promise rejections
    const originalHandler = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", () => {
      // Handle unhandled promise rejections
    });

    try {
      // This should complete successfully
      atom.reset("changed");
      expect(atom.deref()).toBe("changed");
      expect(atom.version()).toBe(1);

      // Give async error time to potentially surface
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      // Restore original handlers
      process.removeAllListeners("unhandledRejection");
      originalHandler.forEach((handler) => {
        process.on("unhandledRejection", handler);
      });
    }
  });

  it("should throw clear error on custom equals function failure", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const faultyEquals = (a: any, b: any) => {
      if (a === "trigger-error" || b === "trigger-error") {
        throw new Error("Custom equals error");
      }
      return a === b;
    };

    const atom = createAtom("normal", clock, { equals: faultyEquals });

    // Normal operation should work
    atom.reset("other");
    expect(atom.deref()).toBe("other");

    // Error in equals should propagate (when comparing current "other" with "trigger-error")
    expect(() => {
      atom.reset("trigger-error");
    }).toThrow("Custom equals error");
  });
});

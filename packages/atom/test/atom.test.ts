import { describe, it, expect, beforeEach } from "vitest";
import { createAtom, type Change } from "../src/index.js";
import { createControlledClock } from "@phyxius/clock";
import type { Atom } from "../src/types.js";

describe("Atom", () => {
  let testAtom: Atom<number>;
  let clock: ReturnType<typeof createControlledClock>;

  beforeEach(() => {
    clock = createControlledClock({ initialTime: 1000 });
    testAtom = createAtom(42, clock, {
      historySize: 5,
    });
  });

  describe("deref()", () => {
    it("should return initial value", () => {
      const value = testAtom.deref();
      expect(value).toBe(42);
    });
  });

  describe("reset()", () => {
    it("should update value", () => {
      const result = testAtom.reset(100);
      expect(result).toBe(100);
      expect(testAtom.deref()).toBe(100);
    });

    it("should increment version", () => {
      const before = testAtom.snapshot();
      testAtom.reset(100);
      const after = testAtom.snapshot();

      expect(after.version).toBe(before.version + 1);
    });

    it("should not update on same value", () => {
      const before = testAtom.snapshot();
      testAtom.reset(42);
      const after = testAtom.snapshot();

      expect(after.version).toBe(before.version);
    });
  });

  describe("swap()", () => {
    it("should update using function", () => {
      const result = testAtom.swap((n) => n * 2);
      expect(result).toBe(84);
      expect(testAtom.deref()).toBe(84);
    });

    it("should return new value", () => {
      const result = testAtom.swap((n) => n + 10);
      expect(result).toBe(52);
      expect(testAtom.deref()).toBe(52);
    });
  });

  describe("compareAndSet()", () => {
    it("should set when expected matches", () => {
      const success = testAtom.compareAndSet(42, 100);
      expect(success).toBe(true);
      expect(testAtom.deref()).toBe(100);
    });

    it("should not set when expected does not match", () => {
      const success = testAtom.compareAndSet(99, 100);
      expect(success).toBe(false);
      expect(testAtom.deref()).toBe(42);
    });
  });

  describe("snapshot()", () => {
    it("should return current snapshot", () => {
      const snapshot = testAtom.snapshot();
      expect(snapshot).toMatchObject({
        value: 42,
        version: 0,
      });
      expect(snapshot.at.wallMs).toBe(1000);
      expect(snapshot.at.monoMs).toBe(1000);
    });

    it("should reflect updates", () => {
      testAtom.reset(100);
      const snapshot = testAtom.snapshot();
      expect(snapshot).toMatchObject({
        value: 100,
        version: 1,
      });
    });
  });

  describe("history()", () => {
    it("should return history of snapshots", () => {
      testAtom.reset(100);
      testAtom.reset(200);

      const history = testAtom.history();
      expect(history).toHaveLength(3);
      expect(history.map((h) => h.value)).toEqual([42, 100, 200]);
      expect(history.map((h) => h.version)).toEqual([0, 1, 2]);
    });

    it("should limit history size", () => {
      for (let i = 0; i < 10; i++) {
        testAtom.reset(i);
      }

      const history = testAtom.history();
      expect(history).toHaveLength(5);
      expect(history[0]!.value).toBe(5);
      expect(history[4]!.value).toBe(9);
    });

    it("should clear history but keep current", () => {
      testAtom.reset(100);
      testAtom.reset(200);
      testAtom.clearHistory();

      const history = testAtom.history();
      expect(history).toHaveLength(1);
      expect(history[0]!.value).toBe(200);
      expect(history[0]!.version).toBe(2);
    });
  });

  describe("version()", () => {
    it("should start at 0", () => {
      expect(testAtom.version()).toBe(0);
    });

    it("should increment on updates", () => {
      testAtom.reset(100);
      expect(testAtom.version()).toBe(1);

      testAtom.swap((n) => n + 1);
      expect(testAtom.version()).toBe(2);
    });
  });

  describe("watch()", () => {
    it("should call callback on updates", () => {
      const changes: Change<number>[] = [];
      testAtom.watch((change) => changes.push(change));

      testAtom.reset(100);
      testAtom.reset(200);

      expect(changes).toHaveLength(2);
      expect(changes[0]).toMatchObject({
        from: 42,
        to: 100,
        versionFrom: 0,
        versionTo: 1,
      });
      expect(changes[1]).toMatchObject({
        from: 100,
        to: 200,
        versionFrom: 1,
        versionTo: 2,
      });
    });

    it("should return unsubscribe function", () => {
      const changes: Change<number>[] = [];
      const unsubscribe = testAtom.watch((change) => changes.push(change));

      testAtom.reset(100);
      unsubscribe();
      testAtom.reset(200);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        from: 42,
        to: 100,
      });
    });

    it("should prevent reentrant updates", () => {
      testAtom.watch(() => {
        expect(() => testAtom.reset(999)).toThrow("Cannot update atom during notification");
      });

      testAtom.reset(100);
    });
  });

  describe("with custom equality", () => {
    it("should use custom equality function", () => {
      const objAtom = createAtom({ value: 1 }, clock, {
        equals: (a, b) => a.value === b.value,
      });

      const changes: Change<{ value: number }>[] = [];
      objAtom.watch((change) => changes.push(change));

      // Same value according to custom equality
      objAtom.reset({ value: 1 });
      expect(changes).toHaveLength(0);
      expect(objAtom.version()).toBe(0);

      // Different value
      objAtom.reset({ value: 2 });
      expect(changes).toHaveLength(1);
      expect(objAtom.version()).toBe(1);
    });
  });

  describe("complex scenarios", () => {
    it("should handle object values", () => {
      const objAtom = createAtom({ count: 0, name: "test" }, clock);

      objAtom.swap((obj) => ({ ...obj, count: obj.count + 1 }));

      expect(objAtom.deref()).toEqual({ count: 1, name: "test" });
    });

    it("should handle array values", () => {
      const arrayAtom = createAtom([1, 2, 3], clock);

      arrayAtom.swap((arr) => [...arr, 4]);

      expect(arrayAtom.deref()).toEqual([1, 2, 3, 4]);
    });

    it("should work with multiple watchers", () => {
      const results: Change<number>[][] = [[], []];

      testAtom.watch((change) => results[0]!.push(change));
      testAtom.watch((change) => results[1]!.push(change));

      testAtom.reset(100);
      testAtom.reset(200);

      expect(results[0]).toHaveLength(2);
      expect(results[1]).toHaveLength(2);
      expect(results[0]![0]!.to).toBe(100);
      expect(results[1]![0]!.to).toBe(100);
    });

    it("should include cause in changes", () => {
      const changes: Change<number>[] = [];
      testAtom.watch((change) => changes.push(change));

      testAtom.reset(100, { cause: "test-cause" });

      expect(changes[0]!.cause).toBe("test-cause");
    });
  });
});

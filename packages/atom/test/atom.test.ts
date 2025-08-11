import { describe, it, expect, beforeEach } from "vitest";
import { atom } from "../src/index.js";

describe("Atom", () => {
  let events: unknown[] = [];
  let testAtom: ReturnType<typeof atom>;

  beforeEach(() => {
    events = [];
    testAtom = atom(42, {
      emit: (event) => events.push(event),
      maxHistory: 5,
    });
  });

  describe("get()", () => {
    it("should return initial value", () => {
      const value = testAtom.get();
      expect(value).toBe(42);
    });

    it("should emit get events", () => {
      testAtom.get();

      const getEvents = events.filter((e: any) => e.type === "atom:get");
      expect(getEvents).toHaveLength(1);
      expect(getEvents[0]).toMatchObject({
        type: "atom:get",
        version: 0,
        value: 42,
      });
    });
  });

  describe("set()", () => {
    it("should update value", () => {
      testAtom.set(100);
      expect(testAtom.get()).toBe(100);
    });

    it("should increment version", () => {
      const before = testAtom.getSnapshot();
      testAtom.set(100);
      const after = testAtom.getSnapshot();

      expect(after.version).toBe(before.version + 1);
    });

    it("should emit set events", () => {
      testAtom.set(100);

      const setEvents = events.filter((e: any) => e.type === "atom:set");
      expect(setEvents).toHaveLength(1);
      expect(setEvents[0]).toMatchObject({
        type: "atom:set",
        version: 1,
        oldVersion: 0,
        value: 100,
        oldValue: 42,
      });
    });

    it("should not update on same value", () => {
      const before = testAtom.getSnapshot();
      testAtom.set(42);
      const after = testAtom.getSnapshot();

      expect(after.version).toBe(before.version);

      const noopEvents = events.filter((e: any) => e.type === "atom:set:noop");
      expect(noopEvents).toHaveLength(1);
    });
  });

  describe("update()", () => {
    it("should update using function", () => {
      const result = testAtom.update((n) => n * 2);
      expect(result).toBe(84);
      expect(testAtom.get()).toBe(84);
    });

    it("should return new value", () => {
      const result = testAtom.update((n) => n + 10);
      expect(result).toBe(52);
    });
  });

  describe("swap()", () => {
    it("should work like update", () => {
      const result = testAtom.swap((n) => n / 2);
      expect(result).toBe(21);
      expect(testAtom.get()).toBe(21);
    });
  });

  describe("compareAndSet()", () => {
    it("should set when expected matches", () => {
      const success = testAtom.compareAndSet(42, 100);
      expect(success).toBe(true);
      expect(testAtom.get()).toBe(100);
    });

    it("should not set when expected does not match", () => {
      const success = testAtom.compareAndSet(99, 100);
      expect(success).toBe(false);
      expect(testAtom.get()).toBe(42);
    });

    it("should emit success events", () => {
      testAtom.compareAndSet(42, 100);

      const successEvents = events.filter((e: any) => e.type === "atom:cas:success");
      expect(successEvents).toHaveLength(1);
      expect(successEvents[0]).toMatchObject({
        type: "atom:cas:success",
        version: 1,
        expected: 42,
        value: 100,
      });
    });

    it("should emit failure events", () => {
      testAtom.compareAndSet(99, 100);

      const failureEvents = events.filter((e: any) => e.type === "atom:cas:failure");
      expect(failureEvents).toHaveLength(1);
      expect(failureEvents[0]).toMatchObject({
        type: "atom:cas:failure",
        version: 0,
        expected: 99,
        actual: 42,
        value: 100,
      });
    });
  });

  describe("getSnapshot()", () => {
    it("should return current snapshot", () => {
      const snapshot = testAtom.getSnapshot();
      expect(snapshot).toMatchObject({
        value: 42,
        version: 0,
      });
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    it("should reflect updates", () => {
      testAtom.set(100);
      const snapshot = testAtom.getSnapshot();
      expect(snapshot).toMatchObject({
        value: 100,
        version: 1,
      });
    });
  });

  describe("getHistory()", () => {
    it("should return history of snapshots", () => {
      testAtom.set(100);
      testAtom.set(200);

      const history = testAtom.getHistory();
      expect(history).toHaveLength(3);
      expect(history.map((h) => h.value)).toEqual([42, 100, 200]);
      expect(history.map((h) => h.version)).toEqual([0, 1, 2]);
    });

    it("should limit history size", () => {
      for (let i = 0; i < 10; i++) {
        testAtom.set(i);
      }

      const history = testAtom.getHistory();
      expect(history).toHaveLength(5);
      expect(history[0]!.value).toBe(5);
      expect(history[4]!.value).toBe(9);
    });
  });

  describe("reset()", () => {
    it("should reset to initial value", () => {
      testAtom.set(100);
      testAtom.set(200);
      testAtom.reset();

      expect(testAtom.get()).toBe(42);
    });

    it("should increment version", () => {
      testAtom.set(100);
      const beforeReset = testAtom.getSnapshot();
      testAtom.reset();
      const afterReset = testAtom.getSnapshot();

      expect(afterReset.version).toBe(beforeReset.version + 1);
    });

    it("should emit reset events", () => {
      testAtom.set(100);
      testAtom.reset();

      const resetEvents = events.filter((e: any) => e.type === "atom:reset");
      expect(resetEvents).toHaveLength(1);
      expect(resetEvents[0]).toMatchObject({
        type: "atom:reset",
        version: 2,
        oldVersion: 1,
        value: 42,
        oldValue: 100,
      });
    });
  });

  describe("subscribe()", () => {
    it("should call callback immediately with current state", () => {
      const snapshots: any[] = [];
      testAtom.subscribe((snapshot) => snapshots.push(snapshot));

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        value: 42,
        version: 0,
      });
    });

    it("should call callback on updates", () => {
      const snapshots: any[] = [];
      testAtom.subscribe((snapshot) => snapshots.push(snapshot));

      testAtom.set(100);
      testAtom.set(200);

      expect(snapshots).toHaveLength(3);
      expect(snapshots.map((s) => s.value)).toEqual([42, 100, 200]);
    });

    it("should return unsubscribe function", () => {
      const snapshots: any[] = [];
      const unsubscribe = testAtom.subscribe((snapshot) => snapshots.push(snapshot));

      testAtom.set(100);
      unsubscribe();
      testAtom.set(200);

      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((s) => s.value)).toEqual([42, 100]);
    });

    it("should emit subscription events", () => {
      const unsubscribe = testAtom.subscribe(() => {});

      const subscribeEvents = events.filter((e: any) => e.type === "atom:subscribe");
      expect(subscribeEvents).toHaveLength(1);
      expect(subscribeEvents[0]).toMatchObject({
        type: "atom:subscribe",
        subscriberCount: 1,
      });

      unsubscribe();

      const unsubscribeEvents = events.filter((e: any) => e.type === "atom:unsubscribe");
      expect(unsubscribeEvents).toHaveLength(1);
      expect(unsubscribeEvents[0]).toMatchObject({
        type: "atom:unsubscribe",
        subscriberCount: 0,
      });
    });

    it("should handle subscriber errors", () => {
      testAtom.subscribe(() => {
        throw new Error("Test error");
      });

      testAtom.set(100);

      const errorEvents = events.filter((e: any) => e.type === "atom:subscriber:error");
      expect(errorEvents).toHaveLength(2); // One from initial callback, one from set
      expect(errorEvents[0]).toMatchObject({
        type: "atom:subscriber:error",
        version: 0,
      });
      expect(errorEvents[1]).toMatchObject({
        type: "atom:subscriber:error",
        version: 1,
      });
    });
  });

  describe("without emit function", () => {
    it("should work without emitting events", () => {
      const simpleAtom = atom("test");

      expect(simpleAtom.get()).toBe("test");
      simpleAtom.set("updated");
      expect(simpleAtom.get()).toBe("updated");
    });
  });

  describe("complex scenarios", () => {
    it("should handle object values", () => {
      const objAtom = atom({ count: 0, name: "test" });

      objAtom.update((obj) => ({ ...obj, count: obj.count + 1 }));

      expect(objAtom.get()).toEqual({ count: 1, name: "test" });
    });

    it("should handle array values", () => {
      const arrayAtom = atom([1, 2, 3]);

      arrayAtom.update((arr) => [...arr, 4]);

      expect(arrayAtom.get()).toEqual([1, 2, 3, 4]);
    });

    it("should work with multiple subscribers", () => {
      const results: number[][] = [[], []];

      testAtom.subscribe((snapshot) => results[0]!.push(snapshot.version));
      testAtom.subscribe((snapshot) => results[1]!.push(snapshot.version));

      testAtom.set(100);
      testAtom.set(200);

      expect(results[0]).toEqual([0, 1, 2]);
      expect(results[1]).toEqual([0, 1, 2]);
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { createControlledClock } from "@phyxius/clock";
import type { Clock } from "@phyxius/clock";
import { Journal, JournalReentrancyError, JournalOverflowError } from "../src/index.js";
import type { JournalEvent, IdGenerator } from "../src/index.js";

describe("Journal", () => {
  let clock: Clock;
  let idCounter: number;
  let events: JournalEvent[];
  let idGenerator: IdGenerator;

  beforeEach(() => {
    clock = createControlledClock({ initialTime: 0 });
    idCounter = 0;
    events = [];
    idGenerator = () => `id-${++idCounter}`;
  });

  describe("basic operations", () => {
    it("should create empty journal", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        emit: (event) => events.push(event),
      });

      expect(journal.size()).toBe(0);
      expect(journal.isEmpty()).toBe(true);
      expect(journal.getFirst()).toBeUndefined();
      expect(journal.getLast()).toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("journal:create");
    });

    it("should append entries with Clock timestamps", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        emit: (event) => events.push(event),
      });

      (clock as any).advanceBy(100);
      const entry1 = journal.append({ message: "first" });

      (clock as any).advanceBy(50);
      const entry2 = journal.append({ message: "second" });

      expect(entry1.sequence).toBe(0);
      expect(entry1.timestamp.wallMs).toBe(100);
      expect(entry1.id).toBe("id-2");
      expect(entry1.data).toEqual({ message: "first" });

      expect(entry2.sequence).toBe(1);
      expect(entry2.timestamp.wallMs).toBe(150);
      expect(entry2.id).toBe("id-3");
      expect(entry2.data).toEqual({ message: "second" });

      expect(journal.size()).toBe(2);
      expect(journal.isEmpty()).toBe(false);
    });

    it("should provide O(1) getEntry access", () => {
      const journal = new Journal({
        clock,
        idGenerator,
      });

      journal.append("a");
      journal.append("b");
      journal.append("c");

      expect(journal.getEntry(0)?.data).toBe("a");
      expect(journal.getEntry(1)?.data).toBe("b");
      expect(journal.getEntry(2)?.data).toBe("c");
      expect(journal.getEntry(3)).toBeUndefined();
      expect(journal.getEntry(-1)).toBeUndefined();
    });

    it("should get first and last entries", () => {
      const journal = new Journal({ clock, idGenerator });

      expect(journal.getFirst()).toBeUndefined();
      expect(journal.getLast()).toBeUndefined();

      journal.append("first");
      expect(journal.getFirst()?.data).toBe("first");
      expect(journal.getLast()?.data).toBe("first");

      journal.append("second");
      journal.append("third");
      expect(journal.getFirst()?.data).toBe("first");
      expect(journal.getLast()?.data).toBe("third");
    });

    it("should clear journal", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        emit: (event) => events.push(event),
      });

      journal.append("a");
      journal.append("b");
      expect(journal.size()).toBe(2);

      (clock as any).advanceBy(200);
      journal.clear();

      expect(journal.size()).toBe(0);
      expect(journal.isEmpty()).toBe(true);
      expect(journal.getFirst()).toBeUndefined();
      expect(journal.getLast()).toBeUndefined();

      const clearEvent = events.find((e) => e.type === "journal:clear");
      expect(clearEvent).toBeDefined();
      expect(clearEvent?.previousSize).toBe(2);
      expect(clearEvent?.at.wallMs).toBe(200);
    });
  });

  describe("subscribers", () => {
    it("should notify subscribers on append", () => {
      const journal = new Journal({ clock, idGenerator });
      const received: any[] = [];

      const unsubscribe = journal.subscribe((entry) => {
        received.push(entry.data);
      });

      journal.append("first");
      journal.append("second");

      expect(received).toEqual(["first", "second"]);

      unsubscribe();
      journal.append("third");
      expect(received).toEqual(["first", "second"]);
    });

    it("should handle subscriber errors gracefully", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        emit: (event) => events.push(event),
      });

      journal.subscribe(() => {
        throw new Error("Subscriber error");
      });

      (clock as any).advanceBy(300);
      journal.append("test");

      const errorEvent = events.find((e) => e.type === "journal:subscriber:error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error).toBeInstanceOf(Error);
      expect(errorEvent?.at.wallMs).toBe(300);
    });

    it("should prevent re-entrancy during subscriber notification", () => {
      const journal = new Journal({ clock, idGenerator });

      journal.subscribe(() => {
        expect(() => {
          journal.append("reentrant");
        }).toThrow(JournalReentrancyError);
      });

      journal.append("trigger");
    });
  });

  describe("backpressure policies", () => {
    it("should allow unlimited entries with 'none' policy", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        overflow: "none",
      });

      for (let i = 0; i < 1000; i++) {
        journal.append(i);
      }

      expect(journal.size()).toBe(1000);
    });

    it("should throw error with 'bounded:error' policy", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        maxEntries: 2,
        overflow: "bounded:error",
        emit: (event) => events.push(event),
      });

      journal.append("first");
      journal.append("second");

      expect(() => {
        journal.append("third");
      }).toThrow(JournalOverflowError);

      const overflowEvent = events.find((e) => e.type === "journal:overflow");
      expect(overflowEvent).toBeDefined();
      expect(overflowEvent?.policy).toBe("bounded:error");
      expect(overflowEvent?.maxEntries).toBe(2);
    });

    it("should drop oldest with 'bounded:drop_oldest' policy", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        maxEntries: 3,
        overflow: "bounded:drop_oldest",
        emit: (event) => events.push(event),
      });

      journal.append("first");
      journal.append("second");
      journal.append("third");
      expect(journal.size()).toBe(3);

      journal.append("fourth");
      expect(journal.size()).toBe(3);

      // First entry should be dropped
      expect(journal.getEntry(0)).toBeUndefined();
      expect(journal.getEntry(1)?.data).toBe("second");
      expect(journal.getEntry(2)?.data).toBe("third");
      expect(journal.getEntry(3)?.data).toBe("fourth");

      const overflowEvent = events.find((e) => e.type === "journal:overflow");
      expect(overflowEvent).toBeDefined();
      expect(overflowEvent?.policy).toBe("bounded:drop_oldest");
      expect(overflowEvent?.droppedCount).toBe(1);
    });
  });

  describe("snapshots", () => {
    it("should create immutable snapshots", () => {
      const journal = new Journal({ clock, idGenerator });

      journal.append("first");
      (clock as any).advanceBy(100);
      journal.append("second");
      (clock as any).advanceBy(100);

      const snapshot = journal.getSnapshot();

      expect(snapshot.totalCount).toBe(2);
      expect(snapshot.firstSequence).toBe(0);
      expect(snapshot.lastSequence).toBe(1);
      expect(snapshot.timestamp.wallMs).toBe(200);
      expect(snapshot.entries).toHaveLength(2);

      // Test immutability
      expect(Object.isFrozen(snapshot.entries)).toBe(true);
      expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
      expect(Object.isFrozen(snapshot.entries[0].data)).toBe(true);

      // Snapshot should not change when journal changes
      journal.append("third");
      expect(snapshot.entries).toHaveLength(2);
    });
  });

  describe("serialization", () => {
    it("should serialize and deserialize without custom serializer", () => {
      const journal = new Journal({ clock, idGenerator });

      (clock as any).advanceBy(100);
      journal.append({ message: "first" });
      (clock as any).advanceBy(50);
      journal.append({ message: "second" });

      const serialized = journal.toJSON();

      expect(serialized.entries).toHaveLength(2);
      expect(serialized.entries[0].data).toEqual({ message: "first" });
      expect(serialized.entries[0].timestamp.wallMs).toBe(100);
      expect(serialized.nextSequence).toBe(2);

      // Restore from JSON
      const restored = Journal.fromJSON(serialized, { clock, idGenerator });

      expect(restored.size()).toBe(2);
      expect(restored.getEntry(0)?.data).toEqual({ message: "first" });
      expect(restored.getEntry(1)?.data).toEqual({ message: "second" });
    });

    it("should use custom serializer", () => {
      const serializer = {
        serialize: (data: string) => data.toUpperCase(),
        deserialize: (data: unknown) => (data as string).toLowerCase(),
      };

      const journal = new Journal({
        clock,
        idGenerator,
        serializer,
      });

      journal.append("hello");
      const serialized = journal.toJSON();

      expect(serialized.entries[0].data).toBe("HELLO");

      const restored = Journal.fromJSON(serialized, {
        clock,
        idGenerator,
        serializer,
      });

      expect(restored.getEntry(0)?.data).toBe("hello");
    });
  });

  describe("event emission", () => {
    it("should emit all required events", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        maxEntries: 2,
        overflow: "bounded:drop_oldest",
        emit: (event) => events.push(event),
      });

      // Create event
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("journal:create");

      // Append events
      journal.append("first");
      journal.append("second");
      const appendEvents = events.filter((e) => e.type === "journal:append");
      expect(appendEvents).toHaveLength(2);

      // Overflow event
      journal.append("third");
      const overflowEvents = events.filter((e) => e.type === "journal:overflow");
      expect(overflowEvents).toHaveLength(1);

      // Clear event
      journal.clear();
      const clearEvents = events.filter((e) => e.type === "journal:clear");
      expect(clearEvents).toHaveLength(1);

      // Subscriber error event
      journal.subscribe(() => {
        throw new Error("Test error");
      });
      journal.append("error trigger");
      const errorEvents = events.filter((e) => e.type === "journal:subscriber:error");
      expect(errorEvents).toHaveLength(1);
    });
  });

  describe("dense array storage", () => {
    it("should maintain O(1) access with dropped entries", () => {
      const journal = new Journal({
        clock,
        idGenerator,
        maxEntries: 3,
        overflow: "bounded:drop_oldest",
      });

      // Fill journal
      journal.append("a"); // seq 0
      journal.append("b"); // seq 1
      journal.append("c"); // seq 2

      // Trigger overflow - should drop seq 0
      journal.append("d"); // seq 3

      // Verify O(1) access still works
      expect(journal.getEntry(0)).toBeUndefined(); // dropped
      expect(journal.getEntry(1)?.data).toBe("b");
      expect(journal.getEntry(2)?.data).toBe("c");
      expect(journal.getEntry(3)?.data).toBe("d");

      // Continue dropping
      journal.append("e"); // seq 4, drops seq 1
      expect(journal.getEntry(1)).toBeUndefined(); // dropped
      expect(journal.getEntry(2)?.data).toBe("c");
      expect(journal.getEntry(3)?.data).toBe("d");
      expect(journal.getEntry(4)?.data).toBe("e");
    });
  });
});

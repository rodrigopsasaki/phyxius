import { describe, it, expect, beforeEach } from "vitest";
import { journal } from "../src/index.js";

describe("Journal", () => {
  let events: unknown[] = [];
  let testJournal: ReturnType<typeof journal>;

  beforeEach(() => {
    events = [];
    testJournal = journal({
      emit: (event) => events.push(event),
    });
  });

  describe("append()", () => {
    it("should add entries with increasing sequence numbers", () => {
      const entry1 = testJournal.append("first");
      const entry2 = testJournal.append("second");

      expect(entry1.sequence).toBe(0);
      expect(entry2.sequence).toBe(1);
      expect(entry1.payload).toBe("first");
      expect(entry2.payload).toBe("second");
    });

    it("should generate unique IDs", () => {
      const entry1 = testJournal.append("test1");
      const entry2 = testJournal.append("test2");

      expect(entry1.id).toBeDefined();
      expect(entry2.id).toBeDefined();
      expect(entry1.id).not.toBe(entry2.id);
    });

    it("should set timestamps", () => {
      const before = Date.now();
      const entry = testJournal.append("test");
      const after = Date.now();

      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(after);
    });

    it("should emit append events", () => {
      const entry = testJournal.append("test");

      const appendEvents = events.filter((e: any) => e.type === "journal:append");
      expect(appendEvents).toHaveLength(1);
      expect(appendEvents[0]).toMatchObject({
        type: "journal:append",
        entryId: entry.id,
        sequence: entry.sequence,
      });
    });

    it("should return the created entry", () => {
      const entry = testJournal.append({ data: "test" });

      expect(entry.payload).toEqual({ data: "test" });
      expect(entry.sequence).toBe(0);
      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeDefined();
    });
  });

  describe("read()", () => {
    beforeEach(() => {
      testJournal.append("entry0");
      testJournal.append("entry1");
      testJournal.append("entry2");
      testJournal.append("entry3");
      testJournal.append("entry4");
    });

    it("should read from beginning by default", () => {
      const entries = testJournal.read();

      expect(entries).toHaveLength(5);
      expect(entries.map((e) => e.payload)).toEqual(["entry0", "entry1", "entry2", "entry3", "entry4"]);
    });

    it("should read from specific sequence", () => {
      const entries = testJournal.read(2);

      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.payload)).toEqual(["entry2", "entry3", "entry4"]);
    });

    it("should respect limit parameter", () => {
      const entries = testJournal.read(1, 2);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.payload)).toEqual(["entry1", "entry2"]);
    });

    it("should handle out of range sequences", () => {
      const entries = testJournal.read(10);
      expect(entries).toHaveLength(0);
    });

    it("should emit read events", () => {
      testJournal.read(1, 2);

      const readEvents = events.filter((e: any) => e.type === "journal:read");
      expect(readEvents).toHaveLength(1);
      expect(readEvents[0]).toMatchObject({
        type: "journal:read",
        fromSequence: 1,
        limit: 2,
      });
    });
  });

  describe("readAll()", () => {
    it("should return all entries", () => {
      testJournal.append("first");
      testJournal.append("second");
      testJournal.append("third");

      const entries = testJournal.readAll();

      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.payload)).toEqual(["first", "second", "third"]);
    });

    it("should return empty array for empty journal", () => {
      const entries = testJournal.readAll();
      expect(entries).toHaveLength(0);
    });

    it("should emit read all events", () => {
      testJournal.append("test");
      testJournal.readAll();

      const readAllEvents = events.filter((e: any) => e.type === "journal:read:all");
      expect(readAllEvents).toHaveLength(1);
      expect(readAllEvents[0]).toMatchObject({
        type: "journal:read:all",
        entryCount: 1,
      });
    });
  });

  describe("getEntry()", () => {
    beforeEach(() => {
      testJournal.append("entry0");
      testJournal.append("entry1");
      testJournal.append("entry2");
    });

    it("should return entry by sequence number", () => {
      const entry = testJournal.getEntry(1);

      expect(entry).toBeDefined();
      expect(entry!.payload).toBe("entry1");
      expect(entry!.sequence).toBe(1);
    });

    it("should return undefined for non-existent sequence", () => {
      const entry = testJournal.getEntry(10);
      expect(entry).toBeUndefined();
    });

    it("should emit get events", () => {
      testJournal.getEntry(1);
      testJournal.getEntry(10);

      const getEvents = events.filter((e: any) => e.type === "journal:get");
      expect(getEvents).toHaveLength(2);
      expect(getEvents[0]).toMatchObject({
        type: "journal:get",
        sequence: 1,
        found: true,
      });
      expect(getEvents[1]).toMatchObject({
        type: "journal:get",
        sequence: 10,
        found: false,
      });
    });
  });

  describe("getSnapshot()", () => {
    it("should return current state snapshot", () => {
      testJournal.append("first");
      testJournal.append("second");

      const snapshot = testJournal.getSnapshot();

      expect(snapshot.entries).toHaveLength(2);
      expect(snapshot.totalCount).toBe(2);
      expect(snapshot.firstSequence).toBe(0);
      expect(snapshot.lastSequence).toBe(1);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    it("should handle empty journal", () => {
      const snapshot = testJournal.getSnapshot();

      expect(snapshot.entries).toHaveLength(0);
      expect(snapshot.totalCount).toBe(0);
      expect(snapshot.firstSequence).toBe(0);
      expect(snapshot.lastSequence).toBe(-1);
    });

    it("should emit snapshot events", () => {
      testJournal.append("test");
      testJournal.getSnapshot();

      const snapshotEvents = events.filter((e: any) => e.type === "journal:snapshot");
      expect(snapshotEvents).toHaveLength(1);
      expect(snapshotEvents[0]).toMatchObject({
        type: "journal:snapshot",
        totalCount: 1,
        firstSequence: 0,
        lastSequence: 0,
      });
    });
  });

  describe("size()", () => {
    it("should return number of entries", () => {
      expect(testJournal.size()).toBe(0);

      testJournal.append("first");
      expect(testJournal.size()).toBe(1);

      testJournal.append("second");
      expect(testJournal.size()).toBe(2);
    });

    it("should emit size events", () => {
      testJournal.size();

      const sizeEvents = events.filter((e: any) => e.type === "journal:size");
      expect(sizeEvents).toHaveLength(1);
      expect(sizeEvents[0]).toMatchObject({
        type: "journal:size",
        size: 0,
      });
    });
  });

  describe("clear()", () => {
    it("should remove all entries", () => {
      testJournal.append("first");
      testJournal.append("second");

      expect(testJournal.size()).toBe(2);

      testJournal.clear();

      expect(testJournal.size()).toBe(0);
      expect(testJournal.readAll()).toHaveLength(0);
    });

    it("should reset sequence counter", () => {
      testJournal.append("first");
      testJournal.append("second");
      testJournal.clear();

      const entry = testJournal.append("after clear");
      expect(entry.sequence).toBe(0);
    });

    it("should emit clear events", () => {
      testJournal.append("first");
      testJournal.append("second");
      testJournal.clear();

      const clearEvents = events.filter((e: any) => e.type === "journal:clear");
      expect(clearEvents).toHaveLength(1);
      expect(clearEvents[0]).toMatchObject({
        type: "journal:clear",
        clearedCount: 2,
      });
    });
  });

  describe("subscribe()", () => {
    it("should call callback on new entries", () => {
      const entries: any[] = [];
      testJournal.subscribe((entry) => entries.push(entry));

      const entry1 = testJournal.append("first");
      const entry2 = testJournal.append("second");

      expect(entries).toHaveLength(2);
      expect(entries[0]).toBe(entry1);
      expect(entries[1]).toBe(entry2);
    });

    it("should return unsubscribe function", () => {
      const entries: any[] = [];
      const unsubscribe = testJournal.subscribe((entry) => entries.push(entry));

      testJournal.append("first");
      unsubscribe();
      testJournal.append("second");

      expect(entries).toHaveLength(1);
      expect(entries[0]!.payload).toBe("first");
    });

    it("should emit subscription events", () => {
      const unsubscribe = testJournal.subscribe(() => {});

      const subscribeEvents = events.filter((e: any) => e.type === "journal:subscribe");
      expect(subscribeEvents).toHaveLength(1);
      expect(subscribeEvents[0]).toMatchObject({
        type: "journal:subscribe",
        subscriberCount: 1,
      });

      unsubscribe();

      const unsubscribeEvents = events.filter((e: any) => e.type === "journal:unsubscribe");
      expect(unsubscribeEvents).toHaveLength(1);
      expect(unsubscribeEvents[0]).toMatchObject({
        type: "journal:unsubscribe",
        subscriberCount: 0,
      });
    });

    it("should handle subscriber errors", () => {
      testJournal.subscribe(() => {
        throw new Error("Test error");
      });

      const entry = testJournal.append("test");

      const errorEvents = events.filter((e: any) => e.type === "journal:subscriber:error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: "journal:subscriber:error",
        entryId: entry.id,
        sequence: entry.sequence,
      });
    });

    it("should support multiple subscribers", () => {
      const results: any[][] = [[], []];

      testJournal.subscribe((entry) => results[0]!.push(entry));
      testJournal.subscribe((entry) => results[1]!.push(entry));

      testJournal.append("first");
      testJournal.append("second");

      expect(results[0]).toHaveLength(2);
      expect(results[1]).toHaveLength(2);
      expect(results[0]![0]!.payload).toBe("first");
      expect(results[1]![1]!.payload).toBe("second");
    });
  });

  describe("without emit function", () => {
    it("should work without emitting events", () => {
      const simpleJournal = journal<string>();

      const entry = simpleJournal.append("test");
      expect(entry.payload).toBe("test");
      expect(simpleJournal.size()).toBe(1);
    });
  });

  describe("complex scenarios", () => {
    it("should handle different payload types", () => {
      const objJournal = journal<{ type: string; data: number }>();

      const entry1 = objJournal.append({ type: "create", data: 42 });
      const entry2 = objJournal.append({ type: "update", data: 100 });

      expect(entry1.payload).toEqual({ type: "create", data: 42 });
      expect(entry2.payload).toEqual({ type: "update", data: 100 });
    });

    it("should maintain order with concurrent operations", () => {
      const payloads = Array.from({ length: 100 }, (_, i) => `entry${i}`);

      payloads.forEach((payload) => testJournal.append(payload));

      const entries = testJournal.readAll();
      expect(entries).toHaveLength(100);
      expect(entries.map((e) => e.sequence)).toEqual(Array.from({ length: 100 }, (_, i) => i));
      expect(entries.map((e) => e.payload)).toEqual(payloads);
    });

    it("should support event sourcing patterns", () => {
      interface Event {
        type: string;
        aggregateId: string;
        version: number;
        data: any;
      }

      const eventJournal = journal<Event>();

      eventJournal.append({
        type: "UserCreated",
        aggregateId: "user-123",
        version: 1,
        data: { name: "John", email: "john@example.com" },
      });

      eventJournal.append({
        type: "UserEmailChanged",
        aggregateId: "user-123",
        version: 2,
        data: { email: "john.doe@example.com" },
      });

      const events = eventJournal.read().filter((e) => e.payload.aggregateId === "user-123");
      expect(events).toHaveLength(2);
      expect(events[0]!.payload.type).toBe("UserCreated");
      expect(events[1]!.payload.type).toBe("UserEmailChanged");
    });
  });
});

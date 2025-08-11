import { randomUUID } from "node:crypto";
import type { Journal, JournalEntry, JournalSnapshot, EmitFn } from "./types.js";

export class JournalImpl<T = unknown> implements Journal<T> {
  private entries: JournalEntry<T>[] = [];
  private sequenceCounter = 0;
  private readonly emit: EmitFn | undefined;
  private readonly subscribers: Set<(entry: JournalEntry<T>) => void> = new Set();

  constructor(options?: { emit?: EmitFn }) {
    this.emit = options?.emit;

    this.emit?.({
      type: "journal:create",
      timestamp: Date.now(),
    });
  }

  append(payload: T): JournalEntry<T> {
    const entry: JournalEntry<T> = {
      id: randomUUID(),
      payload,
      timestamp: Date.now(),
      sequence: this.sequenceCounter++,
    };

    this.entries.push(entry);

    this.emit?.({
      type: "journal:append",
      entryId: entry.id,
      sequence: entry.sequence,
      timestamp: entry.timestamp,
    });

    this.notifySubscribers(entry);

    return entry;
  }

  read(fromSequence = 0, limit?: number): JournalEntry<T>[] {
    this.emit?.({
      type: "journal:read",
      fromSequence,
      limit,
      timestamp: Date.now(),
    });

    let result = this.entries.filter((entry) => entry.sequence >= fromSequence);

    if (limit !== undefined && limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  }

  readAll(): JournalEntry<T>[] {
    this.emit?.({
      type: "journal:read:all",
      entryCount: this.entries.length,
      timestamp: Date.now(),
    });

    return [...this.entries];
  }

  getEntry(sequence: number): JournalEntry<T> | undefined {
    const entry = this.entries.find((e) => e.sequence === sequence);

    this.emit?.({
      type: "journal:get",
      sequence,
      found: entry !== undefined,
      timestamp: Date.now(),
    });

    return entry;
  }

  getSnapshot(): JournalSnapshot<T> {
    const snapshot: JournalSnapshot<T> = {
      entries: [...this.entries],
      totalCount: this.entries.length,
      firstSequence: this.entries[0]?.sequence ?? 0,
      lastSequence: this.entries[this.entries.length - 1]?.sequence ?? -1,
      timestamp: Date.now(),
    };

    this.emit?.({
      type: "journal:snapshot",
      totalCount: snapshot.totalCount,
      firstSequence: snapshot.firstSequence,
      lastSequence: snapshot.lastSequence,
      timestamp: snapshot.timestamp,
    });

    return snapshot;
  }

  size(): number {
    this.emit?.({
      type: "journal:size",
      size: this.entries.length,
      timestamp: Date.now(),
    });

    return this.entries.length;
  }

  clear(): void {
    const oldSize = this.entries.length;
    this.entries = [];
    this.sequenceCounter = 0;

    this.emit?.({
      type: "journal:clear",
      clearedCount: oldSize,
      timestamp: Date.now(),
    });
  }

  subscribe(callback: (entry: JournalEntry<T>) => void): () => void {
    this.subscribers.add(callback);

    this.emit?.({
      type: "journal:subscribe",
      subscriberCount: this.subscribers.size,
      timestamp: Date.now(),
    });

    return () => {
      this.subscribers.delete(callback);
      this.emit?.({
        type: "journal:unsubscribe",
        subscriberCount: this.subscribers.size,
        timestamp: Date.now(),
      });
    };
  }

  private notifySubscribers(entry: JournalEntry<T>): void {
    for (const callback of this.subscribers) {
      try {
        callback(entry);
      } catch (error) {
        this.emit?.({
          type: "journal:subscriber:error",
          error,
          entryId: entry.id,
          sequence: entry.sequence,
          timestamp: Date.now(),
        });
      }
    }
  }
}

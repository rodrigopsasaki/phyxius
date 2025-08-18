import type { Clock } from "@phyxius/clock";
import type {
  JournalEntry,
  JournalOptions,
  JournalSnapshot,
  Subscriber,
  Unsubscribe,
  JournalEvent,
  SerializedJournal,
  IdGenerator,
} from "./types.js";
import { JournalReentrancyError, JournalOverflowError } from "./types.js";

export class Journal<T> {
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly emit: ((event: JournalEvent) => void) | undefined;
  private readonly maxEntries: number | undefined;
  private readonly overflow: "none" | "bounded:drop_oldest" | "bounded:error";
  private readonly serializer:
    | {
        serialize(data: T): unknown;
        deserialize(data: unknown): T;
      }
    | undefined;

  private entries: (JournalEntry<T> | undefined)[] = [];
  private firstSequence = 0;
  private nextSequence = 0;
  private subscribers = new Set<Subscriber<T>>();
  private isProcessingSubscribers = false;
  private readonly journalId: string;
  private readonly createdAt;

  constructor(options: JournalOptions<T>) {
    this.clock = options.clock;
    this.idGenerator = options.idGenerator ?? (() => Math.random().toString(36).slice(2));
    this.emit = options.emit;
    this.maxEntries = options.maxEntries;
    this.overflow = options.overflow ?? "none";
    this.serializer = options.serializer;

    this.journalId = this.idGenerator();
    this.createdAt = this.clock.now();

    this.emit?.({
      type: "journal:create",
      journalId: this.journalId,
      at: this.createdAt,
    });
  }

  append(data: T): JournalEntry<T> {
    if (this.isProcessingSubscribers) {
      throw new JournalReentrancyError();
    }

    // Check overflow policy
    if (this.maxEntries !== undefined && this.size() >= this.maxEntries) {
      if (this.overflow === "bounded:error") {
        this.emit?.({
          type: "journal:overflow",
          policy: this.overflow,
          maxEntries: this.maxEntries,
          at: this.clock.now(),
        });
        throw new JournalOverflowError(this.maxEntries);
      } else if (this.overflow === "bounded:drop_oldest") {
        // Drop the oldest entry to make room for one new entry
        const droppedCount = 1;

        // Find the first non-undefined entry (oldest) and drop it
        for (let i = 0; i < this.entries.length; i++) {
          if (this.entries[i] !== undefined) {
            this.entries[i] = undefined;
            // If this was at index 0, we need to advance the firstSequence
            // and compact the array by removing leading undefined entries
            if (i === 0) {
              // Remove leading undefined entries and adjust firstSequence
              let removeCount = 0;
              while (removeCount < this.entries.length && this.entries[removeCount] === undefined) {
                removeCount++;
              }
              this.entries.splice(0, removeCount);
              this.firstSequence += removeCount;
            }
            break;
          }
        }

        this.emit?.({
          type: "journal:overflow",
          policy: this.overflow,
          maxEntries: this.maxEntries,
          droppedCount,
          at: this.clock.now(),
        });
      }
    }

    const entry: JournalEntry<T> = {
      id: this.idGenerator(),
      sequence: this.nextSequence++,
      timestamp: this.clock.now(),
      data,
    };

    // O(1) append using dense array
    const index = entry.sequence - this.firstSequence;
    this.entries[index] = entry;

    this.emit?.({
      type: "journal:append",
      id: entry.id,
      seq: entry.sequence,
      size: this.size(),
      at: entry.timestamp,
    });

    // Notify subscribers
    this.notifySubscribers(entry);

    return entry;
  }

  getEntry(sequence: number): JournalEntry<T> | undefined {
    if (sequence < this.firstSequence || sequence >= this.nextSequence) {
      return undefined;
    }
    // O(1) access using dense array
    const index = sequence - this.firstSequence;
    return this.entries[index];
  }

  getFirst(): JournalEntry<T> | undefined {
    if (this.isEmpty()) return undefined;
    // Find first non-undefined entry
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i] !== undefined) {
        return this.entries[i];
      }
    }
    return undefined;
  }

  getLast(): JournalEntry<T> | undefined {
    if (this.isEmpty()) return undefined;
    // Find last non-undefined entry
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i] !== undefined) {
        return this.entries[i];
      }
    }
    return undefined;
  }

  size(): number {
    // Count non-undefined entries
    let count = 0;
    for (const entry of this.entries) {
      if (entry !== undefined) count++;
    }
    return count;
  }

  isEmpty(): boolean {
    return this.size() === 0;
  }

  clear(): void {
    const previousSize = this.size();
    this.entries = [];
    this.firstSequence = this.nextSequence;

    this.emit?.({
      type: "journal:clear",
      previousSize,
      at: this.clock.now(),
    });
  }

  subscribe(fn: Subscriber<T>): Unsubscribe {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  getSnapshot(): JournalSnapshot<T> {
    const allEntries: JournalEntry<T>[] = [];
    for (const entry of this.entries) {
      if (entry !== undefined) {
        allEntries.push(entry);
      }
    }

    const snapshot: JournalSnapshot<T> = {
      firstSequence: this.firstSequence,
      lastSequence: this.nextSequence - 1,
      totalCount: allEntries.length,
      timestamp: this.clock.now(),
      entries: deepFreeze(structuredClone(allEntries)),
    };

    return snapshot;
  }

  toJSON(): SerializedJournal {
    const entries: SerializedJournal["entries"] = [];

    for (const entry of this.entries) {
      if (entry !== undefined) {
        entries.push({
          id: entry.id,
          sequence: entry.sequence,
          timestamp: entry.timestamp,
          data: this.serializer ? this.serializer.serialize(entry.data) : entry.data,
        });
      }
    }

    return {
      entries,
      nextSequence: this.nextSequence,
      createdAt: this.createdAt,
    };
  }

  static fromJSON<T>(json: SerializedJournal, options: JournalOptions<T>): Journal<T> {
    const journal = new Journal(options);

    // Restore state
    if (json.entries.length > 0) {
      const firstEntry = json.entries[0];
      if (firstEntry) {
        journal.firstSequence = firstEntry.sequence;
      }
      journal.nextSequence = json.nextSequence;

      // Rebuild entries array
      for (const entry of json.entries) {
        const index = entry.sequence - journal.firstSequence;
        journal.entries[index] = {
          id: entry.id,
          sequence: entry.sequence,
          timestamp: entry.timestamp,
          data: options.serializer ? options.serializer.deserialize(entry.data) : (entry.data as T),
        };
      }
    }

    return journal;
  }

  private notifySubscribers(entry: JournalEntry<T>): void {
    if (this.subscribers.size === 0) return;

    this.isProcessingSubscribers = true;

    try {
      for (const subscriber of this.subscribers) {
        try {
          subscriber(entry);
        } catch (error) {
          this.emit?.({
            type: "journal:subscriber:error",
            seq: entry.sequence,
            id: entry.id,
            error,
            at: this.clock.now(),
          });
        }
      }
    } finally {
      this.isProcessingSubscribers = false;
    }
  }
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;

  Object.freeze(obj);

  if (Array.isArray(obj)) {
    obj.forEach((item) => deepFreeze(item));
  } else {
    Object.values(obj).forEach((value) => deepFreeze(value));
  }

  return obj;
}

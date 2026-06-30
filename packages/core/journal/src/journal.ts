import type { Clock } from "@phyxiusjs/clock";
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

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_OVERFLOW: "drop_oldest" | "error" = "drop_oldest";

/**
 * Where the journal is in its append/notify cycle. Naming these two states is
 * the whole point: an append is only legal from `idle`. While `notifying`, the
 * journal is walking its subscriber set, and a synchronous re-append from inside
 * a subscriber would corrupt that walk — so it is refused, deliberately, not by
 * accident of a bare boolean. Subscribers that want to append must defer
 * (`queueMicrotask`/`setTimeout(0)`) so the append lands once we're `idle` again.
 */
type ProcessingState = { readonly kind: "idle" } | { readonly kind: "notifying" };

const IDLE: ProcessingState = { kind: "idle" };
const NOTIFYING: ProcessingState = { kind: "notifying" };

export class Journal<T> {
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly emit: ((event: JournalEvent) => void) | undefined;
  private readonly maxEntries: number;
  private readonly overflow: "drop_oldest" | "error";
  private readonly serializer:
    | {
        serialize(data: T): unknown;
        deserialize(data: unknown): T;
      }
    | undefined;

  // Always dense: entries[0] is the oldest, entries[length-1] is the newest.
  private entries: JournalEntry<T>[] = [];
  private firstSequence = 0;
  private nextSequence = 0;
  private subscribers = new Set<Subscriber<T>>();
  private processingState: ProcessingState = IDLE;
  private readonly journalId: string;
  private createdAt;

  constructor(options: JournalOptions<T>) {
    this.clock = options.clock;
    this.idGenerator = options.idGenerator ?? (() => Math.random().toString(36).slice(2));
    this.emit = options.emit;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.overflow = options.overflow ?? DEFAULT_OVERFLOW;
    this.serializer = options.serializer;

    if (this.maxEntries <= 0) {
      throw new Error(`Journal maxEntries must be > 0 (got ${this.maxEntries})`);
    }

    this.journalId = this.idGenerator();
    this.createdAt = this.clock.now();

    this.emit?.({
      type: "journal:create",
      journalId: this.journalId,
      at: this.createdAt,
    });
  }

  append(data: T): JournalEntry<T> {
    // Classify first: an append is only admissible from `idle`. A re-append from
    // inside subscriber dispatch is refused as a named state transition, not as a
    // side effect of a bare boolean — see ProcessingState.
    if (this.processingState.kind === "notifying") {
      throw new JournalReentrancyError();
    }

    // Enforce the cap. There is no unbounded mode.
    if (this.entries.length >= this.maxEntries) {
      if (this.overflow === "error") {
        this.emit?.({
          type: "journal:overflow",
          policy: this.overflow,
          maxEntries: this.maxEntries,
          at: this.clock.now(),
        });
        throw new JournalOverflowError(this.maxEntries);
      }

      // drop_oldest: evict one to make room. Array is always dense.
      this.entries.shift();
      this.firstSequence += 1;

      this.emit?.({
        type: "journal:overflow",
        policy: this.overflow,
        maxEntries: this.maxEntries,
        droppedCount: 1,
        at: this.clock.now(),
      });
    }

    const entry: JournalEntry<T> = Object.freeze({
      id: this.idGenerator(),
      sequence: this.nextSequence++,
      timestamp: this.clock.now(),
      data,
    });

    this.entries.push(entry);

    this.emit?.({
      type: "journal:append",
      id: entry.id,
      seq: entry.sequence,
      size: this.entries.length,
      at: entry.timestamp,
    });

    this.notifySubscribers(entry);

    return entry;
  }

  getEntry(sequence: number): JournalEntry<T> | undefined {
    if (sequence < this.firstSequence || sequence >= this.nextSequence) {
      return undefined;
    }
    return this.entries[sequence - this.firstSequence];
  }

  getFirst(): JournalEntry<T> | undefined {
    return this.entries[0];
  }

  getLast(): JournalEntry<T> | undefined {
    return this.entries[this.entries.length - 1];
  }

  size(): number {
    return this.entries.length;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  clear(): void {
    const previousSize = this.entries.length;
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
    // Shallow copy of the entry array so later appends don't mutate the
    // snapshot — but entries themselves are already frozen at creation, so
    // this is O(N) array allocation, not O(N) deep clone. User-owned `data`
    // is the caller's to manage; provide a Serializer for defensive copies.
    return Object.freeze({
      firstSequence: this.firstSequence,
      lastSequence: this.nextSequence - 1,
      totalCount: this.entries.length,
      timestamp: this.clock.now(),
      entries: Object.freeze(this.entries.slice()),
    });
  }

  toJSON(): SerializedJournal {
    const entries: SerializedJournal["entries"] = this.entries.map((entry) => ({
      id: entry.id,
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      data: this.serializer ? this.serializer.serialize(entry.data) : entry.data,
    }));

    return {
      entries,
      nextSequence: this.nextSequence,
      createdAt: this.createdAt,
    };
  }

  static fromJSON<T>(json: SerializedJournal, options: JournalOptions<T>): Journal<T> {
    const journal = new Journal(options);

    if (json.createdAt) {
      journal.createdAt = json.createdAt;
    }

    if (json.entries.length > 0) {
      const firstEntry = json.entries[0];
      if (firstEntry) {
        journal.firstSequence = firstEntry.sequence;
      }
      journal.nextSequence = json.nextSequence;

      for (const entry of json.entries) {
        journal.entries.push(
          Object.freeze({
            id: entry.id,
            sequence: entry.sequence,
            timestamp: entry.timestamp,
            data: options.serializer ? options.serializer.deserialize(entry.data) : (entry.data as T),
          }),
        );
      }
    }

    return journal;
  }

  private notifySubscribers(entry: JournalEntry<T>): void {
    if (this.subscribers.size === 0) return;

    this.processingState = NOTIFYING;

    try {
      for (const subscriber of this.subscribers) {
        try {
          subscriber(entry);
        } catch (error) {
          // A reentrant append is a contract violation by the subscriber, not a
          // routine subscriber failure: it means the subscriber tried to append
          // synchronously instead of deferring. Name it as its own event so it
          // doesn't masquerade as an ordinary `journal:subscriber:error` and so
          // operators can see the swallowed reentrancy that used to be invisible.
          this.emit?.(
            error instanceof JournalReentrancyError
              ? {
                  type: "journal:subscriber:reentrancy",
                  seq: entry.sequence,
                  id: entry.id,
                  at: this.clock.now(),
                }
              : {
                  type: "journal:subscriber:error",
                  seq: entry.sequence,
                  id: entry.id,
                  error,
                  at: this.clock.now(),
                },
          );
        }
      }
    } finally {
      this.processingState = IDLE;
    }
  }
}

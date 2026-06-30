import type { Clock, Instant } from "@phyxiusjs/clock";

// Core types
export interface IdGenerator {
  (): string;
}

export interface JournalEntry<T> {
  id: string;
  sequence: number;
  timestamp: Instant;
  data: T;
}

/**
 * What happens when the journal is full. Every journal is bounded — there is no
 * unbounded mode. A journal that can grow without limit is an OOM waiting to
 * happen, and "we'll decide later what to drop" almost always becomes "production
 * decided by crashing."
 *
 *  - `"drop_oldest"` — evict the oldest entry to make room for the new one.
 *    The eviction fires a `journal:overflow` event. Use this when recent events
 *    matter more than old ones (most monitoring/debugging workloads).
 *  - `"error"` — throw `JournalOverflowError` on append when full. Use this when
 *    losing an event silently is unacceptable and the caller must handle the
 *    pressure (e.g. back-pressuring a producer).
 */
export type OverflowPolicy = "drop_oldest" | "error";

export interface JournalOptions<T> {
  clock: Clock;
  idGenerator?: IdGenerator;
  emit?: EmitFn;
  /** Cap on stored entries. Defaults to 10_000. Must be > 0 if provided. */
  maxEntries?: number;
  /** What to do when the cap is reached. Defaults to `"drop_oldest"`. */
  overflow?: OverflowPolicy;
  serializer?: Serializer<T>;
}

// Serialization
export interface Serializer<T> {
  serialize(data: T): unknown;
  deserialize(data: unknown): T;
}

export interface SerializedJournal {
  entries: Array<{
    id: string;
    sequence: number;
    timestamp: Instant;
    data: unknown;
  }>;
  nextSequence: number;
  createdAt?: Instant;
}

// Snapshot. Entries are frozen at creation, so this is a read-only view —
// there is no defensive clone. If you hand in mutable `data` and mutate it
// afterward, that's your call; provide a `Serializer` if you want defensive
// copies on append.
export interface JournalSnapshot<T> {
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly totalCount: number;
  readonly timestamp: Instant;
  readonly entries: ReadonlyArray<Readonly<JournalEntry<T>>>;
}

// Events - discriminated union for type safety
export type JournalEvent =
  | {
      type: "journal:create";
      journalId: string;
      at: Instant;
    }
  | {
      type: "journal:append";
      id: string;
      seq: number;
      size: number;
      at: Instant;
    }
  | {
      type: "journal:subscriber:error";
      seq: number;
      id: string;
      error: unknown;
      at: Instant;
    }
  | {
      // A subscriber tried to append synchronously while the journal was
      // notifying. The append was refused (JournalReentrancyError) and the
      // subscriber should defer instead. Emitted distinctly from a generic
      // subscriber error so this reentrancy is observable, not swallowed.
      type: "journal:subscriber:reentrancy";
      seq: number;
      id: string;
      at: Instant;
    }
  | {
      type: "journal:clear";
      previousSize: number;
      at: Instant;
    }
  | {
      type: "journal:overflow";
      policy: OverflowPolicy;
      maxEntries: number;
      droppedCount?: number;
      at: Instant;
    };

export type EmitFn = (event: JournalEvent) => void;

export type Subscriber<T> = (entry: JournalEntry<T>) => void;
export type Unsubscribe = () => void;

// Errors
export class JournalReentrancyError extends Error {
  constructor() {
    super("Cannot append to journal while processing subscribers");
    this.name = "JournalReentrancyError";
  }
}

export class JournalOverflowError extends Error {
  constructor(maxEntries: number) {
    super(`Journal overflow: maximum entries (${maxEntries}) reached`);
    this.name = "JournalOverflowError";
  }
}

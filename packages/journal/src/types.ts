import type { Clock, Instant } from "@phyxius/clock";

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

// Backpressure policies
export type OverflowPolicy = "none" | "bounded:drop_oldest" | "bounded:error";

export interface JournalOptions<T> {
  clock: Clock;
  idGenerator?: IdGenerator;
  emit?: EmitFn;
  maxEntries?: number;
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

// Snapshot
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

export interface EmitFn {
  (event: Record<string, unknown>): void;
}

export interface JournalEntry<T = unknown> {
  id: string;
  payload: T;
  timestamp: number;
  sequence: number;
}

export interface JournalSnapshot<T = unknown> {
  entries: JournalEntry<T>[];
  totalCount: number;
  firstSequence: number;
  lastSequence: number;
  timestamp: number;
}

export interface Journal<T = unknown> {
  append(payload: T): JournalEntry<T>;
  read(fromSequence?: number, limit?: number): JournalEntry<T>[];
  readAll(): JournalEntry<T>[];
  getEntry(sequence: number): JournalEntry<T> | undefined;
  getSnapshot(): JournalSnapshot<T>;
  size(): number;
  clear(): void;
  subscribe(callback: (entry: JournalEntry<T>) => void): () => void;
}

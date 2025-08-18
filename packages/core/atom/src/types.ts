import type { Instant } from "@phyxius/clock";

export interface AtomOptions<T> {
  /** Equality check to avoid no-op writes and power CAS. Defaults to Object.is */
  equals?: (a: T, b: T) => boolean;
  /** Start version (default 0) */
  baseVersion?: number;
  /** Keep an in-memory ring buffer of the last N snapshots (default 1) */
  historySize?: number;
}

export interface Change<T> {
  readonly from: T;
  readonly to: T;
  readonly versionFrom: number;
  readonly versionTo: number;
  readonly at: Instant; // from injected Clock
  readonly cause?: unknown; // free-form metadata
}

export interface AtomSnapshot<T> {
  readonly value: T;
  readonly version: number;
  readonly at: Instant;
}

export interface Atom<T> {
  /** Current value */
  deref(): T;

  /** Current version (monotonically increasing) */
  version(): number;

  /** Atomic functional update; returns the new value */
  swap(updater: (current: T) => T, opts?: { cause?: unknown }): T;

  /** Replace with a specific value; returns the new value */
  reset(next: T, opts?: { cause?: unknown }): T;

  /** Compare-and-set using the configured equals() */
  compareAndSet(expected: T, next: T, opts?: { cause?: unknown }): boolean;

  /** Snapshot of the current state */
  snapshot(): AtomSnapshot<T>;

  /**
   * Subscribe to committed changes.
   * - Synchronous, ordered callbacks.
   * - Re-entrant updates inside a subscriber must throw.
   * Returns an unsubscribe function.
   */
  watch(fn: (change: Change<T>) => void): () => void;

  /**
   * Read recent history. Not a full audit log.
   * For full history/replay, bridge to @phyxius/journal.
   */
  history(): readonly AtomSnapshot<T>[];

  /** Clear local history buffer (not the current value) */
  clearHistory(): void;
}

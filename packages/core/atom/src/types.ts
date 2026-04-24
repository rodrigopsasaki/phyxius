import type { Instant } from "@phyxiusjs/clock";

/**
 * Out-of-band events that the Atom emits.
 *
 * Committed changes are delivered via `watch`, not `emit` — `watch` is the
 * structured observability channel for state transitions. `emit` is reserved
 * for things that watchers can't see (notably: subscriber errors).
 */
export type AtomEvent = {
  type: "atom:subscriber:error";
  error: unknown;
  versionFrom: number;
  versionTo: number;
  at: Instant;
};

export type EmitFn = (event: AtomEvent) => void;

export interface AtomOptions<T> {
  /** Equality check to avoid no-op writes and power CAS. Defaults to Object.is */
  equals?: (a: T, b: T) => boolean;
  /**
   * Keep an in-memory ring buffer of the last N snapshots.
   *
   * Defaults to 0 — `history()` returns `[]` unless you opt in.
   * For a full durable audit trail, bridge `watch` into `@phyxiusjs/journal`.
   */
  historySize?: number;
  /**
   * Optional sink for out-of-band events. If omitted, subscriber errors are
   * silently swallowed — the library does NOT write to stderr.
   */
  emit?: EmitFn;
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
   * For full history/replay, bridge to @phyxiusjs/journal.
   */
  history(): readonly AtomSnapshot<T>[];

  /** Clear local history buffer (not the current value) */
  clearHistory(): void;
}

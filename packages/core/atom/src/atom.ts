import type { Clock } from "@phyxius/clock";
import type { Atom, AtomSnapshot, AtomOptions, Change } from "./types.js";

export class AtomImpl<T> implements Atom<T> {
  private value: T;
  private _version: number;
  private readonly clock: Clock;
  private readonly equals: (a: T, b: T) => boolean;
  private readonly historyBuffer: AtomSnapshot<T>[] = [];
  private readonly historySize: number;
  private readonly subscribers: Set<(change: Change<T>) => void> = new Set();
  private inNotification = false;

  constructor(initialValue: T, clock: Clock, options: AtomOptions<T> = {}) {
    this.value = initialValue;
    this._version = options.baseVersion ?? 0;
    this.clock = clock;
    this.equals = options.equals ?? Object.is;
    this.historySize = Math.max(1, options.historySize ?? 1);

    // Store initial snapshot
    const initialSnapshot: AtomSnapshot<T> = {
      value: initialValue,
      version: this._version,
      at: clock.now(),
    };
    this.historyBuffer.push(initialSnapshot);
  }

  deref(): T {
    return this.value;
  }

  version(): number {
    return this._version;
  }

  swap(updater: (current: T) => T, opts?: { cause?: unknown }): T {
    if (this.inNotification) {
      throw new Error("Cannot update atom during notification (reentrant update)");
    }

    const oldValue = this.value;
    const oldVersion = this._version;
    const newValue = updater(oldValue);

    // No-op if values are equal
    if (this.equals(oldValue, newValue)) {
      return oldValue;
    }

    // Update state
    this.value = newValue;
    this._version++;

    const snapshot: AtomSnapshot<T> = {
      value: newValue,
      version: this._version,
      at: this.clock.now(),
    };

    // Add to history ring buffer
    this.historyBuffer.push(snapshot);
    if (this.historyBuffer.length > this.historySize) {
      this.historyBuffer.shift();
    }

    // Notify subscribers
    this.notifyChange({
      from: oldValue,
      to: newValue,
      versionFrom: oldVersion,
      versionTo: this._version,
      at: snapshot.at,
      cause: opts?.cause,
    });

    return newValue;
  }

  reset(next: T, opts?: { cause?: unknown }): T {
    return this.swap(() => next, opts);
  }

  compareAndSet(expected: T, next: T, opts?: { cause?: unknown }): boolean {
    if (!this.equals(this.value, expected)) {
      return false;
    }

    this.swap(() => next, opts);
    return true;
  }

  snapshot(): AtomSnapshot<T> {
    return {
      value: this.value,
      version: this._version,
      at: this.clock.now(),
    };
  }

  watch(fn: (change: Change<T>) => void): () => void {
    this.subscribers.add(fn);

    return () => {
      this.subscribers.delete(fn);
    };
  }

  history(): readonly AtomSnapshot<T>[] {
    return [...this.historyBuffer];
  }

  clearHistory(): void {
    // Keep only the current snapshot
    const current = this.historyBuffer[this.historyBuffer.length - 1];
    this.historyBuffer.length = 0;
    if (current) {
      this.historyBuffer.push(current);
    }
  }

  private notifyChange(change: Change<T>): void {
    if (this.subscribers.size === 0) {
      return;
    }

    this.inNotification = true;
    try {
      for (const subscriber of this.subscribers) {
        try {
          subscriber(change);
        } catch (error) {
          // Swallow subscriber errors to prevent cascade failures
          // In a real implementation, you might want to log this
          console.error("Atom subscriber error:", error);
        }
      }
    } finally {
      this.inNotification = false;
    }
  }
}

export function createAtom<T>(initial: T, clock: Clock, opts?: AtomOptions<T>): Atom<T> {
  return new AtomImpl(initial, clock, opts);
}

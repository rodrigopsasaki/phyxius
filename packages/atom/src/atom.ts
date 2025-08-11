import type { Atom, AtomSnapshot, EmitFn } from "./types.js";

export class AtomImpl<T> implements Atom<T> {
  private value: T;
  private readonly initialValue: T;
  private version = 0;
  private readonly emit: EmitFn | undefined;
  private readonly history: AtomSnapshot<T>[] = [];
  private readonly subscribers: Set<(snapshot: AtomSnapshot<T>) => void> = new Set();
  private readonly maxHistory: number;

  constructor(initialValue: T, options?: { emit?: EmitFn; maxHistory?: number }) {
    this.initialValue = initialValue;
    this.value = initialValue;
    this.emit = options?.emit;
    this.maxHistory = options?.maxHistory ?? 100;

    const initialSnapshot = this.createSnapshot();
    this.history.push(initialSnapshot);

    this.emit?.({
      type: "atom:create",
      version: this.version,
      value: this.value,
      timestamp: initialSnapshot.timestamp,
    });
  }

  get(): T {
    this.emit?.({
      type: "atom:get",
      version: this.version,
      value: this.value,
      timestamp: Date.now(),
    });

    return this.value;
  }

  set(value: T): void {
    const oldValue = this.value;
    const oldVersion = this.version;

    if (Object.is(oldValue, value)) {
      this.emit?.({
        type: "atom:set:noop",
        version: this.version,
        value,
        timestamp: Date.now(),
      });
      return;
    }

    this.value = value;
    this.version++;

    const snapshot = this.createSnapshot();
    this.addToHistory(snapshot);

    this.emit?.({
      type: "atom:set",
      version: this.version,
      oldVersion,
      value,
      oldValue,
      timestamp: snapshot.timestamp,
    });

    this.notifySubscribers(snapshot);
  }

  update(fn: (current: T) => T): T {
    const oldValue = this.value;
    const newValue = fn(oldValue);
    this.set(newValue);
    return newValue;
  }

  swap(fn: (current: T) => T): T {
    return this.update(fn);
  }

  compareAndSet(expected: T, value: T): boolean {
    const current = this.value;
    const matches = Object.is(current, expected);

    if (matches) {
      this.set(value);
      this.emit?.({
        type: "atom:cas:success",
        version: this.version,
        expected,
        value,
        timestamp: Date.now(),
      });
      return true;
    } else {
      this.emit?.({
        type: "atom:cas:failure",
        version: this.version,
        expected,
        actual: current,
        value,
        timestamp: Date.now(),
      });
      return false;
    }
  }

  getSnapshot(): AtomSnapshot<T> {
    return this.createSnapshot();
  }

  getHistory(): AtomSnapshot<T>[] {
    return [...this.history];
  }

  reset(): void {
    const oldValue = this.value;
    const oldVersion = this.version;

    this.value = this.initialValue;
    this.version++;

    const snapshot = this.createSnapshot();
    this.addToHistory(snapshot);

    this.emit?.({
      type: "atom:reset",
      version: this.version,
      oldVersion,
      value: this.value,
      oldValue,
      timestamp: snapshot.timestamp,
    });

    this.notifySubscribers(snapshot);
  }

  subscribe(callback: (snapshot: AtomSnapshot<T>) => void): () => void {
    this.subscribers.add(callback);

    this.emit?.({
      type: "atom:subscribe",
      subscriberCount: this.subscribers.size,
      timestamp: Date.now(),
    });

    try {
      callback(this.getSnapshot());
    } catch (error) {
      this.emit?.({
        type: "atom:subscriber:error",
        error,
        version: this.version,
        timestamp: Date.now(),
      });
    }

    return () => {
      this.subscribers.delete(callback);
      this.emit?.({
        type: "atom:unsubscribe",
        subscriberCount: this.subscribers.size,
        timestamp: Date.now(),
      });
    };
  }

  private createSnapshot(): AtomSnapshot<T> {
    return {
      value: this.value,
      version: this.version,
      timestamp: Date.now(),
    };
  }

  private addToHistory(snapshot: AtomSnapshot<T>): void {
    this.history.push(snapshot);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  private notifySubscribers(snapshot: AtomSnapshot<T>): void {
    for (const callback of this.subscribers) {
      try {
        callback(snapshot);
      } catch (error) {
        this.emit?.({
          type: "atom:subscriber:error",
          error,
          version: this.version,
          timestamp: Date.now(),
        });
      }
    }
  }
}

export interface EmitFn {
  (event: Record<string, unknown>): void;
}

export interface AtomSnapshot<T> {
  value: T;
  version: number;
  timestamp: number;
}

export interface Atom<T> {
  get(): T;
  set(value: T): void;
  update(fn: (current: T) => T): T;
  swap(fn: (current: T) => T): T;
  compareAndSet(expected: T, value: T): boolean;
  getSnapshot(): AtomSnapshot<T>;
  getHistory(): AtomSnapshot<T>[];
  reset(): void;
  subscribe(callback: (snapshot: AtomSnapshot<T>) => void): () => void;
}

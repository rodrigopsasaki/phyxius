export interface EmitFn {
  (event: Record<string, unknown>): void;
}

export interface Context {
  readonly values: Map<string, unknown>;
  get<T>(key: string): T | undefined;
  with<T>(key: string, value: T): Context;
}

export type EffectFn<T> = (context: Context) => Promise<T>;

export interface Effect<T> {
  run(context?: Context): Promise<T>;
  map<U>(fn: (value: T) => U): Effect<U>;
  flatMap<U>(fn: (value: T) => Effect<U>): Effect<U>;
  catch<U>(fn: (error: Error) => Effect<U>): Effect<T | U>;
  timeout(ms: number): Effect<T>;
  withContext<U>(key: string, value: U): Effect<T>;
}

export interface Scope {
  readonly id: string;
  readonly parentId: string | undefined;
  isCancelled(): boolean;
  cancel(): void;
  onCancel(callback: () => void): void;
}

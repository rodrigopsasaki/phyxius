import type { CancelToken } from "./cancelToken.js";
import type { Scope as FinalizerScope } from "./finalizers.js";

export interface EmitFn {
  (event: Record<string, unknown>): void;
}

export interface Clock {
  now(): { wallMs: number; monoMs: number };
  sleep(ms: number): Promise<void>;
}

export interface EffectEnv {
  clock?: Clock;
  cancel: CancelToken;
  scope: FinalizerScope;
}

export interface Context {
  readonly values: Map<string, unknown>;
  get<T>(key: string): T | undefined;
  with<T>(key: string, value: T): Context;
}

export type EffectFn<E, A> = (env: EffectEnv) => Promise<Result<E, A>>;

export type Result<E, A> = { _tag: "Ok"; value: A } | { _tag: "Err"; error: E };

export interface Fiber<E, A> {
  id: string;
  join(): Effect<E, A>;
  interrupt(): Effect<never, void>;
  poll(): Effect<never, Result<E, A> | undefined>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export interface Effect<E, A> {
  unsafeRunPromise(env?: Partial<Omit<EffectEnv, "cancel" | "scope">>): Promise<Result<E, A>>;
  run(context?: any): Promise<A>; // Backward compatibility - throws on error
  map<B>(fn: (value: A) => B): Effect<E, B>;
  flatMap<E2, B>(fn: (value: A) => Effect<E2, B>): Effect<E | E2, B>;
  catch<E2, B>(fn: (error: E) => Effect<E2, B>): Effect<E2, A | B>;
  timeout(ms: number): Effect<E | { _tag: "Timeout" }, A>;
  withContext<U>(key: string, value: U): Effect<E, A>;
  fork(): Effect<never, Fiber<E, A>>;
  onInterrupt(cleanup: () => Effect<never, void>): Effect<E, A>;
  retry(policy: RetryPolicy): Effect<E | { _tag: "Interrupted" }, A>;
}

// Legacy Scope interface for backward compatibility with existing code
export interface Scope {
  readonly id: string;
  readonly parentId: string | undefined;
  isCancelled(): boolean;
  cancel(): void;
  onCancel(callback: () => void): void;
}

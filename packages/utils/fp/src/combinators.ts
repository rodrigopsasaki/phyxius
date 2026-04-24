/**
 * Functional combinators for partial application, currying, and function manipulation.
 * These are the building blocks for point-free programming.
 */

import type { Result } from "./result.js";
import { ok, err } from "./result.js";

/** Curry a 2-argument function */
export function curry2<A, B, R>(fn: (a: A, b: B) => R): (a: A) => (b: B) => R {
  return (a: A) => (b: B) => fn(a, b);
}

/** Curry a 3-argument function */
export function curry3<A, B, C, R>(fn: (a: A, b: B, c: C) => R): (a: A) => (b: B) => (c: C) => R {
  return (a: A) => (b: B) => (c: C) => fn(a, b, c);
}

/** Curry a 4-argument function */
export function curry4<A, B, C, D, R>(fn: (a: A, b: B, c: C, d: D) => R): (a: A) => (b: B) => (c: C) => (d: D) => R {
  return (a: A) => (b: B) => (c: C) => (d: D) => fn(a, b, c, d);
}

/** Uncurry a curried 2-argument function */
export function uncurry2<A, B, R>(fn: (a: A) => (b: B) => R): (a: A, b: B) => R {
  return (a: A, b: B) => fn(a)(b);
}

/** Uncurry a curried 3-argument function */
export function uncurry3<A, B, C, R>(fn: (a: A) => (b: B) => (c: C) => R): (a: A, b: B, c: C) => R {
  return (a: A, b: B, c: C) => fn(a)(b)(c);
}

/** Uncurry a curried 4-argument function */
export function uncurry4<A, B, C, D, R>(fn: (a: A) => (b: B) => (c: C) => (d: D) => R): (a: A, b: B, c: C, d: D) => R {
  return (a: A, b: B, c: C, d: D) => fn(a)(b)(c)(d);
}

/** Partial application - apply first argument */
export function partial<A, B, R>(fn: (a: A, b: B) => R, a: A): (b: B) => R {
  return (b: B) => fn(a, b);
}

/** Partial application - apply first two arguments */
export function partial2<A, B, C, R>(fn: (a: A, b: B, c: C) => R, a: A, b: B): (c: C) => R {
  return (c: C) => fn(a, b, c);
}

/** Partial application - apply first three arguments */
export function partial3<A, B, C, D, R>(fn: (a: A, b: B, c: C, d: D) => R, a: A, b: B, c: C): (d: D) => R {
  return (d: D) => fn(a, b, c, d);
}

/** Partial application from the right - apply last argument */
export function partialRight<A, B, R>(fn: (a: A, b: B) => R, b: B): (a: A) => R {
  return (a: A) => fn(a, b);
}

/** Partial application from the right - apply last two arguments */
export function partialRight2<A, B, C, R>(fn: (a: A, b: B, c: C) => R, b: B, c: C): (a: A) => R {
  return (a: A) => fn(a, b, c);
}

/** Flip the arguments of a 2-argument function */
export function flip<A, B, R>(fn: (a: A, b: B) => R): (b: B, a: A) => R {
  return (b: B, a: A) => fn(a, b);
}

/** Options for memoize / memoizeWith. */
export interface MemoizeOptions {
  /**
   * Cap on the number of cached entries. When exceeded, the least-recently-used
   * entry is evicted. Default 1000. Pass `Infinity` only if you're certain the
   * input domain is small — an unbounded cache is a silent memory leak.
   */
  readonly maxSize?: number;
}

const DEFAULT_MEMOIZE_MAX = 1000;

/**
 * Memoize a single-argument function, with bounded LRU caching.
 *
 * Cache keys use reference equality (Map's default). For structural keys,
 * use `memoizeWith` and provide a key function.
 */
export function memoize<A, R>(fn: (a: A) => R, options: MemoizeOptions = {}): (a: A) => R {
  const maxSize = options.maxSize ?? DEFAULT_MEMOIZE_MAX;
  const cache = new Map<A, R>();

  return (a: A) => {
    if (cache.has(a)) {
      // LRU touch: move to end.
      const value = cache.get(a) as R;
      cache.delete(a);
      cache.set(a, value);
      return value;
    }
    const result = fn(a);
    cache.set(a, result);
    if (cache.size > maxSize) {
      // Map iterates in insertion order; the first key is the LRU.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return result;
  };
}

/**
 * Memoize with a custom string key function, with bounded LRU caching.
 * Use when the argument isn't suitable for reference-equality caching
 * (e.g. deeply equal objects that shouldn't be cached separately).
 */
export function memoizeWith<A, R>(fn: (a: A) => R, keyFn: (a: A) => string, options: MemoizeOptions = {}): (a: A) => R {
  const maxSize = options.maxSize ?? DEFAULT_MEMOIZE_MAX;
  const cache = new Map<string, R>();

  return (a: A) => {
    const key = keyFn(a);
    if (cache.has(key)) {
      const value = cache.get(key) as R;
      cache.delete(key);
      cache.set(key, value);
      return value;
    }
    const result = fn(a);
    cache.set(key, result);
    if (cache.size > maxSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return result;
  };
}

/**
 * Call a function exactly once. The outcome of the first call — success OR
 * thrown error — is cached. Subsequent calls replay it: the value is
 * returned, or the original error is rethrown. This is strictly once, not
 * "retry until success."
 */
export function once<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  type State =
    | { readonly done: false }
    | { readonly done: true; readonly ok: true; readonly value: R }
    | { readonly done: true; readonly ok: false; readonly error: unknown };

  let state: State = { done: false };

  return (...args: A) => {
    if (state.done) {
      if (state.ok) return state.value;
      throw state.error;
    }
    try {
      const value = fn(...args);
      state = { done: true, ok: true, value };
      return value;
    } catch (error) {
      state = { done: true, ok: false, error };
      throw error;
    }
  };
}

/** Lazy evaluation - compute value only when needed */
export function lazy<T>(fn: () => T): () => T {
  let computed = false;
  let result: T;
  return () => {
    if (!computed) {
      computed = true;
      result = fn();
    }
    return result;
  };
}

/** Apply function n times */
export function times<T>(n: number, fn: (index: number) => T): T[] {
  const results: T[] = [];
  for (let i = 0; i < n; i++) {
    results.push(fn(i));
  }
  return results;
}

/** Repeat value n times */
export function repeat<T>(n: number, value: T): T[] {
  return times(n, () => value);
}

/** Apply function until predicate returns false */
export function until<T>(predicate: (value: T) => boolean, fn: (value: T) => T, initial: T): T {
  let value = initial;
  while (!predicate(value)) {
    value = fn(value);
  }
  return value;
}

/** Apply function while predicate returns true */
export function whilst<T>(predicate: (value: T) => boolean, fn: (value: T) => T, initial: T): T {
  let value = initial;
  while (predicate(value)) {
    value = fn(value);
  }
  return value;
}

/** Converge - apply multiple functions and combine results */
export function converge<T, R>(
  combiner: (...args: unknown[]) => R,
  fns: Array<(value: T) => unknown>,
): (value: T) => R {
  return (value: T) => {
    const results = fns.map((fn) => fn(value));
    return combiner(...results);
  };
}

/** Fork - split data flow into multiple paths */
export function fork<T, R1, R2>(fn1: (value: T) => R1, fn2: (value: T) => R2): (value: T) => [R1, R2] {
  return (value: T) => [fn1(value), fn2(value)];
}

/** Join - combine multiple functions into one */
export function join<T, R>(fns: Array<(value: T) => R>): (value: T) => R[] {
  return (value: T) => fns.map((fn) => fn(value));
}

/**
 * Compose two nullable-returning functions, short-circuiting on null/undefined.
 * If `fn1` returns null/undefined, `fn2` is never called.
 */
export function chainNullable<A, B, C>(
  fn1: (a: A) => B | null | undefined,
  fn2: (b: B) => C | null | undefined,
): (a: A) => C | null | undefined {
  return (a: A) => {
    const b = fn1(a);
    return b !== null && b !== undefined ? fn2(b) : undefined;
  };
}

/**
 * Either-shaped try with fallback — lifts exception handling into the Result
 * world.
 *
 * Runs `fn1(a)`. On success, returns `Ok(value)`. On a matching exception
 * (see `predicate`), runs `fn2(a)`; if that succeeds, returns `Ok(value)`,
 * otherwise returns `Err({ primary, fallback })` with both errors attached.
 * When `predicate` rejects the primary error, `fn2` is NOT attempted and
 * the result is `Err({ primary })` — the function always returns a Result,
 * never throws.
 *
 * This is the lifting of the "try-with-fallback" pattern into the Either
 * monad. For the plain form that returns `R` directly and propagates
 * uncaught errors, use `tryOrElse`.
 */
export function either<A, R>(
  fn1: (a: A) => R,
  fn2: (a: A) => R,
  predicate: (error: unknown) => boolean = () => true,
): (a: A) => Result<R, { primary: unknown; fallback?: unknown }> {
  return (a: A) => {
    try {
      return ok(fn1(a));
    } catch (primary) {
      if (!predicate(primary)) {
        return err({ primary });
      }
      try {
        return ok(fn2(a));
      } catch (fallback) {
        return err({ primary, fallback });
      }
    }
  };
}

/**
 * Try `fn1`, fall back to `fn2` on matching exception. Returns `R` directly.
 * If the predicate rejects the primary error, it is rethrown. If the fallback
 * also throws, that error propagates.
 *
 * For the lifted Result form that accumulates both errors into an Err, use
 * `either`.
 */
export function tryOrElse<A, R>(
  fn1: (a: A) => R,
  fn2: (a: A) => R,
  predicate: (error: unknown) => boolean = () => true,
): (a: A) => R {
  return (a: A) => {
    try {
      return fn1(a);
    } catch (error) {
      if (predicate(error)) {
        return fn2(a);
      }
      throw error;
    }
  };
}

/** Both combinator - apply both functions and return tuple */
export function both<A, R1, R2>(fn1: (a: A) => R1, fn2: (a: A) => R2): (a: A) => [R1, R2] {
  return (a: A) => [fn1(a), fn2(a)];
}

/** All combinator - apply all functions */
export function all<A, R>(fns: Array<(a: A) => R>): (a: A) => R[] {
  return (a: A) => fns.map((fn) => fn(a));
}

/** Any combinator - return first successful result */
export function any<A, R>(fns: Array<(a: A) => R | null | undefined>): (a: A) => R | undefined {
  return (a: A) => {
    for (const fn of fns) {
      const result = fn(a);
      if (result !== null && result !== undefined) {
        return result;
      }
    }
    return undefined;
  };
}

/**
 * Function composition utilities for building pipelines.
 * Enables point-free programming and data transformation pipelines.
 */

/** Pipe functions left-to-right (data-first) */
export function pipe<A, B>(value: A, fn1: (a: A) => B): B;
export function pipe<A, B, C>(value: A, fn1: (a: A) => B, fn2: (b: B) => C): C;
export function pipe<A, B, C, D>(value: A, fn1: (a: A) => B, fn2: (b: B) => C, fn3: (c: C) => D): D;
export function pipe<A, B, C, D, E>(
  value: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
): E;
export function pipe<A, B, C, D, E, F>(
  value: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
): F;
export function pipe<A, B, C, D, E, F, G>(
  value: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
): G;
export function pipe<A, B, C, D, E, F, G, H>(
  value: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
  fn7: (g: G) => H,
): H;
export function pipe<A, B, C, D, E, F, G, H, I>(
  value: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
  fn7: (g: G) => H,
  fn8: (h: H) => I,
): I;
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  value: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
  fn7: (g: G) => H,
  fn8: (h: H) => I,
  fn9: (i: I) => J,
): J;
export function pipe<A, B, C, D, E, F, G, H, I, J, K>(
  value: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
  fn7: (g: G) => H,
  fn8: (h: H) => I,
  fn9: (i: I) => J,
  fn10: (j: J) => K,
): K;
export function pipe(value: unknown, ...fns: Array<(value: unknown) => unknown>): unknown {
  return fns.reduce((acc, fn) => fn(acc), value);
}

/** Flow functions left-to-right (returns a function) */
export function flow<A, B>(fn1: (a: A) => B): (a: A) => B;
export function flow<A, B, C>(fn1: (a: A) => B, fn2: (b: B) => C): (a: A) => C;
export function flow<A, B, C, D>(fn1: (a: A) => B, fn2: (b: B) => C, fn3: (c: C) => D): (a: A) => D;
export function flow<A, B, C, D, E>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
): (a: A) => E;
export function flow<A, B, C, D, E, F>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
): (a: A) => F;
export function flow<A, B, C, D, E, F, G>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
): (a: A) => G;
export function flow<A, B, C, D, E, F, G, H>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
  fn7: (g: G) => H,
): (a: A) => H;
export function flow<A, B, C, D, E, F, G, H, I>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
  fn7: (g: G) => H,
  fn8: (h: H) => I,
): (a: A) => I;
export function flow<A, B, C, D, E, F, G, H, I, J>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
  fn6: (f: F) => G,
  fn7: (g: G) => H,
  fn8: (h: H) => I,
  fn9: (i: I) => J,
): (a: A) => J;
export function flow(...fns: Array<(value: unknown) => unknown>) {
  return (value: unknown) => fns.reduce((acc, fn) => fn(acc), value);
}

/** Compose functions right-to-left (mathematical composition) */
export function compose<A, B>(fn1: (a: A) => B): (a: A) => B;
export function compose<A, B, C>(fn2: (b: B) => C, fn1: (a: A) => B): (a: A) => C;
export function compose<A, B, C, D>(fn3: (c: C) => D, fn2: (b: B) => C, fn1: (a: A) => B): (a: A) => D;
export function compose<A, B, C, D, E>(
  fn4: (d: D) => E,
  fn3: (c: C) => D,
  fn2: (b: B) => C,
  fn1: (a: A) => B,
): (a: A) => E;
export function compose<A, B, C, D, E, F>(
  fn5: (e: E) => F,
  fn4: (d: D) => E,
  fn3: (c: C) => D,
  fn2: (b: B) => C,
  fn1: (a: A) => B,
): (a: A) => F;
export function compose<A, B, C, D, E, F, G>(
  fn6: (f: F) => G,
  fn5: (e: E) => F,
  fn4: (d: D) => E,
  fn3: (c: C) => D,
  fn2: (b: B) => C,
  fn1: (a: A) => B,
): (a: A) => G;
export function compose<A, B, C, D, E, F, G, H>(
  fn7: (g: G) => H,
  fn6: (f: F) => G,
  fn5: (e: E) => F,
  fn4: (d: D) => E,
  fn3: (c: C) => D,
  fn2: (b: B) => C,
  fn1: (a: A) => B,
): (a: A) => H;
export function compose<A, B, C, D, E, F, G, H, I>(
  fn8: (h: H) => I,
  fn7: (g: G) => H,
  fn6: (f: F) => G,
  fn5: (e: E) => F,
  fn4: (d: D) => E,
  fn3: (c: C) => D,
  fn2: (b: B) => C,
  fn1: (a: A) => B,
): (a: A) => I;
export function compose<A, B, C, D, E, F, G, H, I, J>(
  fn9: (i: I) => J,
  fn8: (h: H) => I,
  fn7: (g: G) => H,
  fn6: (f: F) => G,
  fn5: (e: E) => F,
  fn4: (d: D) => E,
  fn3: (c: C) => D,
  fn2: (b: B) => C,
  fn1: (a: A) => B,
): (a: A) => J;
export function compose(...fns: Array<(value: unknown) => unknown>) {
  return (value: unknown) => fns.reduceRight((acc, fn) => fn(acc), value);
}

/** Async pipe functions left-to-right */
export function pipeAsync<A, B>(value: A, fn1: (a: A) => Promise<B>): Promise<B>;
export function pipeAsync<A, B, C>(value: A, fn1: (a: A) => Promise<B>, fn2: (b: B) => Promise<C>): Promise<C>;
export function pipeAsync<A, B, C, D>(
  value: A,
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
  fn3: (c: C) => Promise<D>,
): Promise<D>;
export function pipeAsync<A, B, C, D, E>(
  value: A,
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
  fn3: (c: C) => Promise<D>,
  fn4: (d: D) => Promise<E>,
): Promise<E>;
export function pipeAsync<A, B, C, D, E, F>(
  value: A,
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
  fn3: (c: C) => Promise<D>,
  fn4: (d: D) => Promise<E>,
  fn5: (e: E) => Promise<F>,
): Promise<F>;
export async function pipeAsync(value: unknown, ...fns: Array<(value: unknown) => Promise<unknown>>): Promise<unknown> {
  let result = value;
  for (const fn of fns) {
    result = await fn(result);
  }
  return result;
}

/** Async flow functions left-to-right (returns an async function) */
export function flowAsync<A, B>(fn1: (a: A) => Promise<B>): (a: A) => Promise<B>;
export function flowAsync<A, B, C>(fn1: (a: A) => Promise<B>, fn2: (b: B) => Promise<C>): (a: A) => Promise<C>;
export function flowAsync<A, B, C, D>(
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
  fn3: (c: C) => Promise<D>,
): (a: A) => Promise<D>;
export function flowAsync<A, B, C, D, E>(
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
  fn3: (c: C) => Promise<D>,
  fn4: (d: D) => Promise<E>,
): (a: A) => Promise<E>;
export function flowAsync<A, B, C, D, E, F>(
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
  fn3: (c: C) => Promise<D>,
  fn4: (d: D) => Promise<E>,
  fn5: (e: E) => Promise<F>,
): (a: A) => Promise<F>;
export function flowAsync(...fns: Array<(value: unknown) => Promise<unknown>>) {
  return async (value: unknown) => {
    let result = value;
    for (const fn of fns) {
      result = await fn(result);
    }
    return result;
  };
}

/** Identity function - returns its input unchanged */
export function identity<T>(value: T): T {
  return value;
}

/** Constant function - returns a function that always returns the same value */
export function constant<T>(value: T): () => T {
  return () => value;
}

/** Tap function - perform side effect without changing the value */
export function tap<T>(fn: (value: T) => void): (value: T) => T {
  return (value: T) => {
    fn(value);
    return value;
  };
}

/** Async tap function */
export function tapAsync<T>(fn: (value: T) => Promise<void>): (value: T) => Promise<T> {
  return async (value: T) => {
    await fn(value);
    return value;
  };
}

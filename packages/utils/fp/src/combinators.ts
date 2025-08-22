/**
 * Functional combinators for partial application, currying, and function manipulation.
 * These are the building blocks for point-free programming.
 */

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

/** Memoize a function (cache results) */
export function memoize<A, R>(fn: (a: A) => R): (a: A) => R {
  const cache = new Map<A, R>();
  return (a: A) => {
    if (cache.has(a)) {
      return cache.get(a)!;
    }
    const result = fn(a);
    cache.set(a, result);
    return result;
  };
}

/** Memoize with custom key function */
export function memoizeWith<A, R>(fn: (a: A) => R, keyFn: (a: A) => string): (a: A) => R {
  const cache = new Map<string, R>();
  return (a: A) => {
    const key = keyFn(a);
    if (cache.has(key)) {
      return cache.get(key)!;
    }
    const result = fn(a);
    cache.set(key, result);
    return result;
  };
}

/** Debounce a function */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): (...args: A) => void {
  let timeoutId: NodeJS.Timeout | undefined;
  return (...args: A) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delayMs);
  };
}

/** Throttle a function */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): (...args: A) => void {
  let lastCall = 0;
  let timeoutId: NodeJS.Timeout | undefined;
  return (...args: A) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delayMs) {
      lastCall = now;
      fn(...args);
    } else {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        fn(...args);
      }, delayMs - timeSinceLastCall);
    }
  };
}

/** Call function only once */
export function once<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
  let called = false;
  let result: R;
  return (...args: A) => {
    if (!called) {
      called = true;
      result = fn(...args);
      return result;
    }
    return result;
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

/** Kleisli composition for functions returning Options/Results */
export function composeK<A, B, C>(
  fn1: (a: A) => B | null | undefined,
  fn2: (b: B) => C | null | undefined,
): (a: A) => C | null | undefined {
  return (a: A) => {
    const b = fn1(a);
    return b !== null && b !== undefined ? fn2(b) : undefined;
  };
}

/** Either combinator - try first function, fall back to second on error */
export function either<A, R>(
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

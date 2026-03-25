/**
 * Async Result utilities for handling asynchronous operations that return Results.
 * Composable async error handling without exceptions.
 */

import type { Result, Err } from "./result.js";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { ok, err, isOk, isErr } from "./result.js";

/** Async Result type alias */
export type AsyncResult<T, E = Error> = Promise<Result<T, E>>;

/** Transform the success value of an AsyncResult */
export function mapAsync<T, U, E>(asyncResult: AsyncResult<T, E>, fn: (value: T) => U | Promise<U>): AsyncResult<U, E> {
  return asyncResult.then(async (result) => {
    if (isOk(result)) {
      return ok(await fn(result.value));
    }
    return result;
  });
}

/** Transform the error value of an AsyncResult */
export function mapErrAsync<T, E, F>(
  asyncResult: AsyncResult<T, E>,
  fn: (error: E) => F | Promise<F>,
): AsyncResult<T, F> {
  return asyncResult.then(async (result) => {
    if (isErr(result)) {
      return err(await fn(result.error));
    }
    return result;
  });
}

/** Flat map for AsyncResult (monadic bind) */
export function flatMapAsync<T, U, E>(
  asyncResult: AsyncResult<T, E>,
  fn: (value: T) => AsyncResult<U, E>,
): AsyncResult<U, E> {
  return asyncResult.then((result) => {
    if (isOk(result)) {
      return fn(result.value);
    }
    return Promise.resolve(result);
  });
}

/** Alias for flatMapAsync */
export const andThenAsync = flatMapAsync;
export const chainAsync = flatMapAsync;

/** Provide alternative AsyncResult if this one is Err */
export function orElseAsync<T, E, F>(
  asyncResult: AsyncResult<T, E>,
  fn: (error: E) => AsyncResult<T, F>,
): AsyncResult<T, F> {
  return asyncResult.then((result) => {
    if (isErr(result)) {
      return fn(result.error);
    }
    return Promise.resolve(result);
  });
}

/** Pattern matching for AsyncResult */
export async function matchAsync<T, E, U>(
  asyncResult: AsyncResult<T, E>,
  patterns: {
    ok: (value: T) => U | Promise<U>;
    err: (error: E) => U | Promise<U>;
  },
): Promise<U> {
  const result = await asyncResult;
  if (isOk(result)) {
    return patterns.ok(result.value);
  }
  return patterns.err(result.error);
}

/** Collect array of AsyncResults into AsyncResult of array */
export async function allAsync<T, E>(asyncResults: AsyncResult<T, E>[]): AsyncResult<T[], E> {
  const results = await Promise.all(asyncResults);
  const values: T[] = [];

  for (const result of results) {
    if (isErr(result)) {
      return result;
    }
    values.push(result.value);
  }

  return ok(values);
}

/** Collect array of AsyncResults, filtering out Errs */
export async function allSettledAsync<T, E>(asyncResults: AsyncResult<T, E>[]): AsyncResult<T[], never> {
  const results = await Promise.all(asyncResults);
  const values: T[] = [];

  for (const result of results) {
    if (isOk(result)) {
      values.push(result.value);
    }
  }

  return ok(values);
}

/** Return first Ok or all Errs */
export async function anyAsync<T, E>(asyncResults: AsyncResult<T, E>[]): AsyncResult<T, E[]> {
  const results = await Promise.all(asyncResults);
  const errors: E[] = [];

  for (const result of results) {
    if (isOk(result)) {
      return result;
    }
    errors.push(result.error);
  }

  return err(errors);
}

/** Race multiple AsyncResults - first to resolve wins */
export function raceAsync<T, E>(asyncResults: AsyncResult<T, E>[]): AsyncResult<T, E> {
  return Promise.race(asyncResults);
}

/** Sequential execution of AsyncResult-returning functions */
export async function sequenceAsync<T, E>(fns: Array<() => AsyncResult<T, E>>): AsyncResult<T[], E> {
  const values: T[] = [];

  for (const fn of fns) {
    const result = await fn();
    if (isErr(result)) {
      return result;
    }
    values.push(result.value);
  }

  return ok(values);
}

/** Parallel execution with concurrency limit */
export async function parallelAsync<T, E>(
  tasks: Array<() => AsyncResult<T, E>>,
  limit: number = Infinity,
): AsyncResult<T[], E> {
  const results: T[] = [];
  const executing: Set<Promise<void>> = new Set();

  for (const task of tasks) {
    const promise = task().then(async (result) => {
      if (isErr(result)) {
        throw result;
      }
      results.push(result.value);
    });

    executing.add(promise);
    promise.finally(() => executing.delete(promise));

    if (executing.size >= limit) {
      try {
        await Promise.race(executing);
      } catch (error) {
        // Wait for all executing tasks to finish before returning error
        await Promise.allSettled(executing);
        return error as Err<E>;
      }
    }
  }

  try {
    await Promise.all(executing);
    return ok(results);
  } catch (error) {
    return error as Err<E>;
  }
}

/** Retry an AsyncResult-returning function with exponential backoff using Clock */
export async function retryAsync<T, E>(
  fn: () => AsyncResult<T, E>,
  clock: Clock,
  options: {
    maxAttempts?: number;
    baseDelayMs?: Millis;
    maxDelayMs?: Millis;
    backoffFactor?: number;
    shouldRetry?: (error: E, attempt: number) => boolean;
  } = {},
): AsyncResult<T, E> {
  const {
    maxAttempts = 3,
    baseDelayMs = 100 as Millis,
    maxDelayMs = 10000 as Millis,
    backoffFactor = 2,
    shouldRetry = () => true,
  } = options;

  let lastResult = await fn();

  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    if (isOk(lastResult)) {
      return lastResult;
    }

    if (!shouldRetry(lastResult.error, attempt)) {
      break;
    }

    const delay = Math.min(baseDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs) as Millis;
    await clock.timeout(delay);

    lastResult = await fn();
  }

  return lastResult;
}

/** Timeout an AsyncResult using Clock */
export function timeoutAsync<T, E>(
  asyncResult: AsyncResult<T, E>,
  ms: Millis,
  timeoutError: E,
  clock: Clock,
): AsyncResult<T, E> {
  return Promise.race([asyncResult, clock.timeout(ms).then(() => err(timeoutError))]);
}

/** Convert AsyncResult to Promise (escape hatch - use sparingly) */
export async function toPromise<T, E>(asyncResult: AsyncResult<T, E>): Promise<T> {
  const result = await asyncResult;
  if (isOk(result)) {
    return result.value;
  }
  throw result.error;
}

/** Tap into AsyncResult value without changing it (for side effects) */
export function tapAsync<T, E>(
  asyncResult: AsyncResult<T, E>,
  fn: (value: T) => void | Promise<void>,
): AsyncResult<T, E> {
  return asyncResult.then(async (result) => {
    if (isOk(result)) {
      await fn(result.value);
    }
    return result;
  });
}

/** Tap into AsyncResult error without changing it (for side effects) */
export function tapErrAsync<T, E>(
  asyncResult: AsyncResult<T, E>,
  fn: (error: E) => void | Promise<void>,
): AsyncResult<T, E> {
  return asyncResult.then(async (result) => {
    if (isErr(result)) {
      await fn(result.error);
    }
    return result;
  });
}

/** Filter AsyncResult values */
export function filterAsync<T, E>(
  asyncResult: AsyncResult<T, E>,
  predicate: (value: T) => boolean | Promise<boolean>,
  error: E,
): AsyncResult<T, E> {
  return asyncResult.then(async (result) => {
    if (isOk(result)) {
      const passes = await predicate(result.value);
      return passes ? result : err(error);
    }
    return result;
  });
}

/** Bifunctor map for AsyncResult - transform both sides */
export function bimapAsync<T, U, E, F>(
  asyncResult: AsyncResult<T, E>,
  onOk: (value: T) => U | Promise<U>,
  onErr: (error: E) => F | Promise<F>,
): AsyncResult<U, F> {
  return asyncResult.then(async (result) => {
    if (isOk(result)) {
      return ok(await onOk(result.value));
    }
    return err(await onErr(result.error));
  });
}

/** Recover from error by providing a default value */
export function recoverAsync<T, E>(
  asyncResult: AsyncResult<T, E>,
  defaultValue: T | ((error: E) => T | Promise<T>),
): AsyncResult<T, never> {
  return asyncResult.then(async (result) => {
    if (isOk(result)) {
      return result;
    }
    const value =
      typeof defaultValue === "function"
        ? await (defaultValue as (error: E) => T | Promise<T>)(result.error)
        : defaultValue;
    return ok(value);
  });
}

/** Create AsyncResult from a callback-style function */
export function fromCallback<T, E = Error>(
  fn: (callback: (error: E | null, result?: T) => void) => void,
): AsyncResult<T, E> {
  return new Promise((resolve) => {
    fn((error, result) => {
      if (error) {
        resolve(err(error));
      } else {
        resolve(ok(result as T));
      }
    });
  });
}

/** Wrap an async function to return AsyncResult instead of throwing */
export function wrapAsync<A extends unknown[], T, E = Error>(
  fn: (...args: A) => Promise<T>,
  onError?: (error: unknown) => E,
): (...args: A) => AsyncResult<T, E> {
  return async (...args: A) => {
    try {
      const result = await fn(...args);
      return ok(result);
    } catch (error) {
      return err(onError ? onError(error) : (error as E));
    }
  };
}

/**
 * Result type for handling success and failure cases without exceptions.
 * This is a discriminated union with phantom types for better type inference.
 */

/** Success case of Result */
export interface Ok<T> {
  readonly _tag: "Ok";
  readonly value: T;
}

/** Failure case of Result */
export interface Err<E> {
  readonly _tag: "Err";
  readonly error: E;
}

/** Result type - Either success (Ok) or failure (Err) */
export type Result<T, E = Error> = Ok<T> | Err<E>;

/** Type guard for Ok */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result._tag === "Ok";
}

/** Type guard for Err */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result._tag === "Err";
}

/** Constructors */
export function ok<T>(value: T): Ok<T> {
  return { _tag: "Ok", value };
}

export function err<E>(error: E): Err<E> {
  return { _tag: "Err", error };
}

/** Extract value or throw (escape hatch - use sparingly) */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) return result.value;
  throw new Error(`Called unwrap on an Err: ${String(result.error)}`);
}

/** Extract error or throw (escape hatch - use sparingly) */
export function unwrapErr<T, E>(result: Result<T, E>): E {
  if (isErr(result)) return result.error;
  throw new Error("Called unwrapErr on an Ok");
}

/** Extract value or provide default */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return isOk(result) ? result.value : defaultValue;
}

/** Extract value or compute default */
export function unwrapOrElse<T, E>(result: Result<T, E>, fn: (error: E) => T): T {
  return isOk(result) ? result.value : fn(result.error);
}

/** Transform the success value */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return isOk(result) ? ok(fn(result.value)) : result;
}

/** Transform the error value */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return isErr(result) ? err(fn(result.error)) : result;
}

/** Flat map (monadic bind) - chain operations that return Results */
export function flatMap<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return isOk(result) ? fn(result.value) : result;
}

/** Alias for flatMap */
export const andThen = flatMap;
export const chain = flatMap;

/** Provide alternative Result if this one is Err */
export function orElse<T, E, F>(result: Result<T, E>, fn: (error: E) => Result<T, F>): Result<T, F> {
  return isErr(result) ? fn(result.error) : result;
}

/** Pattern matching */
export function match<T, E, U>(
  result: Result<T, E>,
  patterns: {
    ok: (value: T) => U;
    err: (error: E) => U;
  },
): U {
  return isOk(result) ? patterns.ok(result.value) : patterns.err(result.error);
}

/** Combine two Results - both must be Ok */
export function and<T, U, E>(first: Result<T, E>, second: Result<U, E>): Result<U, E> {
  return isOk(first) ? second : first;
}

/** Return first Ok or last Err */
export function or<T, E>(first: Result<T, E>, second: Result<T, E>): Result<T, E> {
  return isOk(first) ? first : second;
}

/** Apply a function inside a Result to a value inside another Result */
export function ap<T, U, E>(fnResult: Result<(value: T) => U, E>, valueResult: Result<T, E>): Result<U, E> {
  return isOk(fnResult) && isOk(valueResult)
    ? ok(fnResult.value(valueResult.value))
    : isErr(fnResult)
      ? fnResult
      : (valueResult as Err<E>);
}

/** Collect array of Results into Result of array */
export function all<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (isErr(result)) return result;
    values.push(result.value);
  }
  return ok(values);
}

/** Collect array of Results, filtering out Errs */
export function allSettled<T, E>(results: Result<T, E>[]): Result<T[], never> {
  const values: T[] = [];
  for (const result of results) {
    if (isOk(result)) values.push(result.value);
  }
  return ok(values);
}

/** Return first Ok or all Errs */
export function any<T, E>(results: Result<T, E>[]): Result<T, E[]> {
  const errors: E[] = [];
  for (const result of results) {
    if (isOk(result)) return result;
    errors.push(result.error);
  }
  return err(errors);
}

/** Convert nullable value to Result */
export function fromNullable<T, E>(value: T | null | undefined, error: E): Result<T, E> {
  return value !== null && value !== undefined ? ok(value) : err(error);
}

/** Convert throwing function to Result */
export function tryCatch<T, E = Error>(fn: () => T, onError?: (e: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (e) {
    return err(onError ? onError(e) : (e as E));
  }
}

/** Convert Promise to Result */
export async function fromPromise<T, E = Error>(
  promise: Promise<T>,
  onError?: (e: unknown) => E,
): Promise<Result<T, E>> {
  try {
    const value = await promise;
    return ok(value);
  } catch (e) {
    return err(onError ? onError(e) : (e as E));
  }
}

/** Bifunctor map - transform both sides */
export function bimap<T, U, E, F>(result: Result<T, E>, onOk: (value: T) => U, onErr: (error: E) => F): Result<U, F> {
  return isOk(result) ? ok(onOk(result.value)) : err(onErr(result.error));
}

/** Tap into Ok value without changing it (for side effects) */
export function tap<T, E>(result: Result<T, E>, fn: (value: T) => void): Result<T, E> {
  if (isOk(result)) fn(result.value);
  return result;
}

/** Tap into Err value without changing it (for side effects) */
export function tapErr<T, E>(result: Result<T, E>, fn: (error: E) => void): Result<T, E> {
  if (isErr(result)) fn(result.error);
  return result;
}

/** Filter Ok values, converting filtered out values to Err */
export function filter<T, E>(result: Result<T, E>, predicate: (value: T) => boolean, error: E): Result<T, E> {
  return isOk(result) ? (predicate(result.value) ? result : err(error)) : result;
}

/** Swap Ok and Err */
export function swap<T, E>(result: Result<T, E>): Result<E, T> {
  return isOk(result) ? err(result.value) : ok(result.error);
}

/**
 * Convert a Result to a plain `T | undefined`. Err maps to `undefined`.
 *
 * Note: this does NOT return an `Option<T>`. For that, import `toResult`
 * from `@phyxiusjs/fp` and flip with `option.toResult` elsewhere, or
 * convert via `fromNullable(toUndefined(result))`.
 */
export function toUndefined<T, E>(result: Result<T, E>): T | undefined {
  return isOk(result) ? result.value : undefined;
}

/** Partition array of Results into [oks, errs] */
export function partition<T, E>(results: Result<T, E>[]): [T[], E[]] {
  const oks: T[] = [];
  const errs: E[] = [];
  for (const result of results) {
    if (isOk(result)) {
      oks.push(result.value);
    } else {
      errs.push(result.error);
    }
  }
  return [oks, errs];
}

/** Zip two Results into a Result of tuple */
export function zip<T, U, E>(first: Result<T, E>, second: Result<U, E>): Result<[T, U], E> {
  return isOk(first) && isOk(second) ? ok([first.value, second.value]) : isErr(first) ? first : (second as Err<E>);
}

/** Zip with custom combiner function */
export function zipWith<T, U, V, E>(first: Result<T, E>, second: Result<U, E>, fn: (a: T, b: U) => V): Result<V, E> {
  return isOk(first) && isOk(second) ? ok(fn(first.value, second.value)) : isErr(first) ? first : (second as Err<E>);
}

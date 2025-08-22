/**
 * Option type for handling nullable values without null checks.
 * Represents values that may or may not exist.
 */

import type { Result } from "./result.js";
import { ok, err } from "./result.js";

/** Value exists */
export interface Some<T> {
  readonly _tag: "Some";
  readonly value: T;
}

/** Value does not exist */
export interface None {
  readonly _tag: "None";
}

/** Option type - Either Some value or None */
export type Option<T> = Some<T> | None;

/** Singleton None instance */
const NONE: None = { _tag: "None" };

/** Type guard for Some */
export function isSome<T>(option: Option<T>): option is Some<T> {
  return option._tag === "Some";
}

/** Type guard for None */
export function isNone<T>(option: Option<T>): option is None {
  return option._tag === "None";
}

/** Constructors */
export function some<T>(value: T): Some<T> {
  return { _tag: "Some", value };
}

export function none(): None {
  return NONE;
}

/** Create Option from nullable value */
export function fromNullable<T>(value: T | null | undefined): Option<T> {
  return value !== null && value !== undefined ? some(value) : none();
}

/** Create Option from predicate */
export function fromPredicate<T>(value: T, predicate: (value: T) => boolean): Option<T> {
  return predicate(value) ? some(value) : none();
}

/** Extract value or throw (escape hatch - use sparingly) */
export function unwrap<T>(option: Option<T>): T {
  if (isSome(option)) return option.value;
  throw new Error("Called unwrap on None");
}

/** Extract value or provide default */
export function unwrapOr<T>(option: Option<T>, defaultValue: T): T {
  return isSome(option) ? option.value : defaultValue;
}

/** Extract value or compute default */
export function unwrapOrElse<T>(option: Option<T>, fn: () => T): T {
  return isSome(option) ? option.value : fn();
}

/** Transform the value if it exists */
export function map<T, U>(option: Option<T>, fn: (value: T) => U): Option<U> {
  return isSome(option) ? some(fn(option.value)) : none();
}

/** Flat map (monadic bind) - chain operations that return Options */
export function flatMap<T, U>(option: Option<T>, fn: (value: T) => Option<U>): Option<U> {
  return isSome(option) ? fn(option.value) : none();
}

/** Alias for flatMap */
export const andThen = flatMap;
export const chain = flatMap;

/** Provide alternative Option if this one is None */
export function orElse<T>(option: Option<T>, fn: () => Option<T>): Option<T> {
  return isSome(option) ? option : fn();
}

/** Pattern matching */
export function match<T, U>(
  option: Option<T>,
  patterns: {
    some: (value: T) => U;
    none: () => U;
  },
): U {
  return isSome(option) ? patterns.some(option.value) : patterns.none();
}

/** Combine two Options - both must be Some */
export function and<T, U>(first: Option<T>, second: Option<U>): Option<U> {
  return isSome(first) ? second : none();
}

/** Return first Some or second Option */
export function or<T>(first: Option<T>, second: Option<T>): Option<T> {
  return isSome(first) ? first : second;
}

/** Apply a function inside an Option to a value inside another Option */
export function ap<T, U>(fnOption: Option<(value: T) => U>, valueOption: Option<T>): Option<U> {
  return isSome(fnOption) && isSome(valueOption) ? some(fnOption.value(valueOption.value)) : none();
}

/** Filter Some values, converting filtered out values to None */
export function filter<T>(option: Option<T>, predicate: (value: T) => boolean): Option<T> {
  return isSome(option) && predicate(option.value) ? option : none();
}

/** Tap into Some value without changing it (for side effects) */
export function tap<T>(option: Option<T>, fn: (value: T) => void): Option<T> {
  if (isSome(option)) fn(option.value);
  return option;
}

/** Check if Option contains a specific value */
export function contains<T>(option: Option<T>, value: T): boolean {
  return isSome(option) && option.value === value;
}

/** Check if Option exists and satisfies predicate */
export function exists<T>(option: Option<T>, predicate: (value: T) => boolean): boolean {
  return isSome(option) && predicate(option.value);
}

/** Convert Option to Result */
export function toResult<T, E>(option: Option<T>, error: E): Result<T, E> {
  return isSome(option) ? ok(option.value) : err(error);
}

/** Convert Option to nullable value */
export function toNullable<T>(option: Option<T>): T | null {
  return isSome(option) ? option.value : null;
}

/** Convert Option to undefined */
export function toUndefined<T>(option: Option<T>): T | undefined {
  return isSome(option) ? option.value : undefined;
}

/** Convert Option to array (empty or single element) */
export function toArray<T>(option: Option<T>): T[] {
  return isSome(option) ? [option.value] : [];
}

/** Collect array of Options into Option of array (all must be Some) */
export function all<T>(options: Option<T>[]): Option<T[]> {
  const values: T[] = [];
  for (const option of options) {
    if (isNone(option)) return none();
    values.push(option.value);
  }
  return some(values);
}

/** Collect array of Options, filtering out Nones */
export function compact<T>(options: Option<T>[]): T[] {
  const values: T[] = [];
  for (const option of options) {
    if (isSome(option)) values.push(option.value);
  }
  return values;
}

/** Return first Some or None */
export function any<T>(options: Option<T>[]): Option<T> {
  for (const option of options) {
    if (isSome(option)) return option;
  }
  return none();
}

/** Partition array of Options into [somes, nones] */
export function partition<T>(options: Option<T>[]): [T[], None[]] {
  const somes: T[] = [];
  const nones: None[] = [];
  for (const option of options) {
    if (isSome(option)) {
      somes.push(option.value);
    } else {
      nones.push(option);
    }
  }
  return [somes, nones];
}

/** Zip two Options into an Option of tuple */
export function zip<T, U>(first: Option<T>, second: Option<U>): Option<[T, U]> {
  return isSome(first) && isSome(second) ? some([first.value, second.value]) : none();
}

/** Zip with custom combiner function */
export function zipWith<T, U, V>(first: Option<T>, second: Option<U>, fn: (a: T, b: U) => V): Option<V> {
  return isSome(first) && isSome(second) ? some(fn(first.value, second.value)) : none();
}

/** Flatten nested Option */
export function flatten<T>(option: Option<Option<T>>): Option<T> {
  return isSome(option) ? option.value : none();
}

/** Get value or lazy error (useful for chaining) */
export function getOrElseThrow<T>(option: Option<T>, error: () => Error): T {
  if (isSome(option)) return option.value;
  throw error();
}

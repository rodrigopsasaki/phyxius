/**
 * @phyxius/fp - Functional programming primitives for exception-free, composable code
 *
 * Core principles:
 * - No exceptions: Everything returns Result or Option types
 * - Explicit error handling: Errors are values, not side effects
 * - Composable: All utilities work together seamlessly
 * - Type-safe: Full TypeScript support with no `any` types
 * - Predictable: Pure functions with no hidden state
 */

// Result type and operations
export type { Result, Ok, Err } from "./result.js";
export {
  // Type guards
  isOk,
  isErr,
  // Constructors
  ok,
  err,
  // Extractors
  unwrap,
  unwrapErr,
  unwrapOr,
  unwrapOrElse,
  // Transformers
  map,
  mapErr,
  flatMap,
  andThen,
  chain,
  orElse,
  // Pattern matching
  match,
  // Combinators
  and,
  or,
  ap,
  // Collections
  all,
  allSettled,
  any,
  partition,
  // Conversions
  fromNullable,
  tryCatch,
  fromPromise,
  toOption,
  // Advanced
  bimap,
  tap,
  tapErr,
  filter,
  swap,
  zip,
  zipWith,
} from "./result.js";

// Option type and operations
export type { Option, Some, None } from "./option.js";
export {
  // Type guards
  isSome,
  isNone,
  // Constructors
  some,
  none,
  // Conversions
  fromNullable as optionFromNullable,
  fromPredicate,
  toResult,
  toNullable,
  toUndefined,
  toArray,
  // Extractors
  unwrap as unwrapOption,
  unwrapOr as unwrapOptionOr,
  unwrapOrElse as unwrapOptionOrElse,
  // Transformers
  map as mapOption,
  flatMap as flatMapOption,
  andThen as andThenOption,
  chain as chainOption,
  orElse as orElseOption,
  // Pattern matching
  match as matchOption,
  // Combinators
  and as andOption,
  or as orOption,
  ap as apOption,
  // Collections
  all as allOptions,
  compact,
  any as anyOption,
  partition as partitionOptions,
  // Utilities
  filter as filterOption,
  tap as tapOption,
  contains,
  exists,
  flatten,
  getOrElseThrow,
  zip as zipOptions,
  zipWith as zipOptionsWith,
} from "./option.js";

// Pattern matching utilities
export type { Pattern, ValuePattern, GuardPattern, DefaultPattern, MatchPattern } from "./match.js";
export {
  Matcher,
  NumberMatcher,
  StringMatcher,
  match as createMatcher,
  matchValue,
  matchTag,
  matchPartial,
  matchBool,
  matchNullable,
  matchNumber,
  matchString,
  exhaustive,
} from "./match.js";

// Pipe and compose functions
export { pipe, flow, compose, pipeAsync, flowAsync, identity, constant, tap as tapPipe, tapAsync } from "./pipe.js";

// Functional combinators
export {
  // Currying
  curry2,
  curry3,
  curry4,
  uncurry2,
  uncurry3,
  uncurry4,
  // Partial application
  partial,
  partial2,
  partial3,
  partialRight,
  partialRight2,
  // Function manipulation
  flip,
  memoize,
  memoizeWith,
  once,
  lazy,
  // Iteration
  times,
  repeat,
  until,
  whilst,
  // Combinators
  converge,
  fork,
  join,
  composeK,
  either,
  both,
  all as allFns,
  any as anyFn,
} from "./combinators.js";

// Validation combinators
export type { ValidationError, ValidationResult, Validator, PredicateValidator } from "./validation.js";
export {
  validator,
  combine,
  sequence,
  when,
  unless,
  mapErrors,
  withField,
  withCode,
  string,
  number,
  array,
  object,
  ValidatorBuilder,
  builder,
} from "./validation.js";

// Async Result utilities
export type { AsyncResult } from "./async-result.js";
export {
  mapAsync,
  mapErrAsync,
  flatMapAsync,
  andThenAsync,
  chainAsync,
  orElseAsync,
  matchAsync,
  allAsync,
  allSettledAsync,
  anyAsync,
  raceAsync,
  sequenceAsync,
  parallelAsync,
  retryAsync,
  timeoutAsync,
  toPromise,
  tapAsync as tapAsyncResult,
  tapErrAsync,
  filterAsync,
  bimapAsync,
  recoverAsync,
  fromCallback,
  wrapAsync,
} from "./async-result.js";

// Array utilities
export { head, last, at, tail, isNonEmpty, isEmpty } from "./array.js";

/**
 * Re-export common patterns for convenience
 */

// Import specific functions for re-export
import {
  ok as resultOk,
  err as resultErr,
  fromNullable as resultFromNullable,
  tryCatch as resultTryCatch,
} from "./result.js";
import { some as optionSome, none as optionNone, fromNullable as optionFromNullableImpl } from "./option.js";
import {
  string as stringValidators,
  number as numberValidators,
  array as arrayValidators,
  object as objectValidators,
} from "./validation.js";

// Common Result patterns
export const ResultOk = resultOk;
export const ResultErr = resultErr;
export const ResultFromNullable = resultFromNullable;
export const ResultTryCatch = resultTryCatch;

// Common Option patterns
export const OptionSome = optionSome;
export const OptionNone = optionNone;
export const OptionFromNullable = optionFromNullableImpl;

// Common validators
export const validators = {
  string: stringValidators,
  number: numberValidators,
  array: arrayValidators,
  object: objectValidators,
} as const;

/**
 * Type utilities for better inference
 */

// Import types for utility type definitions
import type { Result } from "./result.js";
import type { Option } from "./option.js";
import type { AsyncResult } from "./async-result.js";

/** Extract the Ok type from a Result */
export type OkType<T> = T extends Result<infer U, unknown> ? U : never;

/** Extract the Err type from a Result */
export type ErrType<T> = T extends Result<unknown, infer E> ? E : never;

/** Extract the Some type from an Option */
export type SomeType<T> = T extends Option<infer U> ? U : never;

/** Make a Result type from value and error types */
export type MakeResult<T, E = Error> = Result<T, E>;

/** Make an Option type from value type */
export type MakeOption<T> = Option<T>;

/** Make an AsyncResult type from value and error types */
export type MakeAsyncResult<T, E = Error> = AsyncResult<T, E>;

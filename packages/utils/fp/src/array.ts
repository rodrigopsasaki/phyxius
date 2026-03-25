/**
 * Array utilities for functional programming.
 * Pure functions for array manipulation without mutation.
 */

import type { Option } from "./option.js";
import { some, none } from "./option.js";

/**
 * Get the first element of an array wrapped in Option.
 */
export function head<T>(arr: readonly T[]): Option<T> {
  if (!arr || arr.length === 0) {
    return none();
  }

  const first = arr[0];
  if (first === undefined) {
    return none();
  }

  return some(first);
}

/**
 * Get the last element of an array wrapped in Option.
 */
export function last<T>(arr: readonly T[]): Option<T> {
  if (!arr || arr.length === 0) {
    return none();
  }

  const item = arr[arr.length - 1];
  if (item === undefined) {
    return none();
  }

  return some(item);
}

/**
 * Get an element at a specific index wrapped in Option.
 */
export function at<T>(arr: readonly T[], index: number): Option<T> {
  if (!arr || index < 0 || index >= arr.length) {
    return none();
  }

  const item = arr[index];
  if (item === undefined) {
    return none();
  }

  return some(item);
}

/**
 * Get all elements except the first wrapped in Option.
 */
export function tail<T>(arr: readonly T[]): Option<readonly T[]> {
  if (!arr || arr.length === 0) {
    return none();
  }
  return some(arr.slice(1));
}

/**
 * Check if an array is non-empty.
 */
export function isNonEmpty<T>(arr: readonly T[]): arr is readonly [T, ...T[]] {
  return arr && arr.length > 0;
}

/**
 * Check if an array is empty.
 */
export function isEmpty<T>(arr: readonly T[]): boolean {
  return !arr || arr.length === 0;
}

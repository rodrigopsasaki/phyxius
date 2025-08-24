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
  return some(arr[0]!);
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

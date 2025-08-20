// Core functions
import { getContext, contextSet, contextGet, contextPush, contextMerge, contextScope } from "./core/context.js";
import { getCurrentContext } from "./core/global.js";

// Type exports
export type { PhyxiusContext } from "./core/types.js";

/**
 * The main Context API object that provides AsyncLocalStorage-based data storage.
 *
 * Context is a simple data bag that automatically flows through async operations
 * without manual parameter passing.
 *
 * @example
 * ```typescript
 * import { context } from "@phyxiusjs/context";
 *
 * // Create a context scope and use data operations
 * await context.scope(async () => {
 *   context.set("user_id", "user123");
 *   const userId = context.get("user_id");
 * });
 * ```
 */
export const context = {
  /**
   * Gets the current active context (from AsyncLocalStorage).
   *
   * @returns The current context or undefined if none is active
   */
  current: getCurrentContext,

  /**
   * Gets the current active context, throwing if none exists.
   *
   * @returns The current context
   * @throws {Error} If no active context is available
   */
  require: getContext,

  /**
   * Sets a key-value pair in the current context.
   *
   * @param key - The key to set
   * @param value - The value to store
   *
   * @example
   * ```typescript
   * context.set("user_id", "user123");
   * context.set("request_count", 42);
   * ```
   */
  set: contextSet,

  /**
   * Retrieves a value from the current context.
   *
   * @param key - The key to retrieve
   * @returns The stored value or undefined if not found
   *
   * @example
   * ```typescript
   * const userId = context.get("user_id");
   * const count = context.get("request_count");
   * ```
   */
  get: contextGet,

  /**
   * Pushes a value to an array in the current context.
   *
   * If the key doesn't exist, an empty array is created first.
   *
   * @param key - The key for the array
   * @param value - The value to push
   *
   * @example
   * ```typescript
   * context.push("events", "user_logged_in");
   * context.push("events", "order_created");
   * // Results in: ["user_logged_in", "order_created"]
   * ```
   */
  push: contextPush,

  /**
   * Merges an object into an existing object in the current context.
   *
   * If the key doesn't exist, an empty object is created first.
   *
   * @param key - The key for the object
   * @param value - The object to merge
   *
   * @example
   * ```typescript
   * context.merge("metadata", { version: "1.0.0" });
   * context.merge("metadata", { region: "us-east-1" });
   * // Results in: { version: "1.0.0", region: "us-east-1" }
   * ```
   */
  merge: contextMerge,

  /**
   * Creates a new context scope and executes a callback within it.
   *
   * Creates a new context that inherits from the parent context (if any)
   * and executes the callback within that scope.
   *
   * @param callback - The function to execute within the new context scope
   * @param initialData - Optional initial data for the new context
   * @returns The result of the callback function
   *
   * @example
   * ```typescript
   * const result = await context.scope(async () => {
   *   context.set("user_id", "user123");
   *   return "completed";
   * }, { service: "api" });
   * ```
   */
  scope: contextScope,
};

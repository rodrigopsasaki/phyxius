// Core functions
import { observe } from "./core/observe.js";
import { getContext, contextSet, contextGet, contextPush, contextMerge, getContextAncestry } from "./core/context.js";
import { setGlobalContext, getGlobalContext, getCurrentContext } from "./core/global.js";

// Type exports
export type { PhyxiusContext, ContextInitOptions, GlobalContextOptions } from "./core/types.js";

/**
 * The main Context API object that provides scoped execution with clock integration.
 *
 * Context replaces manual parameter passing with scoped execution that automatically
 * provides access to time operations and structured data storage.
 *
 * @example
 * ```typescript
 * import { context } from "@phyxius/context";
 * import { createSystemClock } from "@phyxius/clock";
 *
 * // Set up global context with clock
 * context.global({
 *   name: "app.global",
 *   clock: createSystemClock()
 * });
 *
 * // Basic usage
 * await context.observe("my.workflow", async () => {
 *   context.set("user_id", "user123");
 *   context.set("status", "processing");
 *
 *   // Access clock for time operations
 *   const ctx = context.current();
 *   await ctx.clock.sleep(100);
 * });
 * ```
 */
export const context = {
  /**
   * Creates a new context and executes the callback within it.
   *
   * This is the primary method for creating scoped execution contexts.
   * The context automatically inherits from any parent context and
   * provides access to a clock for time operations.
   *
   * @param options - Context configuration (name string or full options object)
   * @param callback - Async function to execute within the context
   * @returns Promise that resolves to the callback result
   */
  observe,

  /**
   * Sets up a global context that serves as the root for all other contexts.
   *
   * This is typically called once during application initialization to
   * provide default values (especially the clock) for all contexts.
   *
   * @param options - Global context configuration
   * @returns The created global context
   *
   * @example
   * ```typescript
   * context.global({
   *   name: "app.global",
   *   clock: createSystemClock(),
   *   initial: { service: "api", version: "1.0" }
   * });
   * ```
   */
  global: setGlobalContext,

  /**
   * Gets the current active context (from AsyncLocalStorage or global).
   *
   * @returns The current context or undefined if none is active
   *
   * @example
   * ```typescript
   * const ctx = context.current();
   * if (ctx) {
   *   console.log("Current context:", ctx.name);
   *   console.log("Context clock:", ctx.clock);
   * }
   * ```
   */
  current: getCurrentContext,

  /**
   * Gets the global context.
   *
   * @returns The global context or undefined if not set
   */
  globalContext: getGlobalContext,

  /**
   * Gets the current active context, throwing if none exists.
   *
   * @returns The current context
   * @throws {Error} If no active context is available
   *
   * @example
   * ```typescript
   * await context.observe("operation", async () => {
   *   const ctx = context.require();
   *   console.log("Context ID:", ctx.id);
   *   console.log("Context name:", ctx.name);
   * });
   * ```
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
   * Gets the ancestry chain of the current context.
   *
   * @returns Array of context IDs representing the ancestry
   *
   * @example
   * ```typescript
   * const ancestry = context.ancestry();
   * console.log("Context chain:", ancestry);
   * ```
   */
  ancestry: getContextAncestry,
};

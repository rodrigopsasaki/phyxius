import { requireCurrentContext, getContextStore, getCurrentContext } from "./global.js";
import type { PhyxiusContext } from "./types.js";
import { generateId } from "../utils/generateId.js";

/**
 * Retrieves the current active context.
 *
 * This function returns the context that is currently active in the
 * async execution scope.
 *
 * @returns The current active context
 * @throws {Error} If called outside of a context scope
 *
 * @example
 * ```typescript
 * const ctx = getContext();
 * console.log("Context ID:", ctx.id);
 * ```
 */
export function getContext(): PhyxiusContext {
  return requireCurrentContext();
}

/**
 * Sets a key-value pair on the current context's data map.
 *
 * @param key - The key to store the value under
 * @param value - The value to store (can be any type)
 *
 * @example
 * ```typescript
 * contextSet("user_id", "user123");
 * contextSet("login_method", "oauth");
 * ```
 */
export function contextSet<K extends string, V = unknown>(key: K, value: V): void {
  const context = requireCurrentContext();
  context.data.set(key, value);
}

/**
 * Retrieves a value from the current context's data map.
 *
 * @param key - The key to retrieve
 * @returns The stored value or undefined if not found
 *
 * @example
 * ```typescript
 * contextSet("order_id", "order123");
 * const orderId = contextGet("order_id"); // "order123"
 * const missing = contextGet("nonexistent"); // undefined
 * ```
 */
export function contextGet<T = unknown>(key: string): T | undefined {
  const context = requireCurrentContext();
  return context.data.get(key) as T | undefined;
}

/**
 * Pushes a value into an array stored at the given key in the context's data map.
 *
 * If the key doesn't exist yet, an empty array is created first.
 *
 * @param key - The key for the array
 * @param value - The value to push to the array
 *
 * @example
 * ```typescript
 * contextPush("events", "order_created");
 * contextPush("events", "payment_processed");
 * // Results in: ["order_created", "payment_processed"]
 * ```
 */
export function contextPush<T = unknown>(key: string, value: T): void {
  const context = requireCurrentContext();
  const list = (context.data.get(key) as T[] | undefined) ?? [];
  list.push(value);
  context.data.set(key, list);
}

/**
 * Merges a record into the existing object at the given key in the context's data map.
 *
 * If the key doesn't exist yet, an empty object is created first.
 *
 * @param key - The key for the object
 * @param value - The object to merge into the existing object
 *
 * @example
 * ```typescript
 * contextMerge("request", { method: "POST", path: "/users" });
 * contextMerge("request", { headers: { "content-type": "application/json" } });
 * // Results in: { method: "POST", path: "/users", headers: {...} }
 * ```
 */
export function contextMerge<K extends string, V = unknown>(key: K, value: Record<string, V>): void {
  const context = requireCurrentContext();
  const existing = (context.data.get(key) as Record<string, V> | undefined) ?? {};
  context.data.set(key, { ...existing, ...value });
}

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
 * const result = await contextScope(async () => {
 *   context.set("user_id", "user123");
 *   return "completed";
 * }, { initial: "data" });
 * ```
 */
export async function contextScope<T>(
  callback: () => Promise<T> | T,
  initialData?: Record<string, unknown>,
): Promise<T> {
  const parentContext = getCurrentContext();

  // Create new context with inherited data
  const newContext: PhyxiusContext = {
    id: generateId(),
    data: createContextData(parentContext, initialData ?? {}),
  };

  const store = getContextStore();
  return store.run(newContext, callback);
}

/**
 * Creates the data map for a new context, handling inheritance from parent.
 */
function createContextData(
  parentContext: PhyxiusContext | undefined,
  initialData: Record<string, unknown>,
): Map<string, unknown> {
  // Start with parent data if available
  const data = parentContext ? new Map(parentContext.data) : new Map();

  // Add initial data, potentially overriding inherited values
  for (const [key, value] of Object.entries(initialData)) {
    data.set(key, value);
  }

  return data;
}

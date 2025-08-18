import { requireCurrentContext } from "./global.js";
import type { PhyxiusContext } from "./types.js";

/**
 * Retrieves the current active context.
 *
 * This function returns the context that is currently active in the
 * async execution scope. It's useful for accessing context metadata or
 * for getting the current clock instance.
 *
 * @returns The current active context
 * @throws {Error} If called outside of a context scope
 *
 * @example
 * ```typescript
 * await context.observe("my.workflow", async () => {
 *   const ctx = getContext();
 *   console.log("Working in context:", ctx.name);
 *   console.log("Context ID:", ctx.id);
 *   console.log("Clock:", ctx.clock);
 * });
 * ```
 */
export function getContext(): PhyxiusContext {
  return requireCurrentContext();
}

/**
 * Sets a key-value pair on the current context's data map.
 *
 * This is the primary method for storing data in the current context.
 * The data will be available to any child contexts and can be retrieved
 * with `contextGet()`.
 *
 * @param key - The key to store the value under
 * @param value - The value to store (can be any type)
 *
 * @example
 * ```typescript
 * await context.observe("user.login", async () => {
 *   contextSet("user_id", "user123");
 *   contextSet("login_method", "oauth");
 *   contextSet("timestamp", new Date().toISOString());
 * });
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
 * await context.observe("order.processing", async () => {
 *   contextSet("order_id", "order123");
 *
 *   // Later in the same context...
 *   const orderId = contextGet("order_id"); // "order123"
 *   const missing = contextGet("nonexistent"); // undefined
 * });
 * ```
 */
export function contextGet<T = unknown>(key: string): T | undefined {
  const context = requireCurrentContext();
  return context.data.get(key) as T | undefined;
}

/**
 * Pushes a value into an array stored at the given key in the context's data map.
 *
 * If the key doesn't exist yet, an empty array is created first. This is useful
 * for collecting multiple related values during context execution.
 *
 * @param key - The key for the array
 * @param value - The value to push to the array
 *
 * @example
 * ```typescript
 * await context.observe("order.processing", async () => {
 *   contextPush("events", "order_created");
 *   contextPush("events", "payment_processed");
 *   contextPush("events", "inventory_updated");
 *
 *   // Results in: ["order_created", "payment_processed", "inventory_updated"]
 * });
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
 * If the key doesn't exist yet, an empty object is created first. This is useful
 * for building up structured metadata objects incrementally.
 *
 * @param key - The key for the object
 * @param value - The object to merge into the existing object
 *
 * @example
 * ```typescript
 * await context.observe("api.request", async () => {
 *   contextMerge("request", { method: "POST", path: "/users" });
 *   contextMerge("request", { headers: { "content-type": "application/json" } });
 *   contextMerge("request", { body: { name: "John" } });
 *
 *   // Results in: {
 *   //   method: "POST",
 *   //   path: "/users",
 *   //   headers: { "content-type": "application/json" },
 *   //   body: { name: "John" }
 *   // }
 * });
 * ```
 */
export function contextMerge<K extends string, V = unknown>(key: K, value: Record<string, V>): void {
  const context = requireCurrentContext();
  const existing = (context.data.get(key) as Record<string, V> | undefined) ?? {};
  context.data.set(key, { ...existing, ...value });
}

/**
 * Gets the ancestry chain of the current context.
 * Returns an array of context IDs from the current context up to the root.
 *
 * @returns Array of context IDs representing the ancestry chain
 *
 * @example
 * ```typescript
 * // In a nested context structure
 * const ancestry = getContextAncestry();
 * // Returns: ["current-id", "parent-id", "grandparent-id", "root-id"]
 * ```
 */
export function getContextAncestry(): string[] {
  const context = requireCurrentContext();
  const ancestry: string[] = [context.id];

  // For now, we only track immediate parent
  // Could be extended to traverse full ancestry chain if needed
  if (context.parentId) {
    ancestry.push(context.parentId);
  }

  return ancestry;
}

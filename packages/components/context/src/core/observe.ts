import { generateId } from "../utils/generateId.js";
import { getContextStore, getCurrentContext } from "./global.js";
import type { PhyxiusContext, ContextInitOptions } from "./types.js";

/**
 * Creates a new context and executes the provided callback within it.
 *
 * This is the primary function for scoped execution in phyxius. It creates
 * a new context that automatically inherits from the parent context (if any)
 * and provides access to a clock for time operations.
 *
 * @param options - Either a string (context name) or a full options object
 * @param callback - The async function to execute within the context
 * @returns The result of the callback function
 *
 * @example
 * ```typescript
 * // Simple usage with just a name
 * await observe("user.login", async () => {
 *   context.set("user_id", "user123");
 *   // Clock is available via context.current().clock
 * });
 *
 * // Advanced usage with full options
 * await observe({
 *   name: "order.processing",
 *   scope: "http",
 *   source: "api-gateway",
 *   clock: virtualClock,
 *   initial: { request_id: "req-123" }
 * }, async () => {
 *   context.set("order_id", "order456");
 *   // Use the provided virtual clock for testing
 * });
 * ```
 */
export async function observe<T>(options: string | ContextInitOptions, callback: () => Promise<T>): Promise<T> {
  const opts: ContextInitOptions = typeof options === "string" ? { name: options } : options;

  const parentContext = getCurrentContext();

  // Create the new context
  const newContext: PhyxiusContext = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    name: opts.name,
    ...(opts.scope && { scope: opts.scope }),
    ...(opts.source && { source: opts.source }),

    // Clock inheritance: use provided clock, or inherit from parent, or fail if none available
    clock:
      opts.clock ||
      parentContext?.clock ||
      (() => {
        throw new Error(`No clock available for context "${opts.name}". Provide a clock or set a global context.`);
      })(),

    // Context hierarchy
    ...(parentContext?.id && { parentId: parentContext.id }),

    // Data inheritance (default: true)
    data: createContextData(parentContext, opts),
  };

  const store = getContextStore();

  return store.run(newContext, callback);
}

/**
 * Creates the data map for a new context, handling inheritance from parent.
 */
function createContextData(parentContext: PhyxiusContext | undefined, opts: ContextInitOptions): Map<string, unknown> {
  const initialData = opts.initial ?? {};

  // If inherit is explicitly false, start fresh
  if (opts.inherit === false || !parentContext) {
    return new Map(Object.entries(initialData));
  }

  // Default behavior: inherit from parent and add initial data
  const inheritedData = new Map(parentContext.data);

  // Add initial data, potentially overriding inherited values
  for (const [key, value] of Object.entries(initialData)) {
    inheritedData.set(key, value);
  }

  return inheritedData;
}

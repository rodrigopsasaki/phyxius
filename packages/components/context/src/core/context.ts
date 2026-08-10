import { getContextStore, getCurrentContext } from "./global.js";
import type { PhyxiusContext, ContextScopeOptions } from "./types.js";

/**
 * Retrieves the current active context.
 *
 * @returns The current active context
 * @throws {Error} If called outside of a context scope
 */
export function getContext<T = Record<string, unknown>>(): PhyxiusContext<T> {
  const context = getCurrentContext<T>();
  if (!context) {
    throw new Error("No active context available");
  }
  return context;
}

/**
 * Creates a new context scope and executes a callback within it.
 *
 * Creates a new context with typed data that can optionally inherit from
 * the parent context (if any) and executes the callback within that scope.
 *
 * @param callback - The function to execute within the new context scope
 * @param options - Options for creating the new context
 * @returns The result of the callback function
 *
 * @example
 * ```typescript
 * // Untyped context (default)
 * const result = await createContextScope(async () => {
 *   const ctx = getContext();
 *   console.log(ctx.data); // Record<string, unknown>
 *   return "completed";
 * }, { initial: { service: "api" } });
 *
 * // Typed context
 * interface UserSession {
 *   userId: string;
 *   permissions: string[];
 * }
 *
 * await createContextScope<UserSession>(async () => {
 *   const ctx = getContext<UserSession>();
 *   console.log(ctx.data.userId); // string (typed!)
 * }, { initial: { userId: "user123", permissions: ["read"] } });
 * ```
 */
export async function createContextScope<T = Record<string, unknown>, R = unknown>(
  callback: () => Promise<R> | R,
  options?: ContextScopeOptions<T>,
): Promise<R> {
  const parentContext = getCurrentContext<T>();
  const inherit = options?.inherit ?? true;

  // Create context data
  let data: T;
  if (inherit && parentContext && options?.initial) {
    // Merge parent data with initial data
    data = { ...parentContext.data, ...options.initial } as T;
  } else if (inherit && parentContext) {
    // Inherit parent data
    data = { ...parentContext.data } as T;
  } else if (options?.initial) {
    // Use only initial data
    data = options.initial;
  } else {
    // Empty context
    data = {} as T;
  }

  // Create new context
  const newContext: PhyxiusContext<T> = {
    data,
  };

  const store = getContextStore<T>();
  return store.run(newContext, callback);
}

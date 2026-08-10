// Core functions
import { getContext, createContextScope } from "./core/context.js";
import { getCurrentContext } from "./core/global.js";

// Type exports
export type { PhyxiusContext, ContextScopeOptions } from "./core/types.js";

/**
 * The main Context API - a pure AsyncLocalStorage primitive for typed scoped data.
 *
 * Context provides thread-local storage that automatically flows through async
 * operations without manual parameter passing. It supports full TypeScript typing
 * and has zero knowledge of domain concerns like correlation IDs or observability.
 *
 * @example
 * ```typescript
 * import { context } from "@phyxiusjs/context";
 *
 * // Simple untyped usage
 * await context.scope(async () => {
 *   const ctx = context.get();
 *   console.log(ctx.data); // Record<string, unknown>
 * }, { initial: { service: "api" } });
 *
 * // Typed usage for compile-time safety
 * interface UserSession {
 *   userId: string;
 *   permissions: string[];
 * }
 *
 * await context.scope<UserSession>(async () => {
 *   const ctx = context.get<UserSession>();
 *   console.log(ctx.data.userId); // string (typed!)
 * }, { initial: { userId: "user123", permissions: ["read"] } });
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
  get: getContext,

  /**
   * Creates a new context scope and executes a callback within it.
   *
   * The context can be fully typed for compile-time safety and supports
   * inheritance from parent contexts.
   *
   * @param callback - The function to execute within the new context scope
   * @param options - Options for creating the new context
   * @returns The result of the callback function
   */
  scope: createContextScope,
};

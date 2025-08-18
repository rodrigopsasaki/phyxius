import { AsyncLocalStorage } from "node:async_hooks";
import type { PhyxiusContext, ContextRuntimeState, GlobalContextOptions } from "./types.js";
import { generateId } from "../utils/generateId.js";

/**
 * Global key for context runtime state.
 * Using a string key ensures the same access across all versions of the context package,
 * allowing different versions to share the same global context state.
 */
const CONTEXT_RUNTIME_KEY = "__phyxius_context_runtime__";

/**
 * Type augmentation for the global runtime state.
 */
declare global {
  // biome-ignore lint/style/noVar: required for global state type
  var __phyxius_context_runtime__: ContextRuntimeState;
}

// Initialize the global runtime state if it doesn't exist
if (!globalThis[CONTEXT_RUNTIME_KEY]) {
  globalThis[CONTEXT_RUNTIME_KEY] = {};
}

/**
 * Gets the global context runtime state.
 * Creates it if it doesn't exist.
 */
function getRuntimeState(): ContextRuntimeState {
  return globalThis[CONTEXT_RUNTIME_KEY];
}

/**
 * Returns the global context AsyncLocalStorage instance, initializing it if needed.
 *
 * This function manages the global AsyncLocalStorage that maintains context
 * across async operations. It ensures thread-safe context isolation for
 * concurrent operations and works across different versions of the context package.
 *
 * @returns The AsyncLocalStorage instance for contexts
 */
export function getContextStore(): AsyncLocalStorage<PhyxiusContext> {
  const runtime = getRuntimeState();

  if (!runtime.contextStore) {
    runtime.contextStore = new AsyncLocalStorage<PhyxiusContext>();
  }

  return runtime.contextStore;
}

/**
 * Sets up a global context that serves as the root for all other contexts.
 *
 * This global context provides default values (especially the clock) that child
 * contexts can inherit from. It's particularly useful for setting up application-wide
 * defaults like the system clock for production or virtual clock for testing.
 *
 * @param options - Configuration for the global context
 *
 * @example
 * ```typescript
 * // In main.ts
 * setGlobalContext({
 *   name: "app.global",
 *   clock: createSystemClock(),
 *   initial: { service: "api-server", version: "1.0.0" }
 * });
 *
 * // In tests
 * setGlobalContext({
 *   name: "test.global",
 *   clock: createVirtualClock()
 * });
 * ```
 */
export function setGlobalContext(options: GlobalContextOptions): PhyxiusContext {
  const runtime = getRuntimeState();

  const globalContext: PhyxiusContext = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    name: options.name,
    ...(options.scope && { scope: options.scope }),
    ...(options.source && { source: options.source }),
    clock: options.clock,
    data: new Map(Object.entries(options.initial ?? {})),
  };

  runtime.globalContext = globalContext;
  return globalContext;
}

/**
 * Gets the current global context.
 * Returns undefined if no global context has been set.
 *
 * @returns The global context or undefined
 */
export function getGlobalContext(): PhyxiusContext | undefined {
  const runtime = getRuntimeState();
  return runtime.globalContext;
}

/**
 * Gets the current active context from AsyncLocalStorage or falls back to global context.
 * Returns undefined if no context is available.
 *
 * @returns The current context or undefined
 */
export function getCurrentContext(): PhyxiusContext | undefined {
  const store = getContextStore();
  return store.getStore() || getGlobalContext();
}

/**
 * Gets the current active context, throwing an error if none exists.
 *
 * @returns The current context
 * @throws {Error} If no active context is available
 */
export function requireCurrentContext(): PhyxiusContext {
  const context = getCurrentContext();
  if (!context) {
    throw new Error("No active context available");
  }
  return context;
}

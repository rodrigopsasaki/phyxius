import { AsyncLocalStorage } from "node:async_hooks";
import type { PhyxiusContext, ContextRuntimeState } from "./types.js";

/**
 * Global key for context runtime state.
 * Using a string key ensures the same access across all versions of the context package.
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
 */
function getRuntimeState<T = Record<string, unknown>>(): ContextRuntimeState<T> {
  return globalThis[CONTEXT_RUNTIME_KEY] as ContextRuntimeState<T>;
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
export function getContextStore<T = Record<string, unknown>>(): AsyncLocalStorage<PhyxiusContext<T>> {
  const runtime = getRuntimeState<T>();

  if (!runtime.contextStore) {
    runtime.contextStore = new AsyncLocalStorage<PhyxiusContext<T>>();
  }

  return runtime.contextStore;
}

/**
 * Gets the current active context from AsyncLocalStorage.
 * Returns undefined if no context is available.
 *
 * @returns The current context or undefined
 */
export function getCurrentContext<T = Record<string, unknown>>(): PhyxiusContext<T> | undefined {
  const store = getContextStore<T>();
  return store.getStore();
}

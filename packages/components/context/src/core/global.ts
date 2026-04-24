import { AsyncLocalStorage } from "node:async_hooks";
import type { PhyxiusContext, ContextRuntimeState } from "./types.js";

/**
 * Global registry key for the context runtime state.
 *
 * We use `Symbol.for` so that every copy of `@phyxiusjs/context` loaded into
 * the same process — even across version mismatches in `node_modules` — shares
 * the same `AsyncLocalStorage` instance. Without this, two copies of the package
 * would create two independent stores and context would silently fail to flow
 * across the boundary between them.
 *
 * `Symbol.for` is safer than a string key: it cannot collide with user-defined
 * globals and avoids polluting the global namespace at the type level.
 */
const RUNTIME_KEY = Symbol.for("phyxius.context.runtime");

type GlobalWithRuntime = typeof globalThis & {
  [RUNTIME_KEY]?: ContextRuntimeState;
};

function getRuntimeState<T = Record<string, unknown>>(): ContextRuntimeState<T> {
  const global = globalThis as GlobalWithRuntime;
  if (!global[RUNTIME_KEY]) {
    global[RUNTIME_KEY] = {};
  }
  return global[RUNTIME_KEY] as ContextRuntimeState<T>;
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

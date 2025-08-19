import type { AsyncLocalStorage } from "node:async_hooks";

/**
 * Represents a simple context data bag for storing key-value pairs.
 * Context is stored in AsyncLocalStorage and automatically flows through
 * async operations without manual parameter passing.
 */
export interface PhyxiusContext {
  /** Unique identifier for this context */
  id: string;

  /** Structured key-value data stored in this context */
  data: Map<string, unknown>;
}

/**
 * Internal runtime state for the context system.
 */
export interface ContextRuntimeState {
  /** AsyncLocalStorage instance for context isolation */
  contextStore?: AsyncLocalStorage<PhyxiusContext>;

  /** Global context that serves as the root */
  globalContext?: PhyxiusContext;

  /** Version for compatibility checking */
  version?: string;
}

import type { AsyncLocalStorage } from "node:async_hooks";

/**
 * Represents a typed context for storing data within an AsyncLocalStorage scope.
 *
 * Context is a pure primitive that provides thread-local storage without any
 * domain-specific concerns like correlation IDs, timestamps, or observability.
 * It simply manages typed data that flows through async operations automatically.
 */
export interface PhyxiusContext<T = Record<string, unknown>> {
  /** Typed data stored in this context */
  readonly data: T;
}

/**
 * Internal runtime state for the context system.
 */
export interface ContextRuntimeState<T = Record<string, unknown>> {
  /** AsyncLocalStorage instance for context isolation */
  contextStore?: AsyncLocalStorage<PhyxiusContext<T>>;
}

/**
 * Options for creating a new context scope.
 */
export interface ContextScopeOptions<T = Record<string, unknown>> {
  /** Initial data for the new context */
  initial?: T;

  /** Whether to inherit data from parent context (default: true) */
  inherit?: boolean;
}

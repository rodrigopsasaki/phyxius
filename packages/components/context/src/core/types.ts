import type { Clock } from "@phyxius/clock";
import type { AsyncLocalStorage } from "node:async_hooks";

/**
 * Represents a single scoped execution context in phyxius.
 * Each context is uniquely identified and holds structured metadata
 * with clock integration for deterministic time operations.
 */
export interface PhyxiusContext {
  /** Unique identifier for this context */
  id: string;

  /** ISO 8601 timestamp marking when the context was initialized */
  timestamp: string;

  /** Descriptive name of the context (e.g. 'payment.process') */
  name: string;

  /** Optional category or type (e.g. 'http', 'job', 'effect') */
  scope?: string;

  /** Optional string indicating the source of the context (e.g. service name) */
  source?: string;

  /** Clock instance for time operations within this context */
  clock: Clock;

  /** ID of the parent context if this is a child context */
  parentId?: string;

  /** Structured key-value data collected during context execution */
  data: Map<string, unknown>;
}

/**
 * Configuration object passed to `context.observe()`.
 * Used to initialize a context with optional metadata and clock.
 */
export interface ContextInitOptions {
  /** Descriptive name of the context */
  name: string;

  /** Optional category or type for grouping */
  scope?: string;

  /** Optional identifier for the source of the context */
  source?: string;

  /** Optional clock instance - inherits from parent/global if not provided */
  clock?: Clock;

  /** Optional key-value data to initialize the context with */
  initial?: Record<string, unknown>;

  /** Whether to inherit data from parent context (default: true) */
  inherit?: boolean;
}

/**
 * Configuration for setting up a global context.
 */
export interface GlobalContextOptions {
  /** Name for the global context */
  name: string;

  /** Clock instance to use globally */
  clock: Clock;

  /** Optional initial data for the global context */
  initial?: Record<string, unknown>;

  /** Optional scope for the global context */
  scope?: string;

  /** Optional source identifier */
  source?: string;
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

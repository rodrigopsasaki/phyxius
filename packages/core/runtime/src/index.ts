/**
 * @phyxiusjs/runtime - Execution environment for Phyxius service functions
 *
 * The runtime provides:
 * - Execution of service functions with policy enforcement
 * - Timeout handling
 * - Retry logic with backoff strategies
 * - Circuit breaker pattern
 * - Input/output validation
 * - Observability hooks
 */

// Types
export type {
  RuntimeConfig,
  RuntimeHooks,
  ExecutionStartEvent,
  ExecutionSuccessEvent,
  ExecutionErrorEvent,
  RetryEvent,
  CircuitState,
  CircuitStateChangeEvent,
  CircuitBreakerEntry,
  CircuitBreakerStore,
  ExecuteOptions,
  Runtime,
} from "./types.js";

// Runtime factory
export { createRuntime } from "./runtime.js";

// Circuit breaker utilities
export {
  createInMemoryCircuitBreakerStore,
  createCircuitBreaker,
  type CircuitBreaker,
} from "./circuit-breaker.js";

// Observe context utilities
export { createObserveContext } from "./observe.js";

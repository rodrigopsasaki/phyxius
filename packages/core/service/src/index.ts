/**
 * @phyxiusjs/service - Service function definitions with required failure policies
 *
 * Core principle: "You NEED to think about failure, whether you like it or not."
 *
 * Every service function must explicitly declare:
 * - Timeout behavior
 * - Retry behavior
 * - Circuit breaker behavior
 *
 * No defaults. Explicit choices only.
 */

// Types
export type {
  FunctionLayer,
  BackoffStrategy,
  RetryCondition,
  RetryPolicy,
  CircuitBreakerPolicy,
  FunctionPolicy,
  BaseContext,
  ObserveContext,
  ExecutionMetadata,
  DataContext,
  DomainContext,
  OrchestrationContext,
  LayerContext,
  ServiceHandler,
  ServiceFunctionDefinition,
  ServiceFunction,
  ServiceDefinition,
  ServiceObserveHooks,
  Service,
} from "./types.js";

// Errors
export { ServiceError } from "./errors.js";
export type { ServiceErrorCode } from "./errors.js";

// Policy utilities
export {
  validatePolicy,
  calculateRetryDelay,
  shouldRetry,
  retryPolicy,
  circuitBreakerPolicy,
  NO_RETRY,
  NO_TIMEOUT,
  NO_CIRCUIT_BREAKER,
} from "./policy.js";

// Function utilities
export {
  defineFunction,
  isServiceFunction,
  functionRef,
} from "./function.js";
export type {
  InferInput,
  InferOutput,
  InferLayer,
  FunctionRef,
} from "./function.js";

// Service utilities
export {
  defineService,
  isService,
  getFunctionNames,
} from "./service.js";
export type {
  ServiceFunctions,
  GetFunction,
} from "./service.js";

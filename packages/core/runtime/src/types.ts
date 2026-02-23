import type { Clock, Millis } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type {
  FunctionLayer,
  ServiceFunction,
  ServiceError,
  ObserveContext,
} from "@phyxiusjs/service";

/**
 * Configuration for creating a runtime
 */
export interface RuntimeConfig {
  /** Clock implementation to use */
  readonly clock: Clock;
  /** Optional hooks for observability */
  readonly hooks?: RuntimeHooks;
  /** Circuit breaker state store (defaults to in-memory) */
  readonly circuitBreakerStore?: CircuitBreakerStore;
}

/**
 * Hooks for runtime observability
 */
export interface RuntimeHooks {
  /** Called when execution starts */
  onStart?: (event: ExecutionStartEvent) => void;
  /** Called when execution succeeds */
  onSuccess?: (event: ExecutionSuccessEvent) => void;
  /** Called when execution fails */
  onError?: (event: ExecutionErrorEvent) => void;
  /** Called when a retry is attempted */
  onRetry?: (event: RetryEvent) => void;
  /** Called when circuit breaker state changes */
  onCircuitStateChange?: (event: CircuitStateChangeEvent) => void;
}

/**
 * Event emitted when execution starts
 */
export interface ExecutionStartEvent {
  readonly executionId: string;
  readonly functionName: string;
  readonly layer: FunctionLayer;
  readonly startedAt: number;
  readonly input: unknown;
}

/**
 * Event emitted when execution succeeds
 */
export interface ExecutionSuccessEvent {
  readonly executionId: string;
  readonly functionName: string;
  readonly layer: FunctionLayer;
  readonly durationMs: number;
  readonly output: unknown;
  readonly attempts: number;
}

/**
 * Event emitted when execution fails
 */
export interface ExecutionErrorEvent {
  readonly executionId: string;
  readonly functionName: string;
  readonly layer: FunctionLayer;
  readonly durationMs: number;
  readonly error: ServiceError;
  readonly attempts: number;
}

/**
 * Event emitted when a retry is attempted
 */
export interface RetryEvent {
  readonly executionId: string;
  readonly functionName: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly error: ServiceError;
}

/**
 * Circuit breaker state
 */
export type CircuitState = "closed" | "open" | "half-open";

/**
 * Event emitted when circuit breaker state changes
 */
export interface CircuitStateChangeEvent {
  readonly functionName: string;
  readonly previousState: CircuitState;
  readonly newState: CircuitState;
  readonly failureCount: number;
  readonly timestamp: number;
}

/**
 * Circuit breaker state entry
 */
export interface CircuitBreakerEntry {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly lastFailureAt?: number;
  readonly openedAt?: number;
}

/**
 * Store for circuit breaker state
 */
export interface CircuitBreakerStore {
  /** Get circuit breaker state for a function */
  get(functionName: string): CircuitBreakerEntry | undefined;
  /** Set circuit breaker state for a function */
  set(functionName: string, entry: CircuitBreakerEntry): void;
}

/**
 * Options for executing a function
 */
export interface ExecuteOptions {
  /** Override timeout from policy */
  readonly timeout?: Millis | "none";
  /** Skip circuit breaker check */
  readonly skipCircuitBreaker?: boolean;
  /** Skip retry logic */
  readonly skipRetry?: boolean;
}

/**
 * The runtime execution environment
 */
export interface Runtime {
  /** Execute a service function */
  execute<TInput, TOutput>(
    fn: ServiceFunction<FunctionLayer, TInput, TOutput>,
    input: TInput,
    options?: ExecuteOptions,
  ): Promise<Result<TOutput, ServiceError>>;

  /** Get circuit breaker state for a function */
  getCircuitState(functionName: string): CircuitBreakerEntry | undefined;

  /** Reset circuit breaker for a function */
  resetCircuit(functionName: string): void;
}

/**
 * Internal observe context implementation
 */
export interface ObserveContextImpl extends ObserveContext {
  /** Get all observed data */
  all(): Readonly<Record<string, unknown>>;
}

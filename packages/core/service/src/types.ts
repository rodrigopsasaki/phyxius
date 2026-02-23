import type { Result } from "@phyxiusjs/fp";
import type { Millis, Clock } from "@phyxiusjs/clock";
import type { z } from "zod";
import type { ServiceError } from "./errors.js";

/**
 * The three layers of a Phyxius application.
 * Each layer has different capabilities and restrictions.
 */
export type FunctionLayer = "data" | "domain" | "orchestration";

/**
 * Retry backoff strategy
 */
export type BackoffStrategy = "fixed" | "linear" | "exponential";

/**
 * Conditions that can trigger a retry
 */
export type RetryCondition =
  | "TIMEOUT"
  | "CONNECTION_ERROR"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "UNKNOWN_ERROR";

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts */
  readonly attempts: number;
  /** Backoff strategy between retries */
  readonly backoff: BackoffStrategy;
  /** Base delay between retries */
  readonly baseDelay?: Millis;
  /** Maximum delay between retries */
  readonly maxDelay?: Millis;
  /** Which error conditions should trigger a retry */
  readonly on: readonly RetryCondition[];
}

/**
 * Circuit breaker policy configuration
 */
export interface CircuitBreakerPolicy {
  /** Number of failures before opening the circuit */
  readonly threshold: number;
  /** Time to wait before attempting to close the circuit */
  readonly resetAfter: Millis;
}

/**
 * Complete failure policy for a service function.
 * ALL fields must be explicitly specified - no defaults.
 */
export interface FunctionPolicy {
  /** Maximum time the function can run before timing out */
  readonly timeout: Millis | "none";
  /** Retry policy or explicit "none" */
  readonly retry: RetryPolicy | "none";
  /** Circuit breaker policy or explicit "none" */
  readonly circuitBreaker: CircuitBreakerPolicy | "none";
}

/**
 * Base context available to all layers
 */
export interface BaseContext {
  /** Clock for time operations */
  readonly clock: Clock;
  /** Observability utilities */
  readonly observe: ObserveContext;
  /** Current execution metadata */
  readonly execution: ExecutionMetadata;
}

/**
 * Observability context for adding structured data to the execution
 */
export interface ObserveContext {
  /** Set a key-value pair */
  set(key: string, value: unknown): void;
  /** Push a value to an array */
  push(key: string, value: unknown): void;
  /** Increment a counter */
  inc(key: string, amount?: number): void;
  /** Get all observed data */
  all(): Readonly<Record<string, unknown>>;
}

/**
 * Metadata about the current execution
 */
export interface ExecutionMetadata {
  /** Unique identifier for this execution */
  readonly id: string;
  /** Name of the function being executed */
  readonly name: string;
  /** When the execution started */
  readonly startedAt: number;
  /** Current retry attempt (1-indexed) */
  readonly attempt: number;
}

/**
 * Context for data layer functions.
 * Data layer cannot call other functions.
 */
export interface DataContext extends BaseContext {
  readonly _layer: "data";
}

/**
 * Context for domain layer functions.
 * Domain layer can call data layer functions.
 */
export interface DomainContext extends BaseContext {
  readonly _layer: "domain";
  /** Call a data layer function */
  call<TIn, TOut>(
    fn: ServiceFunction<"data", TIn, TOut>,
    input: TIn,
  ): Promise<Result<TOut, ServiceError>>;
}

/**
 * Context for orchestration layer functions.
 * Orchestration layer can call data and domain layer functions.
 */
export interface OrchestrationContext extends BaseContext {
  readonly _layer: "orchestration";
  /** Call a data or domain layer function */
  call<TIn, TOut>(
    fn: ServiceFunction<"data" | "domain", TIn, TOut>,
    input: TIn,
  ): Promise<Result<TOut, ServiceError>>;
  /** Emit an event for async processing */
  emit(event: string, data: unknown): void;
  /** Ask a process for a response */
  ask<TResp>(process: string, message: unknown): Promise<TResp>;
}

/**
 * Map from layer to context type
 */
export type LayerContext<L extends FunctionLayer> = L extends "data"
  ? DataContext
  : L extends "domain"
    ? DomainContext
    : OrchestrationContext;

/**
 * The handler function signature
 */
export type ServiceHandler<
  TLayer extends FunctionLayer,
  TInput,
  TOutput,
> = (
  ctx: LayerContext<TLayer>,
  input: TInput,
) => Promise<Result<TOutput, ServiceError>>;

/**
 * Definition for a service function.
 * This is what you pass to defineFunction.
 */
export interface ServiceFunctionDefinition<
  TLayer extends FunctionLayer,
  TInput,
  TOutput,
> {
  /** Which layer this function belongs to */
  readonly layer: TLayer;
  /** Unique name for observability and routing */
  readonly name: string;
  /** Zod schema for input validation */
  readonly input: z.ZodType<TInput>;
  /** Zod schema for output validation */
  readonly output: z.ZodType<TOutput>;
  /** Failure policy - REQUIRED */
  readonly policy: FunctionPolicy;
  /** The handler function */
  readonly handler: ServiceHandler<TLayer, TInput, TOutput>;
}

/**
 * A fully defined service function
 */
export interface ServiceFunction<
  TLayer extends FunctionLayer,
  TInput,
  TOutput,
> {
  readonly _tag: "ServiceFunction";
  readonly layer: TLayer;
  readonly name: string;
  readonly input: z.ZodType<TInput>;
  readonly output: z.ZodType<TOutput>;
  readonly policy: FunctionPolicy;
  readonly handler: ServiceHandler<TLayer, TInput, TOutput>;
}

/**
 * Options for a service definition
 */
export interface ServiceDefinition<TFunctions extends readonly ServiceFunction<FunctionLayer, unknown, unknown>[]> {
  /** Name of the service */
  readonly name: string;
  /** Service functions */
  readonly functions: TFunctions;
  /** Default policy for functions that don't specify their own */
  readonly defaults?: Partial<FunctionPolicy>;
  /** Service-level observability hooks */
  readonly observe?: ServiceObserveHooks;
}

/**
 * Observability hooks for a service
 */
export interface ServiceObserveHooks {
  /** Called when a function starts */
  onStart?: (ctx: ObserveContext, fn: ServiceFunction<FunctionLayer, unknown, unknown>, input: unknown) => void;
  /** Called when a function succeeds */
  onSuccess?: (ctx: ObserveContext, fn: ServiceFunction<FunctionLayer, unknown, unknown>, output: unknown, durationMs: number) => void;
  /** Called when a function fails */
  onError?: (ctx: ObserveContext, fn: ServiceFunction<FunctionLayer, unknown, unknown>, error: ServiceError, durationMs: number) => void;
}

/**
 * A defined service containing multiple functions
 */
export interface Service<TFunctions extends readonly ServiceFunction<FunctionLayer, unknown, unknown>[]> {
  readonly _tag: "Service";
  readonly name: string;
  readonly functions: TFunctions;
  readonly defaults?: Partial<FunctionPolicy>;
  readonly observe?: ServiceObserveHooks;
  /** Get a function by name */
  get<TName extends TFunctions[number]["name"]>(
    name: TName,
  ): Extract<TFunctions[number], { name: TName }> | undefined;
}

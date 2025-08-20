import type { Effect, Result } from "@phyxiusjs/effect";
import type { PhyxiusContext } from "@phyxiusjs/context";
import type { ProcessRef } from "@phyxiusjs/process";
import type { Clock, Instant } from "@phyxiusjs/clock";

/**
 * A unit of work received from an external system.
 * Each work unit has a unique correlation ID for tracing.
 */
export interface WorkUnit<TInput> {
  /** Unique identifier for tracing this work unit through the system */
  readonly correlationId: string;

  /** The actual input data to be processed */
  readonly input: TInput;

  /** When this work unit was received */
  readonly receivedAt: Instant;

  /** Optional metadata about the source */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Result of processing a work unit.
 * Contains either success value or error information.
 */
export type WorkResult<TOutput> = Result<HandlerError, TOutput>;

/**
 * Function that processes a work unit with access to scoped context.
 * Must be pure - any side effects should be managed through the Handler.
 */
export interface ProcessorFn<TInput, TOutput> {
  (input: TInput, ctx: PhyxiusContext): Effect<HandlerError, TOutput>;
}

/**
 * Adapter interface for connecting different transport mechanisms.
 * Handles the specifics of receiving work and sending responses.
 */
export interface Adapter<TInput, TOutput> {
  /** Human-readable name for this adapter */
  readonly name: string;

  /**
   * Start receiving work units from the external system.
   * Returns an async iterable that yields work units.
   */
  receive(): AsyncIterable<WorkUnit<TInput>>;

  /**
   * Send a response back to the external system.
   * Must handle both success and error cases appropriately.
   */
  respond(correlationId: string, result: WorkResult<TOutput>): Effect<AdapterError, void>;

  /**
   * Close the adapter and clean up resources.
   * Should gracefully handle any pending work.
   */
  close(): Effect<AdapterError, void>;

  /**
   * Check if the adapter is healthy and ready to receive work.
   */
  isHealthy(): boolean;
}

/**
 * Configuration for the Handler behavior.
 */
export interface HandlerConfig {
  /** Maximum number of concurrent work units being processed */
  readonly maxConcurrency: number;

  /** Maximum time to wait for a work unit to complete */
  readonly timeoutMs: number;

  /** Circuit breaker configuration */
  readonly circuitBreaker: CircuitBreakerConfig;

  /** Backpressure configuration */
  readonly backpressure: BackpressureConfig;

  /** Graceful shutdown timeout */
  readonly shutdownTimeoutMs: number;
}

/**
 * Circuit breaker configuration for fault tolerance.
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  readonly failureThreshold: number;

  /** Time window for counting failures (ms) */
  readonly windowMs: number;

  /** How long to wait before attempting to close the circuit (ms) */
  readonly cooldownMs: number;
}

/**
 * Backpressure configuration for flow control.
 */
export interface BackpressureConfig {
  /** Maximum queue size before rejecting new work */
  readonly maxQueueSize: number;

  /** Strategy when queue is full */
  readonly overflowStrategy: "reject" | "drop-oldest" | "drop-newest";
}

/**
 * Current state of the Handler.
 */
export type HandlerState = "initializing" | "running" | "stopping" | "stopped" | "circuit-open" | "failed";

/**
 * Metrics about Handler performance.
 */
export interface HandlerMetrics {
  /** Current state */
  readonly state: HandlerState;

  /** Number of work units currently being processed */
  readonly activeCount: number;

  /** Number of work units in the queue */
  readonly queueSize: number;

  /** Total work units processed successfully */
  readonly successCount: number;

  /** Total work units that failed */
  readonly errorCount: number;

  /** Current error rate (errors per second) */
  readonly errorRate: number;

  /** Average processing time (ms) */
  readonly avgProcessingTimeMs: number;
}

/**
 * Events emitted by the Handler for observability.
 */
export type HandlerEvent =
  | {
      type: "handler:started";
      handlerId: string;
      adapterName: string;
      config: HandlerConfig;
      at: Instant;
    }
  | {
      type: "handler:stopped";
      handlerId: string;
      reason: "graceful" | "timeout" | "error";
      at: Instant;
    }
  | {
      type: "work:received";
      handlerId: string;
      correlationId: string;
      queueSize: number;
      at: Instant;
    }
  | {
      type: "work:started";
      handlerId: string;
      correlationId: string;
      activeCount: number;
      at: Instant;
    }
  | {
      type: "work:completed";
      handlerId: string;
      correlationId: string;
      durationMs: number;
      success: boolean;
      at: Instant;
    }
  | {
      type: "work:timeout";
      handlerId: string;
      correlationId: string;
      timeoutMs: number;
      at: Instant;
    }
  | {
      type: "circuit:opened";
      handlerId: string;
      errorCount: number;
      windowMs: number;
      at: Instant;
    }
  | {
      type: "circuit:closed";
      handlerId: string;
      at: Instant;
    }
  | {
      type: "backpressure:triggered";
      handlerId: string;
      queueSize: number;
      strategy: string;
      at: Instant;
    };

/**
 * Function for emitting Handler events.
 */
export interface EmitFn {
  (event: HandlerEvent): void;
}

/**
 * Options for creating a Handler.
 */
export interface HandlerOptions<TInput, TOutput> {
  /** Human-readable name for this handler */
  readonly name: string;

  /** Function that processes work units */
  readonly processor: ProcessorFn<TInput, TOutput>;

  /** Configuration for behavior */
  readonly config: HandlerConfig;

  /** Clock implementation for time operations */
  readonly clock: Clock;

  /** Function for emitting events */
  readonly emit?: EmitFn;

  /** Context to use as the root for all work units */
  readonly rootContext?: PhyxiusContext;
}

/**
 * Main Handler interface for processing external work units.
 */
export interface Handler<TInput, TOutput> {
  /** Unique identifier for this handler */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Current state */
  readonly state: HandlerState;

  /**
   * Start the handler with the given adapter.
   * The handler will begin receiving and processing work units.
   */
  start(adapter: Adapter<TInput, TOutput>): Effect<HandlerError, void>;

  /**
   * Stop the handler gracefully.
   * Will finish processing current work units before stopping.
   */
  stop(): Effect<HandlerError, void>;

  /**
   * Get current metrics about the handler's performance.
   */
  getMetrics(): HandlerMetrics;

  /**
   * Get the underlying process reference for supervision.
   */
  getProcessRef(): ProcessRef<HandlerMessage>;
}

/**
 * Internal message types for Handler process communication.
 */
export type HandlerMessage =
  | { type: "start"; adapter: Adapter<unknown, unknown> }
  | { type: "stop" }
  | { type: "work-received"; workUnit: WorkUnit<unknown> }
  | { type: "work-completed"; correlationId: string; result: WorkResult<unknown> }
  | { type: "adapter-closed" }
  | { type: "check-circuit" }
  | { type: "metrics-request"; reply: (metrics: HandlerMetrics) => void };

/**
 * Error types for Handler operations.
 */
export class HandlerError extends Error {
  constructor(
    message: string,
    public readonly code: HandlerErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HandlerError";
  }
}

export type HandlerErrorCode =
  | "HANDLER_NOT_RUNNING"
  | "HANDLER_ALREADY_RUNNING"
  | "ADAPTER_ERROR"
  | "PROCESSOR_ERROR"
  | "TIMEOUT"
  | "CIRCUIT_OPEN"
  | "BACKPRESSURE"
  | "SHUTDOWN_TIMEOUT";

/**
 * Error types for Adapter operations.
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly code: AdapterErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export type AdapterErrorCode =
  | "CONNECTION_FAILED"
  | "SEND_FAILED"
  | "RECEIVE_FAILED"
  | "CLOSE_FAILED"
  | "INVALID_INPUT"
  | "TRANSPORT_ERROR";

/**
 * Default configuration values.
 */
export const DEFAULT_HANDLER_CONFIG: HandlerConfig = {
  maxConcurrency: 10,
  timeoutMs: 30_000,
  circuitBreaker: {
    failureThreshold: 10,
    windowMs: 60_000,
    cooldownMs: 30_000,
  },
  backpressure: {
    maxQueueSize: 100,
    overflowStrategy: "reject",
  },
  shutdownTimeoutMs: 10_000,
} as const;

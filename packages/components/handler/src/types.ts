import type { Effect, RetryPolicy } from "@phyxiusjs/effect";
import type { PhyxiusContext } from "@phyxiusjs/context";
import type { ProcessRef, ProcessSpec } from "@phyxiusjs/process";
import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import type { Result, Option } from "@phyxius/fp";
import type { Validator } from "@phyxiusjs/validate";

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
export type WorkResult<TOutput> = Result<TOutput, HandlerError>;

/**
 * Function that processes a work unit with access to scoped context.
 * Returns an Effect for composable async operations.
 */
export interface ProcessorFn<TInput, TOutput> {
  (input: TInput, ctx: PhyxiusContext): Effect<HandlerError, TOutput>;
}

/**
 * Composable processor pipeline that validates, processes, and transforms work.
 */
export interface ProcessorPipeline<TInput, TOutput> {
  /** Input validation */
  readonly validate?: Validator<TInput>;
  /** Main processing function */
  readonly process: ProcessorFn<TInput, TOutput>;
  /** Output validation */
  readonly validateOutput?: Validator<TOutput>;
  /** Retry policy for failures */
  readonly retry?: RetryPolicy;
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
  readonly timeoutMs: Millis;

  /** Circuit breaker configuration */
  readonly circuitBreaker: CircuitBreakerConfig;

  /** Backpressure configuration */
  readonly backpressure: BackpressureConfig;

  /** Graceful shutdown timeout */
  readonly shutdownTimeoutMs: Millis;

  /** Metrics collection interval */
  readonly metricsIntervalMs: Millis;
}

/**
 * Circuit breaker configuration for fault tolerance.
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  readonly failureThreshold: number;

  /** Time window for counting failures */
  readonly windowMs: Millis;

  /** How long to wait before attempting to close the circuit */
  readonly cooldownMs: Millis;

  /** Minimum requests before circuit can trip */
  readonly minimumRequests: number;
}

/**
 * Circuit breaker states tracked in an Atom.
 */
export interface CircuitBreakerState {
  readonly status: "closed" | "open" | "half-open";
  readonly failureCount: number;
  readonly successCount: number;
  readonly lastFailureTime: Option<Instant>;
  readonly windowStartTime: Instant;
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
 * Internal handler state managed by Atom.
 */
export interface HandlerInternalState {
  readonly status: HandlerState;
  readonly activeWorkCount: number;
  readonly queuedWorkCount: number;
  readonly totalProcessed: number;
  readonly totalSucceeded: number;
  readonly totalFailed: number;
  readonly lastActivityTime: Instant;
  readonly startTime: Option<Instant>;
}

/**
 * Comprehensive metrics about Handler performance.
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

  /** Circuit breaker status */
  readonly circuitBreakerStatus: "closed" | "open" | "half-open";

  /** Throughput (requests per second) */
  readonly throughputPerSecond: number;

  /** 95th percentile processing time */
  readonly p95ProcessingTimeMs: number;

  /** Memory usage stats */
  readonly memoryUsage: {
    readonly heapUsed: number;
    readonly heapTotal: number;
    readonly external: number;
  };

  /** Uptime since last start */
  readonly uptimeMs: number;
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
    }
  | {
      type: "queue:enqueued";
      queueSize: number;
      totalEnqueued: number;
      at: Instant;
    }
  | {
      type: "queue:dequeued";
      queueSize: number;
      totalDequeued: number;
      waitTimeMs: number;
      at: Instant;
    }
  | {
      type: "queue:cleared";
      clearedCount: number;
      at: Instant;
    }
  | {
      type: "metrics:request_recorded";
      processingTimeMs: number;
      success: boolean;
      totalProcessed: number;
      at: Instant;
    }
  | {
      type: "metrics:reset";
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

  /** Processing pipeline with validation and retry */
  readonly processor: ProcessorPipeline<TInput, TOutput>;

  /** Configuration for behavior */
  readonly config: HandlerConfig;

  /** Clock implementation for time operations */
  readonly clock: Clock;

  /** Journal for event sourcing */
  readonly journal: Journal<HandlerEvent>;

  /** Function for emitting events (optional, will use journal if not provided) */
  readonly emit?: EmitFn;

  /** Context to use as the root for all work units */
  readonly rootContext?: PhyxiusContext;

  /** Process specification for supervision */
  readonly processSpec?: Partial<ProcessSpec<HandlerMessage, HandlerInternalState, HandlerOptions<TInput, TOutput>>>;
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
  timeoutMs: 30_000 as Millis,
  circuitBreaker: {
    failureThreshold: 10,
    windowMs: 60_000 as Millis,
    cooldownMs: 30_000 as Millis,
    minimumRequests: 5,
  },
  backpressure: {
    maxQueueSize: 100,
    overflowStrategy: "reject",
  },
  shutdownTimeoutMs: 10_000 as Millis,
  metricsIntervalMs: 5_000 as Millis,
} as const;

/**
 * Default retry policy for processor functions.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  backoffFactor: 2,
} as const;

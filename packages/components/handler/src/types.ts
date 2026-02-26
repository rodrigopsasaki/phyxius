import type { Clock, Instant } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import type { Runtime } from "@phyxiusjs/runtime";
import type { FunctionLayer, ServiceFunction } from "@phyxiusjs/service";
import type { Result } from "@phyxiusjs/fp";

/**
 * Defines a Handler — the universal work unit configuration.
 * A definition is pure data; nothing is running yet.
 * Call `createHandler()` to materialize it into a running process.
 */
export interface HandlerDefinition<TInput, TOutput> {
  /** Human-readable name for observability */
  readonly name: string;
  /** The service function this handler will execute */
  readonly fn: ServiceFunction<FunctionLayer, TInput, TOutput>;
  /** Concurrency and backpressure configuration — all fields required */
  readonly concurrency: {
    /** Maximum number of simultaneous executions */
    readonly max: number;
    /** What to do when the queue is full */
    readonly backpressure: "reject" | "drop-oldest";
    /** Maximum number of items that can wait in the queue */
    readonly queueSize: number;
  };
}

/**
 * Dependencies required to materialize a HandlerDefinition into a running Handler.
 */
export interface HandlerConfig {
  /** Clock for time operations */
  readonly clock: Clock;
  /** Journal to append one entry per completed work unit */
  readonly journal: Journal<HandlerJournalEvent>;
  /** Runtime for executing the service function (owns timeout, retry, circuit breaker) */
  readonly runtime: Runtime;
}

/**
 * Optional metadata attached to each submit call.
 * Propagated to the Journal event for tracing.
 */
export interface WorkMeta {
  /** Caller-supplied correlation ID for distributed tracing */
  readonly correlationId?: string;
  /** Transport source — "http", "queue", "cron", etc. */
  readonly source?: string;
  /** Arbitrary adapter context */
  readonly context?: Record<string, unknown>;
}

/**
 * Lifecycle state of a Handler.
 */
export type HandlerState = "idle" | "running" | "stopping" | "stopped";

/**
 * Internal state tracked in the Atom.
 */
export interface HandlerInternalState {
  readonly status: HandlerState;
  readonly activeCount: number;
  readonly queuedCount: number;
  /** Messages submitted to the Process mailbox but not yet picked up by handle(). */
  readonly pendingCount: number;
  readonly totalProcessed: number;
  readonly totalSucceeded: number;
  readonly totalFailed: number;
}

/**
 * Observable metrics exposed via `getMetrics()`.
 */
export interface HandlerMetrics {
  readonly state: HandlerState;
  readonly activeCount: number;
  readonly queuedCount: number;
  readonly totalProcessed: number;
  readonly totalSucceeded: number;
  readonly totalFailed: number;
}

/**
 * The materialized Handler — a supervised Process that manages a queue of incoming work
 * and delegates each work unit to a ServiceFunction via Runtime.
 */
export interface Handler<TInput, TOutput> {
  /**
   * Start the handler's supervised process.
   * Transitions from "idle" → "running".
   */
  start(): Promise<void>;

  /**
   * Stop the handler gracefully.
   * Drains active work before stopping. Rejects queued work that hasn't started.
   */
  stop(): Promise<void>;

  /**
   * Submit a work unit. Returns immediately if backpressure is triggered.
   * Called by adapters (HTTP, queue, cron, etc.).
   */
  submit(input: TInput, meta?: WorkMeta): Promise<Result<TOutput, HandlerError>>;

  /**
   * Return a snapshot of current operational metrics.
   */
  getMetrics(): HandlerMetrics;

  /**
   * Return the current lifecycle state.
   */
  getState(): HandlerState;
}

/**
 * One Journal entry appended after every work unit completes (success or failure).
 * Mandatory — never opt-in.
 */
export interface HandlerJournalEvent {
  /** ID generated per execution (matches correlationId if not overridden) */
  readonly executionId: string;
  /** Name of the ServiceFunction that was executed */
  readonly functionName: string;
  /** Transport source — "http", "queue", "cron", "unknown" */
  readonly source: string;
  /** Caller-supplied correlation ID for distributed tracing */
  readonly correlationId: string;
  /** Wall duration from submit to completion in milliseconds */
  readonly durationMs: number;
  /** Number of attempts made by the runtime (includes retries) */
  readonly attempts: number;
  /** Whether the execution ultimately succeeded or failed */
  readonly outcome: "success" | "failure";
  /** Structured data written to ctx.observe during execution */
  readonly observedData: Readonly<Record<string, unknown>>;
  /** Error details (only present on failure) */
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  /** When the Journal entry was written */
  readonly at: Instant;
}

/**
 * Error type for Handler-level failures.
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
  | "BACKPRESSURE_REJECT"
  | "HANDLER_NOT_RUNNING"
  | "HANDLER_ALREADY_RUNNING"
  | "SHUTDOWN_TIMEOUT"
  | "EXECUTION_FAILED";

/**
 * Internal process message types.
 * Not exported — internal coordination only.
 */
export interface SubmitMsg<TInput, TOutput> {
  readonly type: "submit";
  readonly correlationId: string;
  readonly input: TInput;
  readonly meta: WorkMeta;
  readonly resolve: (result: Result<TOutput, HandlerError>) => void;
}

export interface WorkDoneMsg {
  readonly type: "work-done";
}

export type HandlerMsg<TInput, TOutput> = SubmitMsg<TInput, TOutput> | WorkDoneMsg;

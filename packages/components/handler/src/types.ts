import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import type { Result } from "@phyxiusjs/fp";

// ── Handler Definition ──────────────────────────────────────────────────────

/**
 * Defines a Handler — the universal work unit configuration.
 * A definition is pure data; nothing is running yet.
 * Call `createHandler()` to materialize it into a running process.
 *
 * The processor is a plain async function — no Service or Runtime needed.
 * Resilience (timeout, retry, circuit-breaker) is configured here directly.
 */
export interface HandlerDefinition<TInput, TOutput> {
  /** Human-readable name for observability and telemetry grouping */
  readonly name: string;

  /** The async function this handler will execute per work unit */
  readonly processor: (input: TInput) => Promise<TOutput>;

  /** Concurrency and backpressure configuration — all fields required */
  readonly concurrency: {
    /** Maximum number of simultaneous executions */
    readonly max: number;
    /** What to do when the queue is full */
    readonly backpressure: "reject" | "drop-oldest";
    /** Maximum number of items that can wait in the queue */
    readonly queueSize: number;
  };

  /** Per-execution timeout in milliseconds. If omitted, no timeout is applied. */
  readonly timeout?: Millis;

  /** Retry configuration. If omitted, no retries — the processor runs once. */
  readonly retry?: {
    /** Maximum number of attempts (including the first). Minimum 1. */
    readonly maxAttempts: number;
    /** Backoff strategy between retries */
    readonly backoff: "fixed" | "exponential";
    /** Initial delay between retries (default: 100ms) */
    readonly initialDelay?: Millis;
    /** Maximum delay cap for exponential backoff (default: 30_000ms) */
    readonly maxDelay?: Millis;
  };

  /** Circuit breaker configuration. If omitted, no circuit breaker is applied. */
  readonly circuitBreaker?: {
    /** Number of consecutive failures before opening the circuit */
    readonly failureThreshold: number;
    /** Time to wait before allowing a probe request through (half-open) */
    readonly resetTimeout: Millis;
  };
}

// ── Handler Config ──────────────────────────────────────────────────────────

/**
 * Dependencies required to materialize a HandlerDefinition into a running Handler.
 * No Runtime or Service — the Handler is self-contained.
 */
export interface HandlerConfig {
  /** Clock for time operations (deterministic in tests) */
  readonly clock: Clock;
  /** Journal to append one entry per completed work unit */
  readonly journal: Journal<HandlerEvent>;
}

// ── Work Meta ───────────────────────────────────────────────────────────────

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
  readonly context?: Readonly<Record<string, unknown>>;
}

// ── Handler State ───────────────────────────────────────────────────────────

/** Lifecycle state of a Handler. */
export type HandlerState = "idle" | "running" | "stopping" | "stopped";

/**
 * Internal state tracked in the Atom. Not exposed publicly.
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

// ── Handler Metrics ─────────────────────────────────────────────────────────

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

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * The materialized Handler — a supervised Process that manages a queue of
 * incoming work and executes each unit with built-in resilience and observability.
 *
 * Self-contained: timeout, retry, circuit-breaker, and Context+Observe wiring
 * are all handled internally. No Runtime or Service delegation.
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

// ── Handler Event (Journal) ─────────────────────────────────────────────────

/**
 * One Journal entry appended after every work unit completes (success or failure).
 * Mandatory — never opt-in.
 *
 * The `observed` field captures everything written via `observe.set()` / `observe.push()`
 * during execution — this is the missing piece that wires Context+Observe into the Journal.
 */
export interface HandlerEvent {
  /** Handler name from the definition */
  readonly handlerName: string;
  /** Unique ID generated per execution */
  readonly executionId: string;
  /** When execution started */
  readonly startedAt: Instant;
  /** When execution completed */
  readonly completedAt: Instant;
  /** Wall duration from start to completion in milliseconds */
  readonly durationMs: number;
  /** Number of attempts made (includes retries; 1 = no retries) */
  readonly attempts: number;
  /** Whether the execution ultimately succeeded or failed */
  readonly outcome: "success" | "failure";
  /** Transport source — "http", "queue", "cron", "unknown" */
  readonly source: string;
  /** Caller-supplied correlation ID for distributed tracing */
  readonly correlationId: string;
  /** Structured data written via observe during execution — THE MISSING PIECE */
  readonly observed: Readonly<Record<string, unknown>>;
  /** Error details (only present on failure) */
  readonly error?: {
    readonly message: string;
    readonly stack?: string;
  };
  /** Optional metadata from the submit call */
  readonly meta?: WorkMeta;
}

// ── Handler Error ───────────────────────────────────────────────────────────

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
  | "EXECUTION_FAILED"
  | "EXECUTION_TIMEOUT"
  | "CIRCUIT_OPEN";

// ── Circuit Breaker State ───────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerInternalState {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  /** Monotonic timestamp (monoMs) when the circuit was opened */
  readonly openedAt: number;
}

// ── Internal Process Messages ───────────────────────────────────────────────

/**
 * Internal process message types — not exported from the package.
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

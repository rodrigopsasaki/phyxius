import type { Budget, Clock, Instant, Millis } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import type { Result } from "@phyxiusjs/fp";
import type { Validator, ValidationError } from "@phyxiusjs/validate";
import type { RetryPolicy } from "@phyxiusjs/retry";
import type { CircuitBreakerPolicy } from "@phyxiusjs/circuit-breaker";
import type { ProcessId } from "@phyxiusjs/process";

// ── Concurrency + backpressure ──────────────────────────────────────────────

/**
 * Concurrency policy. All fields required — no implicit defaults. You declare
 * how many invocations run in parallel (`max`), how deep the waiting queue is
 * (`queueSize`), and what happens when the queue is full (`backpressure`).
 */
export interface ConcurrencyPolicy {
  readonly max: number;
  readonly queueSize: number;
  readonly backpressure: "reject" | "drop-oldest";
}

// ── Handler spec (pure data) ────────────────────────────────────────────────

/**
 * A handler definition is a value. Every stability field is required — no
 * decision can be deferred. For "no retry" you write `retry.none()`; for "no
 * circuit breaker" you write `cb.none()`. Silence is not a valid answer.
 *
 * `TFields` is the resolved `observe.fields(...)` bag for this handler — the
 * sidecar type that declares what's observable per invocation.
 */
export interface HandlerSpec<TInput, TOutput, TFields> {
  /** Handler name — appears in every journal entry and emitted event. */
  readonly name: string;

  /** Input validator. Runs before the handler body; invalid input → VALIDATION_ERROR. */
  readonly input: Validator<TInput>;

  /** Output validator. Runs after the handler body; invalid output → VALIDATION_ERROR. */
  readonly output: Validator<TOutput>;

  /**
   * Observability schema (from `observe.fields({ ... })`). The handler
   * snapshots this into the journal entry at completion.
   */
  readonly fields: TFields;

  /** Per-invocation timeout. Becomes a `Clock.Budget` the run function can honor. */
  readonly timeout: Millis;

  /** Concurrency + backpressure — all three fields required. */
  readonly concurrency: ConcurrencyPolicy;

  /** Retry policy. Use `retry.none()` to declare "no retries." */
  readonly retry: RetryPolicy;

  /** Circuit-breaker policy. Use `cb.none()` to declare "no breaker." */
  readonly circuitBreaker: CircuitBreakerPolicy;

  /**
   * The work itself. Receives the validated input and a narrow tools object.
   * The signal aborts when the budget expires; pass it to AbortSignal-aware
   * APIs (fetch, fs, streams) so orphan work exits cleanly on timeout.
   */
  readonly run: (input: TInput, tools: HandlerTools) => Promise<TOutput>;
}

// ── Tools handed to run() ───────────────────────────────────────────────────

export interface HandlerTools {
  readonly clock: Clock;
  readonly budget: Budget;
  readonly signal: AbortSignal;
}

// ── Running handler ─────────────────────────────────────────────────────────

export type HandlerStatus = "idle" | "running" | "stopping" | "stopped" | "failed";

export interface HandlerMetrics {
  readonly status: HandlerStatus;
  readonly activeCount: number;
  readonly queuedCount: number;
  readonly totalInvocations: number;
  readonly totalSuccesses: number;
  readonly totalFailures: number;
  readonly circuitState: "closed" | "open" | "half-open" | "disabled";
}

export interface RunningHandler<TInput, TOutput> {
  readonly id: ProcessId;
  readonly name: string;

  /**
   * Invoke the handler with a validated input. Returns a Result — every
   * failure mode is a typed value, never a thrown exception.
   */
  invoke(input: TInput, meta?: InvocationMeta): Promise<Result<TOutput, HandlerError>>;

  getMetrics(): HandlerMetrics;
  getStatus(): HandlerStatus;

  /**
   * Gracefully stop the handler. Drains active invocations up to
   * `drainTimeout` (default 10s). Queued invocations that haven't started
   * are rejected with `HANDLER_NOT_RUNNING`.
   */
  stop(options?: { drainTimeoutMs?: Millis }): Promise<void>;
}

export interface InvocationMeta {
  /** Caller-supplied correlation ID — flows into the journal entry. */
  readonly correlationId?: string;
  /** Transport source — `"http"`, `"queue"`, `"cron"`, `"internal"`, etc. */
  readonly source?: string;
  /** Arbitrary adapter context — included as `meta` on the journal entry. */
  readonly context?: Readonly<Record<string, unknown>>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Every failure mode is a typed value. This is the "every failure mode must
 * be directly assertable" invariant, expressed at the type level.
 */
export type HandlerError =
  | { readonly type: "VALIDATION_ERROR"; readonly target: "input" | "output"; readonly error: ValidationError }
  | { readonly type: "TIMEOUT"; readonly timeoutMs: number }
  | { readonly type: "HANDLER_ERROR"; readonly cause: unknown }
  | { readonly type: "RETRY_EXHAUSTED"; readonly attempts: number; readonly lastCause: unknown }
  | { readonly type: "CIRCUIT_OPEN"; readonly openedAt: number; readonly willRetryAfter: number }
  | { readonly type: "BACKPRESSURE_REJECT" }
  | { readonly type: "DROPPED" }
  | { readonly type: "HANDLER_NOT_RUNNING" };

// ── Journal entry ───────────────────────────────────────────────────────────

/**
 * One journal entry per completed invocation, regardless of transport. The
 * same shape appears for HTTP, queue, scheduler, and internal invocations —
 * that's the observability payoff.
 */
export interface HandlerEvent {
  readonly name: string;
  readonly invocationId: string;
  readonly correlationId?: string;
  readonly source: string;
  readonly startedAt: Instant;
  readonly completedAt: Instant;
  readonly durationMs: number;
  readonly attempts: number;
  readonly outcome: "success" | "failure";
  readonly observed: Readonly<Record<string, unknown>>;
  readonly error?: {
    readonly type: HandlerError["type"];
    readonly message: string;
    readonly stack?: string;
  };
  readonly meta?: Readonly<Record<string, unknown>>;
}

// ── Runtime wiring ──────────────────────────────────────────────────────────

export interface HandlerRuntime {
  readonly clock: Clock;
  readonly journal: Journal<HandlerEvent>;
  /** Optional: override invocation-ID generation (useful for deterministic tests). */
  readonly idGenerator?: () => string;
}

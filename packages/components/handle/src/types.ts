import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import type { Result } from "@phyxiusjs/fp";

/**
 * Options for creating a handler factory.
 */
export interface CreateHandlerOptions {
  readonly clock: Clock;
  readonly journal: Journal<CanonicalLog>;
  /** Default timeout for all handler invocations. Can be overridden per-call. */
  readonly defaultTimeoutMs?: Millis;
  /**
   * Custom request ID generator. Defaults to a per-factory counter seeded
   * with `clock.now().wallMs`. Provide a deterministic generator in tests.
   */
  readonly idGenerator?: () => string;
}

/**
 * A handler factory — call it to wrap any async operation with
 * context, observability, and structured error handling.
 */
export type Handler = <T>(params: HandleParams<T>) => Promise<HandleResult<T>>;

/**
 * Parameters for a single handler invocation.
 */
export interface HandleParams<T> {
  /** Handler name for logging and metrics (e.g., "getEstimate", "createUser"). */
  readonly name: string;
  /**
   * Initial fields stamped into the scope's data at the start of the request.
   * Flows into the canonical log alongside handle's infrastructure fields and
   * whatever the caller's `run` writes via `@phyxiusjs/observe`.
   */
  readonly initial?: Readonly<Record<string, unknown>>;
  /** The business logic to execute. */
  readonly run: (tools: HandleTools) => Promise<T> | T;
  /** Per-call timeout override. */
  readonly timeoutMs?: Millis;
}

/**
 * Tools available inside the run function.
 *
 * Deliberately narrow. For accumulating observability data into the canonical
 * log, use `@phyxiusjs/observe` — declare a typed schema with
 * `observe.fields(...)` and write through the resulting handles.
 *
 * The `signal` aborts when the handler's timeout elapses. Pass it to
 * AbortSignal-aware APIs (fetch, fs.promises.*, streams) so work exits
 * cleanly on timeout instead of running orphaned in the background.
 */
export interface HandleTools {
  /** The clock instance for timing operations. */
  readonly clock: Clock;
  /** Aborts on timeout (if one is configured). Otherwise never aborts. */
  readonly signal: AbortSignal;
}

/**
 * Result of a handler invocation.
 */
export interface HandleResult<T> {
  /** The Result — Ok with the return value, or Err with a HandleError. */
  readonly result: Result<T, HandleError>;
  /** The canonical log entry that was appended to the journal. */
  readonly log: CanonicalLog;
}

/**
 * Structured error from a handler invocation.
 */
export type HandleError =
  | { readonly type: "TIMEOUT"; readonly timeoutMs: number; readonly name: string }
  | { readonly type: "HANDLER_ERROR"; readonly name: string; readonly cause: unknown };

/**
 * The canonical log entry — a structured record of everything that
 * happened during a single handler invocation.
 */
export interface CanonicalLog {
  readonly handlerName: string;
  readonly requestId: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly errorType?: string;
  readonly errorMessage?: string;
  readonly [key: string]: unknown;
}

/**
 * Structured events emitted by the handler for internal observability.
 */
export type HandleEvent =
  | { readonly type: "handle:start"; readonly name: string; readonly requestId: string; readonly at: Instant }
  | { readonly type: "handle:success"; readonly name: string; readonly durationMs: number; readonly at: Instant }
  | { readonly type: "handle:error"; readonly name: string; readonly error: unknown; readonly at: Instant }
  | { readonly type: "handle:timeout"; readonly name: string; readonly timeoutMs: number; readonly at: Instant };

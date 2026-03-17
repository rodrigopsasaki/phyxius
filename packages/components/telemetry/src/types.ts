import type { Clock, Instant } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import type { HandlerEvent } from "@phyxiusjs/handler";

// ── Telemetry Query Results ─────────────────────────────────────────────────

/** Latency percentiles in milliseconds. */
export interface LatencyStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly min: number;
}

/** Error rate as a ratio (0-1) plus absolute counts. */
export interface ErrorRateStats {
  readonly total: number;
  readonly failed: number;
  readonly rate: number;
}

/** Per-handler aggregate stats. */
export interface HandlerStats {
  readonly handlerName: string;
  readonly totalRequests: number;
  readonly errorRate: number;
  readonly p95: number;
  readonly lastExecutedAt: Instant;
}

/** Retry frequency per handler. */
export interface RetryStats {
  readonly handlerName: string;
  readonly totalRetries: number;
  readonly avgAttempts: number;
}

// ── Telemetry Query Parameters ──────────────────────────────────────────────

export interface TimeFilter {
  readonly handlerName?: string;
  readonly since?: Instant;
}

export interface LimitFilter {
  readonly limit: number;
  readonly since?: Instant;
}

// ── Telemetry Config ────────────────────────────────────────────────────────

export interface TelemetryConfig {
  readonly journal: Journal<HandlerEvent>;
  readonly clock: Clock;
  readonly alerts?: {
    /** Log warning if any execution takes longer than this (ms). */
    readonly slowThresholdMs?: number;
    /** Log warning if error rate exceeds this (0-1). */
    readonly errorRateThreshold?: number;
  };
}

// ── Telemetry Interface ─────────────────────────────────────────────────────

/**
 * Queryable analytics layer over a Journal of HandlerEvents.
 * This is what replaces Datadog for personal projects.
 *
 * All methods are pure computations over `journal.getSnapshot()` — no state,
 * no external dependencies.
 */
export interface Telemetry {
  /** Latency percentiles (globally or per handler, optionally filtered by time). */
  getLatency(params?: TimeFilter): LatencyStats;

  /** Error rate (globally or per handler, optionally filtered by time). */
  getErrorRate(params?: TimeFilter): ErrorRateStats;

  /** Slowest executions (with full observed context). */
  getSlowest(params: LimitFilter): readonly HandlerEvent[];

  /** Recent errors (with full observed context). */
  getErrors(params: LimitFilter): readonly HandlerEvent[];

  /** Per-handler breakdown of stats. */
  getHandlerStats(): readonly HandlerStats[];

  /** Retry frequency (which handlers are retrying most). */
  getRetryStats(): readonly RetryStats[];
}

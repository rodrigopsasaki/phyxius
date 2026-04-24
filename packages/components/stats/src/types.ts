import type { Instant } from "@phyxiusjs/clock";

// ── Snapshot ──────────────────────────────────────────────────────────────

/**
 * What we know about a handler's recent behavior, right now. Snapshots are
 * values — immutable, serializable, safe to pass around. Compute one on
 * demand, expose it via a health endpoint, persist it to a timeseries
 * store, or just `console.log(stats.snapshot("order.process"))` during an
 * incident.
 *
 * "Recent" is defined by the ring buffer's `windowSize` — the last N
 * invocations, not the last N seconds. This is a deliberate choice:
 * time-windowed stats require a wall clock and introduce subtle bugs
 * around clock skew and idle periods. Sample-windowed stats are
 * deterministic and honest about what they measure.
 */
export interface HandlerSnapshot {
  readonly name: string;
  /** Total invocations ever observed (unbounded counter, for rate derivation). */
  readonly lifetimeCount: number;
  /** Total failures ever observed. */
  readonly lifetimeFailures: number;
  /** Number of samples currently in the window. <= windowSize. */
  readonly windowSize: number;
  /** Failures / window size. Zero when the window is empty. */
  readonly errorRate: number;
  /** Duration percentiles, computed from the current window. */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

// ── Thresholds ────────────────────────────────────────────────────────────

/**
 * A declarative alert policy for a single handler. Any property you omit
 * is simply not checked. A breach emits `stats:threshold-breached`; a
 * recovery (breach cleared on the next update) emits
 * `stats:threshold-recovered`. Both are edge-triggered, not level-
 * triggered — you get one event per state change, not one per update.
 */
export interface HandlerThreshold {
  /** Alert when error rate exceeds this fraction (e.g. 0.05 = 5%). */
  readonly errorRate?: number;
  /** Alert when p50 exceeds this many milliseconds. */
  readonly p50Ms?: number;
  /** Alert when p95 exceeds this many milliseconds. */
  readonly p95Ms?: number;
  /** Alert when p99 exceeds this many milliseconds. */
  readonly p99Ms?: number;
}

/** Which specific field crossed its limit. */
export type ThresholdField = "errorRate" | "p50Ms" | "p95Ms" | "p99Ms";

// ── Events ────────────────────────────────────────────────────────────────

/**
 * Events emitted by the stats instance. Wire `emit` into your journal
 * and every threshold state change shows up alongside your regular
 * observability stream.
 */
export type StatsEvent =
  | {
      readonly type: "stats:threshold-breached";
      readonly handler: string;
      readonly field: ThresholdField;
      readonly value: number;
      readonly limit: number;
      readonly at: Instant;
    }
  | {
      readonly type: "stats:threshold-recovered";
      readonly handler: string;
      readonly field: ThresholdField;
      readonly value: number;
      readonly limit: number;
      readonly at: Instant;
    };

// ── Public instance ──────────────────────────────────────────────────────

/**
 * A live stats tracker. Subscribes to a journal of `HandlerEvent`s on
 * construction; maintains per-handler ring buffers of durations and
 * outcomes; evaluates thresholds on every update (edge-triggered, no
 * polling needed).
 */
export interface Stats {
  /** Current snapshot for a handler. Returns `null` if no events for it yet. */
  snapshot(handlerName: string): HandlerSnapshot | null;

  /** Snapshot for every handler that has produced at least one event. */
  snapshotAll(): ReadonlyArray<HandlerSnapshot>;

  /** Stop subscribing. Idempotent. */
  stop(): void;
}

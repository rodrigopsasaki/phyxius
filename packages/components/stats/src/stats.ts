import type { Clock } from "@phyxiusjs/clock";
import type { HandlerEvent } from "@phyxiusjs/handler";
import type { Journal } from "@phyxiusjs/journal";

import { summarize } from "./percentiles.js";
import type { HandlerSnapshot, HandlerThreshold, Stats, StatsEvent, ThresholdField } from "./types.js";

// ── Breach state ────────────────────────────────────────────────────────────

/**
 * The breach lifecycle for a single (handler, field) pair, named explicitly
 * instead of inferred from `limit`/`isBreaching`/`wasBreaching` compared
 * inline at each call site.
 *
 *  - `not-monitored` — no limit configured for this field. Nothing to check.
 *  - `ok`             — under the limit, and wasn't breaching before. Steady state.
 *  - `breach-active`  — still over the limit from a prior update. Edge-triggered:
 *    no new event, the alert already fired on entry.
 *  - `breach-entered` — just crossed over the limit. Emits `stats:threshold-breached`.
 *  - `recovered`      — was breaching, now back under the limit. Emits
 *    `stats:threshold-recovered`.
 *
 * `breach-entered` and `recovered` carry `limit` themselves — the type says
 * "this state only exists when a limit was configured," so the emitting code
 * never has to re-check `limit !== undefined`.
 */
type BreachState =
  | { readonly kind: "not-monitored" }
  | { readonly kind: "ok" }
  | { readonly kind: "breach-active" }
  | { readonly kind: "breach-entered"; readonly limit: number }
  | { readonly kind: "recovered"; readonly limit: number };

/**
 * Pure classification: map the prior breach state plus the current
 * value-vs-limit comparison to a named `BreachState`. No mutation, no
 * emission — `commitBreach` acts on the result once. Same classify/commit
 * split as `classifyFlush`/`flushBuffer` in the drain package and
 * `classify`/`execute` in the circuit breaker.
 */
function classifyBreach(wasBreaching: boolean, value: number, limit: number | undefined): BreachState {
  if (limit === undefined) return { kind: "not-monitored" };

  const isBreaching = value > limit;

  if (isBreaching && wasBreaching) return { kind: "breach-active" };
  if (isBreaching) return { kind: "breach-entered", limit };
  if (wasBreaching) return { kind: "recovered", limit };
  return { kind: "ok" };
}

// ── Public: createStats ────────────────────────────────────────────────────

/**
 * Build a live stats tracker over a journal of `HandlerEvent`s. The tracker
 * subscribes on construction and maintains per-handler ring buffers of
 * recent durations and outcomes. Snapshots are computed on demand;
 * thresholds are evaluated on every event (edge-triggered alerts).
 *
 * Memory is bounded by construction: `windowSize * number-of-handlers`
 * doubles (numbers + outcome tags), plus two integers per handler. For
 * `windowSize: 1000` and 50 handlers, that's ~80KB — negligible for any
 * real service.
 */
export function createStats(options: {
  readonly journal: Journal<HandlerEvent>;
  readonly clock: Clock;
  /** Ring buffer size per handler. Default: 1000. */
  readonly windowSize?: number;
  /** Per-handler alerting thresholds. Handlers without an entry aren't checked. */
  readonly thresholds?: Readonly<Record<string, HandlerThreshold>>;
  /** Sink for threshold-breached / threshold-recovered events. */
  readonly emit?: (event: StatsEvent) => void;
}): Stats {
  const { journal, clock, windowSize = 1000, thresholds = {}, emit } = options;

  if (windowSize <= 0) {
    throw new Error(`Stats windowSize must be > 0 (got ${windowSize})`);
  }

  // Per-handler rolling state. Kept as a plain Map so lookups are cheap.
  interface HandlerBuffer {
    durations: number[]; // ring buffer
    outcomes: boolean[]; // ring buffer, true = success
    writeIndex: number; // next slot to write
    filled: number; // how many slots are populated (<= windowSize)
    lifetimeCount: number;
    lifetimeFailures: number;
    breaching: Set<ThresholdField>; // fields currently in breach state
  }

  const buffers = new Map<string, HandlerBuffer>();

  function getOrCreate(name: string): HandlerBuffer {
    let b = buffers.get(name);
    if (!b) {
      b = {
        durations: new Array(windowSize),
        outcomes: new Array(windowSize),
        writeIndex: 0,
        filled: 0,
        lifetimeCount: 0,
        lifetimeFailures: 0,
        breaching: new Set(),
      };
      buffers.set(name, b);
    }
    return b;
  }

  function snapshotOf(name: string, b: HandlerBuffer): HandlerSnapshot {
    const samples = b.durations.slice(0, b.filled);
    const stats = summarize(samples);

    const windowFailures = b.outcomes.slice(0, b.filled).filter((ok) => !ok).length;
    const errorRate = b.filled === 0 ? 0 : windowFailures / b.filled;

    return {
      name,
      lifetimeCount: b.lifetimeCount,
      lifetimeFailures: b.lifetimeFailures,
      windowSize: b.filled,
      errorRate,
      p50Ms: stats.p50,
      p95Ms: stats.p95,
      p99Ms: stats.p99,
      minMs: stats.min,
      maxMs: stats.max,
      meanMs: stats.mean,
    };
  }

  function evaluateThresholds(handler: string, buf: HandlerBuffer, snap: HandlerSnapshot): void {
    const threshold = thresholds[handler];
    if (!threshold) return;

    const checks: ReadonlyArray<{
      field: ThresholdField;
      value: number;
      limit: number | undefined;
    }> = [
      { field: "errorRate", value: snap.errorRate, limit: threshold.errorRate },
      { field: "p50Ms", value: snap.p50Ms, limit: threshold.p50Ms },
      { field: "p95Ms", value: snap.p95Ms, limit: threshold.p95Ms },
      { field: "p99Ms", value: snap.p99Ms, limit: threshold.p99Ms },
    ];

    for (const { field, value, limit } of checks) {
      const state = classifyBreach(buf.breaching.has(field), value, limit);
      commitBreach(handler, field, value, buf, state);
    }
  }

  // ── Breach commitment ───────────────────────────────────────────────────

  /**
   * Action — consumes a classified `BreachState`; never re-derives it from
   * `buf.breaching` or the value/limit comparison. Owns the `breaching` set
   * mutation and the emitted event, one branch per named state so a state
   * added later can't silently fall through unhandled.
   */
  function commitBreach(
    handler: string,
    field: ThresholdField,
    value: number,
    buf: HandlerBuffer,
    state: BreachState,
  ): void {
    switch (state.kind) {
      case "not-monitored":
      case "ok":
      case "breach-active":
        return;
      case "breach-entered":
        buf.breaching.add(field);
        emit?.({
          type: "stats:threshold-breached",
          handler,
          field,
          value,
          limit: state.limit,
          at: clock.now(),
        });
        return;
      case "recovered":
        buf.breaching.delete(field);
        emit?.({
          type: "stats:threshold-recovered",
          handler,
          field,
          value,
          limit: state.limit,
          at: clock.now(),
        });
        return;
    }
  }

  // ── Subscription ────────────────────────────────────────────────────────

  let stopped = false;
  const unsubscribe = journal.subscribe((entry) => {
    if (stopped) return;

    const event = entry.data;
    const buf = getOrCreate(event.name);

    // Record the event. Ring buffer: overwrite the oldest slot.
    buf.durations[buf.writeIndex] = event.durationMs;
    buf.outcomes[buf.writeIndex] = event.outcome === "success";
    buf.writeIndex = (buf.writeIndex + 1) % windowSize;
    if (buf.filled < windowSize) buf.filled += 1;

    buf.lifetimeCount += 1;
    if (event.outcome === "failure") buf.lifetimeFailures += 1;

    // Edge-triggered threshold evaluation. Cheap: sort of <=windowSize
    // numbers, once. For windowSize=1000 that's ~50µs on modern hardware.
    const snap = snapshotOf(event.name, buf);
    evaluateThresholds(event.name, buf, snap);
  });

  // ── Public instance ─────────────────────────────────────────────────────

  return {
    snapshot(name) {
      const b = buffers.get(name);
      if (!b || b.lifetimeCount === 0) return null;
      return snapshotOf(name, b);
    },
    snapshotAll() {
      const out: HandlerSnapshot[] = [];
      for (const [name, buf] of buffers) {
        if (buf.lifetimeCount > 0) out.push(snapshotOf(name, buf));
      }
      return out;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
}

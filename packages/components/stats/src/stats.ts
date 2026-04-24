import type { Clock } from "@phyxiusjs/clock";
import type { HandlerEvent } from "@phyxiusjs/handler";
import type { Journal } from "@phyxiusjs/journal";

import { summarize } from "./percentiles.js";
import type { HandlerSnapshot, HandlerThreshold, Stats, StatsEvent, ThresholdField } from "./types.js";

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
      if (limit === undefined) continue;

      const wasBreaching = buf.breaching.has(field);
      const isBreaching = value > limit;

      if (isBreaching && !wasBreaching) {
        buf.breaching.add(field);
        emit?.({
          type: "stats:threshold-breached",
          handler,
          field,
          value,
          limit,
          at: clock.now(),
        });
      } else if (!isBreaching && wasBreaching) {
        buf.breaching.delete(field);
        emit?.({
          type: "stats:threshold-recovered",
          handler,
          field,
          value,
          limit,
          at: clock.now(),
        });
      }
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

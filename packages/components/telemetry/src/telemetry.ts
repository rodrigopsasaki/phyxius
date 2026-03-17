import type { HandlerEvent } from "@phyxiusjs/handler";
import type {
  Telemetry,
  TelemetryConfig,
  TimeFilter,
  LimitFilter,
  LatencyStats,
  ErrorRateStats,
  HandlerStats,
  RetryStats,
} from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the value at a given percentile (0-100) from a sorted array.
 * Uses the nearest-rank method.
 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

/**
 * Filter journal entries by optional handler name and time window.
 */
function filterEvents(
  events: readonly HandlerEvent[],
  params?: TimeFilter,
): readonly HandlerEvent[] {
  if (!params) return events;

  return events.filter((e) => {
    if (params.handlerName && e.handlerName !== params.handlerName) return false;
    if (params.since && e.completedAt.monoMs < params.since.monoMs) return false;
    return true;
  });
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Telemetry instance that queries a Journal of HandlerEvents.
 *
 * All methods are pure computations over `journal.getSnapshot()` — each call
 * reads the latest data. No caching, no stale state.
 *
 * @example
 * const telemetry = createTelemetry({ journal, clock });
 * const latency = telemetry.getLatency({ handlerName: "user.lookup" });
 * console.log(`P95: ${latency.p95}ms`);
 */
export function createTelemetry(config: TelemetryConfig): Telemetry {
  const { journal } = config;

  function getEntries(): readonly HandlerEvent[] {
    return journal.getSnapshot().entries.map((e) => e.data);
  }

  const telemetry: Telemetry = {
    getLatency(params?: TimeFilter): LatencyStats {
      const events = filterEvents(getEntries(), params);

      if (events.length === 0) {
        return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0 };
      }

      const durations = events.map((e) => e.durationMs).sort((a, b) => a - b);

      return {
        count: durations.length,
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        p99: percentile(durations, 99),
        max: durations[durations.length - 1]!,
        min: durations[0]!,
      };
    },

    getErrorRate(params?: TimeFilter): ErrorRateStats {
      const events = filterEvents(getEntries(), params);
      const total = events.length;
      const failed = events.filter((e) => e.outcome === "failure").length;

      return {
        total,
        failed,
        rate: total === 0 ? 0 : failed / total,
      };
    },

    getSlowest(params: LimitFilter): readonly HandlerEvent[] {
      let events = getEntries();

      if (params.since) {
        events = events.filter((e) => e.completedAt.monoMs >= params.since!.monoMs);
      }

      return [...events].sort((a, b) => b.durationMs - a.durationMs).slice(0, params.limit);
    },

    getErrors(params: LimitFilter): readonly HandlerEvent[] {
      let events = getEntries().filter((e) => e.outcome === "failure");

      if (params.since) {
        events = events.filter((e) => e.completedAt.monoMs >= params.since!.monoMs);
      }

      // Most recent first
      return [...events]
        .sort((a, b) => b.completedAt.monoMs - a.completedAt.monoMs)
        .slice(0, params.limit);
    },

    getHandlerStats(): readonly HandlerStats[] {
      const events = getEntries();

      // Group by handlerName
      const groups = new Map<string, HandlerEvent[]>();
      for (const event of events) {
        const existing = groups.get(event.handlerName);
        if (existing) {
          existing.push(event);
        } else {
          groups.set(event.handlerName, [event]);
        }
      }

      const stats: HandlerStats[] = [];
      for (const [handlerName, handlerEvents] of groups) {
        const total = handlerEvents.length;
        const failed = handlerEvents.filter((e) => e.outcome === "failure").length;
        const durations = handlerEvents.map((e) => e.durationMs).sort((a, b) => a - b);

        // Find most recent execution
        let lastExecutedAt = handlerEvents[0]!.completedAt;
        for (const e of handlerEvents) {
          if (e.completedAt.monoMs > lastExecutedAt.monoMs) {
            lastExecutedAt = e.completedAt;
          }
        }

        stats.push({
          handlerName,
          totalRequests: total,
          errorRate: total === 0 ? 0 : failed / total,
          p95: percentile(durations, 95),
          lastExecutedAt,
        });
      }

      // Sort by total requests descending
      return stats.sort((a, b) => b.totalRequests - a.totalRequests);
    },

    getRetryStats(): readonly RetryStats[] {
      const events = getEntries();

      // Group by handlerName
      const groups = new Map<string, HandlerEvent[]>();
      for (const event of events) {
        const existing = groups.get(event.handlerName);
        if (existing) {
          existing.push(event);
        } else {
          groups.set(event.handlerName, [event]);
        }
      }

      const stats: RetryStats[] = [];
      for (const [handlerName, handlerEvents] of groups) {
        // Only count events with attempts > 1 as retried
        const retriedEvents = handlerEvents.filter((e) => e.attempts > 1);
        const totalRetries = retriedEvents.reduce((sum, e) => sum + (e.attempts - 1), 0);
        const totalAttempts = handlerEvents.reduce((sum, e) => sum + e.attempts, 0);

        stats.push({
          handlerName,
          totalRetries,
          avgAttempts: handlerEvents.length === 0 ? 0 : totalAttempts / handlerEvents.length,
        });
      }

      // Sort by most retries first
      return stats.sort((a, b) => b.totalRetries - a.totalRetries);
    },
  };

  return telemetry;
}

import { ms } from "@phyxiusjs/clock";
import type { Drain, DrainEntry, DrainOptions, DrainOverflowPolicy } from "./types.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = ms(5000);
const DEFAULT_OVERFLOW: DrainOverflowPolicy = "drop_oldest";

/**
 * Creates a drain that subscribes to a journal and flushes entries to a sink
 * in batches — on the configured interval, when the batch threshold is reached,
 * or manually via `flush()`.
 *
 * Durability guarantees:
 *  - Sink errors are caught and the batch is re-queued at the buffer head for
 *    the next flush attempt. Transient failures recover automatically.
 *  - The buffer is bounded. If it fills (sink persistently failing, or a
 *    traffic spike outpacing the sink), the configured overflow policy
 *    applies and `drain:overflow` fires so failures are visible.
 *  - Clock-driven scheduling: flushes are paced by `clock.sleep`, not
 *    `setTimeout`, so drain is deterministic in tests with a controlled clock.
 */
export function createDrain<T>(options: DrainOptions<T>): Drain {
  const {
    journal,
    sink,
    clock,
    batchSize = DEFAULT_BATCH_SIZE,
    maxBufferSize = DEFAULT_MAX_BUFFER_SIZE,
    overflow = DEFAULT_OVERFLOW,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    filter,
    emit,
  } = options;

  if (maxBufferSize <= 0) {
    throw new Error(`Drain maxBufferSize must be > 0 (got ${maxBufferSize})`);
  }
  if (batchSize <= 0) {
    throw new Error(`Drain batchSize must be > 0 (got ${batchSize})`);
  }
  if (batchSize > maxBufferSize) {
    throw new Error(`Drain batchSize (${batchSize}) must be <= maxBufferSize (${maxBufferSize})`);
  }

  const buffer: DrainEntry<T>[] = [];
  let stopped = false;
  let flushing = false;

  // ── Ingress ──────────────────────────────────────────────────────────────

  const unsubscribe = journal.subscribe((entry) => {
    if (stopped) return;

    const drainEntry: DrainEntry<T> = {
      id: entry.id,
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      data: entry.data,
    };

    // Apply the optional sampling filter BEFORE any buffer work — dropped
    // entries should never consume buffer capacity. A throwing filter is
    // treated as a drop so a broken policy can't flood a downstream sink
    // it shouldn't have reached; the error is surfaced via events.
    if (filter) {
      let keep: boolean;
      try {
        keep = filter(drainEntry);
      } catch (cause) {
        emit?.({ type: "drain:filter-error", cause, at: clock.now() });
        return;
      }
      if (!keep) return;
    }

    if (buffer.length >= maxBufferSize) {
      if (overflow === "error") {
        emit?.({
          type: "drain:overflow",
          policy: overflow,
          maxBufferSize,
          droppedCount: 1,
          at: clock.now(),
        });
        return; // drop this new entry
      }

      // drop_oldest: evict the oldest to make room
      buffer.shift();
      emit?.({
        type: "drain:overflow",
        policy: overflow,
        maxBufferSize,
        droppedCount: 1,
        at: clock.now(),
      });
    }

    buffer.push(drainEntry);

    // Opportunistic immediate flush when the batch threshold is reached.
    if (buffer.length >= batchSize) {
      void flushBuffer();
    }
  });

  // ── Flush ────────────────────────────────────────────────────────────────

  async function flushBuffer(): Promise<void> {
    if (flushing || buffer.length === 0) return;

    flushing = true;
    const batch = buffer.splice(0, Math.min(batchSize, buffer.length));
    const startTime = clock.now();

    try {
      await sink.write(batch);

      const durationMs = clock.now().monoMs - startTime.monoMs;
      emit?.({
        type: "drain:flush",
        count: batch.length,
        durationMs,
        at: clock.now(),
      });
    } catch (error) {
      // Re-queue the batch at the head for the next flush attempt. Bounded
      // buffer + overflow policy are the safety net if the sink is persistently
      // failing — new entries will start overflowing and the operator sees it.
      buffer.unshift(...batch);
      emit?.({
        type: "drain:error",
        error,
        requeued: batch.length,
        at: clock.now(),
      });
    } finally {
      flushing = false;
    }
  }

  // ── Timer loop (Clock-driven, not setTimeout) ────────────────────────────

  async function runTimerLoop(): Promise<void> {
    if (flushIntervalMs <= 0) return; // periodic flush disabled

    while (!stopped) {
      await clock.sleep(flushIntervalMs);
      if (stopped) return;
      await flushBuffer();
    }
  }

  void runTimerLoop();

  // ── Public handle ────────────────────────────────────────────────────────

  return {
    async flush(): Promise<void> {
      // Drain everything currently buffered — may take multiple batches.
      while (buffer.length > 0 && !stopped) {
        const sizeBefore = buffer.length;
        await flushBuffer();
        // Guard against a persistently-failing sink: if the buffer didn't
        // shrink (batch was re-queued), stop trying to avoid a hot loop.
        if (buffer.length >= sizeBefore) break;
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;

      stopped = true;
      unsubscribe();

      // Final drain attempt — one batch, best effort.
      const remaining = buffer.length;
      await flushBuffer();

      emit?.({
        type: "drain:stop",
        remaining,
        at: clock.now(),
      });
    },
  };
}

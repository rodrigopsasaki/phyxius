import { ms, deadlineFrom, hasPassed, elapsedSince } from "@phyxiusjs/clock";
import type { Instant, Millis } from "@phyxiusjs/clock";
import type { Drain, DrainEntry, DrainOptions, DrainOverflowPolicy, FlushDecision, FlushState } from "./types.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = ms(5000);
const DEFAULT_BACKOFF_MS = ms(1000);
const DEFAULT_OVERFLOW: DrainOverflowPolicy = "drop_oldest";

/**
 * Creates a drain that subscribes to a journal and flushes entries to a sink
 * in batches — on the configured interval, when the batch threshold is reached,
 * or manually via `flush()`.
 *
 * Durability guarantees:
 *  - Sink errors are caught and the batch is re-queued at the buffer head for
 *    the next flush attempt. Transient failures recover automatically.
 *  - After a failure the flush enters `backoff` (see FlushState) for
 *    `backoffMs`, so a persistently-failing sink is retried on a paced
 *    schedule rather than in a hot requeue loop. A manual `flush()` forces
 *    past the backoff (a deliberate operator retry).
 *  - The buffer is bounded. If it fills (sink persistently failing, or a
 *    traffic spike outpacing the sink), the configured overflow policy
 *    applies and `drain:overflow` fires so failures are visible.
 *  - Clock-driven scheduling: flushes and backoff are paced by the injected
 *    clock, not `setTimeout`, so drain is deterministic under a controlled clock.
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
    backoffMs = DEFAULT_BACKOFF_MS,
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

  // The flush lifecycle, named (see FlushState). Was a bare `flushing`
  // boolean: it could not represent "the sink just failed, hold off," so a
  // re-queued batch was re-flushed immediately — a hot requeue loop until the
  // buffer overflowed. `backoff` makes that state representable and exits it
  // on a clock-paced deadline.
  let flushState: FlushState = { kind: "idle" };

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

  // Classification — a pure read of state/buffer/clock. No side effects, no
  // splice, no I/O. Separated from action so the "may we flush?" question has
  // one answer that every caller (opportunistic, timer, manual) shares, and
  // so the failure state is decided by name rather than re-derived inline.
  //
  // `force` is set only by the manual `flush()` handle: an operator asking to
  // flush now is a deliberate "try anyway," so it bypasses a backoff hold (but
  // never the `flushing` guard — that protects the in-flight splice/write).
  // The automatic paths (opportunistic, timer) never force, so the hot requeue
  // loop they used to spin is what backoff actually paces.
  function classifyFlush(force: boolean): FlushDecision {
    if (buffer.length === 0) return { action: "skip", reason: "empty" };
    switch (flushState.kind) {
      case "flushing":
        return { action: "skip", reason: "flushing" };
      case "backoff":
        return force || hasPassed(clock.now().monoMs, flushState.until.monoMs)
          ? { action: "proceed" }
          : { action: "skip", reason: "backoff" };
      case "idle":
        return { action: "proceed" };
    }
  }

  // The write currently in the sink, held so shutdown can await it. Without
  // this handle `stop()` could only ask `classifyFlush`, which skips while
  // `flushing` holds, because `force` bypasses a backoff hold and never a live
  // write. That gap meant a shutdown racing a flush skipped its own final
  // drain and dropped whatever had arrived meanwhile, silently.
  let inFlight: Promise<void> | null = null;

  // Action — consumes a decision; never re-derives it. Owns the splice, the
  // sink write, and the state transition (idle → flushing → idle | backoff).
  async function flushBuffer(force = false): Promise<void> {
    if (classifyFlush(force).action !== "proceed") return;

    const run = writeOneBatch();
    inFlight = run;
    try {
      await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  // The splice-and-write itself. Split out of `flushBuffer` only so the
  // promise above is capturable; its synchronous prefix still sets `flushing`
  // before the first await, so a concurrent caller sees the state it must.
  async function writeOneBatch(): Promise<void> {
    flushState = { kind: "flushing" };
    const batch = buffer.splice(0, Math.min(batchSize, buffer.length));
    const startTime = clock.now();

    try {
      await sink.write(batch);

      const durationMs = elapsedSince(clock.now().monoMs, startTime.monoMs);
      flushState = { kind: "idle" };
      emit?.({
        type: "drain:flush",
        count: batch.length,
        durationMs,
        at: clock.now(),
      });
    } catch (error) {
      // Re-queue the batch at the head for the next flush attempt, then enter
      // `backoff` so the next attempt is held until the deadline instead of
      // re-firing immediately. That hold is what turns the old hot requeue
      // loop into paced retries; the bounded buffer + overflow policy remain
      // the backstop if the sink stays down (entries overflow, operator sees).
      buffer.unshift(...batch);
      flushState = backoffMs > 0 ? { kind: "backoff", until: addMillis(clock.now(), backoffMs) } : { kind: "idle" };
      emit?.({
        type: "drain:error",
        error,
        requeued: batch.length,
        at: clock.now(),
      });
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
      // `force` bypasses a backoff hold: a manual flush is a deliberate retry.
      while (buffer.length > 0 && !stopped) {
        const sizeBefore = buffer.length;
        await flushBuffer(true);
        // Guard against a persistently-failing sink: if the buffer didn't
        // shrink (batch was re-queued), stop trying to avoid a hot loop.
        if (buffer.length >= sizeBefore) break;
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;

      stopped = true;
      unsubscribe();

      // A write already in the sink is part of this shutdown, so wait for it.
      // Skipping this is what made the "final drain" below a no-op whenever
      // stop() raced a flush.
      await inFlight;

      // Final drain: every batch, not one. `stop()` promises to flush what is
      // buffered; flushing a single batch kept that promise only when the
      // buffer happened to fit in one. Same no-progress guard `flush()` uses:
      // a failing sink re-queues its batch, and one non-shrinking pass ends
      // the attempt rather than spinning.
      while (buffer.length > 0) {
        const sizeBefore = buffer.length;
        await flushBuffer(true);
        if (buffer.length >= sizeBefore) break;
      }

      // What shutdown could NOT deliver, not what it happened to be holding
      // when it began. The old value was the pre-drain buffer size, so a clean
      // shutdown that delivered every entry still announced a non-zero
      // `remaining`, reading as loss that had not occurred.
      emit?.({
        type: "drain:stop",
        remaining: buffer.length,
        at: clock.now(),
      });
    },
  };
}

/**
 * A deadline `delta` milliseconds after `from`, advancing both clock faces so
 * the result is comparable under either a system or a controlled clock — the
 * same shape `sleep`/`timeout` use internally. Local because the drain is the
 * only place that needs Instant arithmetic; if a second caller appears, this
 * moves up to @phyxiusjs/clock. The `monoMs` face goes through `deadlineFrom`
 * — @phyxiusjs/clock's own answer for "the only addition that means anything
 * for a MonoMs" — rather than `from.monoMs + delta`, which still compiles
 * (TypeScript doesn't check brands on `+`) but returns a bare `number` that
 * no longer satisfies `Instant`'s `monoMs: MonoMs` field, exactly the way a
 * hand-rolled version of this helper would have failed here.
 */
function addMillis(from: Instant, delta: Millis): Instant {
  return { wallMs: from.wallMs + delta, monoMs: deadlineFrom(from.monoMs, delta) };
}

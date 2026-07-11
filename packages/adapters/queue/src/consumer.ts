import { ms, sleepOrAbort, type Clock, type Millis } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { HandlerError, RunningHandler } from "@phyxiusjs/handler";

import { defaultOnResult } from "./encode.js";
import type {
  MessageSource,
  NackReason,
  QueueConsumer,
  QueueConsumerOptions,
  QueueConsumerStatus,
  QueueMessage,
  QueueOutcome,
} from "./types.js";

// ── Receive backoff ─────────────────────────────────────────────────────────
//
// `source.receive()` throwing (not returning null) means the source itself
// is unhealthy — a dead connection, an unreachable broker. Retrying it
// immediately in a `while` loop burns CPU against something that isn't
// going to recover in the next tick. Distinct from a source's own
// empty/idle backoff (its job, per MessageSource's contract) — this is the
// consumer's backoff on the source failing outright.

const RECEIVE_BACKOFF_INITIAL_MS = ms(100);
const RECEIVE_BACKOFF_MAX_MS = ms(30_000);
const RECEIVE_BACKOFF_FACTOR = 2;

/**
 * Delay before the next receive attempt, given the number of consecutive
 * failures (1-based — includes the failure that just happened). Doubles
 * each time starting from RECEIVE_BACKOFF_INITIAL_MS, capped at
 * RECEIVE_BACKOFF_MAX_MS. Resets to attempt 1 the moment receive() succeeds.
 */
function receiveBackoffDelay(consecutiveFailures: number): Millis {
  const delay = RECEIVE_BACKOFF_INITIAL_MS * Math.pow(RECEIVE_BACKOFF_FACTOR, consecutiveFailures - 1);
  return Math.min(delay, RECEIVE_BACKOFF_MAX_MS) as Millis;
}

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * Build a queue consumer. The consumer pulls messages from `source`,
 * dispatches each to `handler.invoke`, and maps the result to ack / nack
 * via `onResult` (default: {@link defaultOnResult}).
 *
 * One consumer = one source + one handler. The handler owns all stability
 * concerns (timeout, retry, circuit breaker, concurrency). The consumer
 * owns pull rhythm, in-flight accounting, and the ack/nack translation.
 *
 * Requires an injected Clock so the consumer's own timing is deterministic
 * in tests — same Clock contract as the rest of Phyxius.
 */
export function createQueueConsumer<TInput, TOutput>(
  options: QueueConsumerOptions<TInput, TOutput> & { readonly clock: Clock },
): QueueConsumer {
  const { source, handler, decode, onResult = defaultOnResult, maxConcurrent = 1, emit, clock } = options;

  if (maxConcurrent < 1) {
    throw new Error(`QueueConsumer maxConcurrent must be >= 1 (got ${maxConcurrent})`);
  }

  let status: QueueConsumerStatus = "idle";
  let loop: Promise<void> | null = null;
  const abortController = new AbortController();
  const inFlight = new Set<Promise<void>>();

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (status !== "idle") return;
    status = "running";
    emit?.({ type: "queue:started", at: clock.now() });
    loop = runLoop();
  }

  async function stop(): Promise<void> {
    if (status === "idle" || status === "stopped") {
      status = "stopped";
      return;
    }
    if (status === "stopping") {
      // Another caller already started the drain; wait on the loop.
      await loop;
      return;
    }

    status = "stopping";
    abortController.abort();

    // Wake any blocked receive() on the source, then wait for the loop.
    await source.close?.().catch(() => {
      // Source close is best-effort.
    });
    await loop;

    const remaining = inFlight.size;
    await Promise.allSettled([...inFlight]);

    status = "stopped";
    emit?.({ type: "queue:stopped", at: clock.now(), inFlightAtStop: remaining });
  }

  // ── Main loop ──────────────────────────────────────────────────────────

  // Consecutive source.receive() failures since the last success. Drives
  // the backoff delay; reset to 0 the instant receive() succeeds (message
  // or idle-null both count — only a throw is a failure).
  let consecutiveReceiveFailures = 0;

  async function runLoop(): Promise<void> {
    try {
      while (status === "running") {
        // Wait for a slot if we're at the in-flight cap. Promise.race
        // gives us the natural "wake when any one finishes" behavior.
        if (inFlight.size >= maxConcurrent) {
          await Promise.race(inFlight).catch(() => {
            // Individual processMessage never rejects — it catches and nacks.
          });
          continue;
        }

        let message: QueueMessage | null = null;
        try {
          message = await source.receive(abortController.signal);
          consecutiveReceiveFailures = 0;
        } catch (cause) {
          consecutiveReceiveFailures += 1;
          emit?.({
            type: "queue:receive_error",
            at: clock.now(),
            cause,
            consecutiveFailures: consecutiveReceiveFailures,
          });
          // Return value ignored: whether the wait completed or the signal
          // won, the loop's own `status` check on the next iteration is
          // what decides whether to keep going.
          await sleepOrAbort(clock, receiveBackoffDelay(consecutiveReceiveFailures), abortController.signal);
          continue;
        }

        if (!message) {
          // Idle / aborted — loop re-checks status.
          continue;
        }

        // Fire-and-track. The promise is removed from the set when it settles.
        const promise = processMessage(message);
        inFlight.add(promise);
        promise.finally(() => {
          inFlight.delete(promise);
        });
      }
    } catch {
      // The loop itself should never throw — every source call is guarded.
      // Belt-and-suspenders: fall through to the stopped state.
    }
  }

  // ── Per-message flow ───────────────────────────────────────────────────

  async function processMessage(message: QueueMessage): Promise<void> {
    // Decode. A decode throw means the message is structurally wrong for
    // this consumer — DLQ it so it doesn't re-deliver forever.
    let input: TInput;
    try {
      input = decode(message);
    } catch (cause) {
      emit?.({ type: "queue:decode_error", at: clock.now(), messageId: message.id, cause });
      await safeNack(message, { type: "dead-letter", cause: "decode_error" });
      return;
    }

    // Invoke. This never throws — the handler returns a Result. Correlation
    // ID flows from the message so a queue-to-queue hop remains linked in
    // the journal.
    const invokeMeta: Parameters<RunningHandler<TInput, TOutput>["invoke"]>[1] = {
      source: "queue",
      context: {
        messageId: message.id,
        deliveryCount: message.deliveryCount ?? 1,
        ...(message.metadata ?? {}),
      },
    };
    // Headers may include an upstream x-correlation-id; otherwise default to
    // the broker's message ID so every invocation has a correlationId.
    const correlationId = message.headers?.["x-correlation-id"] ?? message.headers?.["correlation-id"] ?? message.id;
    if (correlationId !== undefined) {
      (invokeMeta as { correlationId?: string }).correlationId = correlationId;
    }

    const result: Result<TOutput, HandlerError> = await handler.invoke(input, invokeMeta);

    const outcome: QueueOutcome = safeOnResult(result, message);
    if (outcome.action === "ack") {
      await safeAck(message);
    } else {
      await safeNack(message, outcome.reason);
    }
  }

  /**
   * Settlement is decided by the handler's Result, never by whether the
   * (possibly caller-supplied) `onResult` observer behaves. A throwing
   * `onResult` is journaled and falls back to `defaultOnResult` — the
   * ack/nack decision it would have gotten with no override at all —
   * so an observer bug can never strand a message unacked.
   */
  function safeOnResult(result: Result<TOutput, HandlerError>, message: QueueMessage): QueueOutcome {
    try {
      return onResult(result, message);
    } catch (cause) {
      emit?.({ type: "queue:on_result_error", at: clock.now(), messageId: message.id, cause });
      return defaultOnResult(result, message);
    }
  }

  async function safeAck(message: QueueMessage): Promise<void> {
    try {
      await source.ack(message);
    } catch (cause) {
      emit?.({ type: "queue:ack_error", at: clock.now(), messageId: message.id, cause });
    }
  }

  async function safeNack(message: QueueMessage, reason: NackReason): Promise<void> {
    try {
      await source.nack(message, reason);
    } catch (cause) {
      emit?.({ type: "queue:nack_error", at: clock.now(), messageId: message.id, cause });
    }
  }

  // ── Handle ─────────────────────────────────────────────────────────────

  return {
    start,
    stop,
    getStatus: () => status,
    getInFlight: () => inFlight.size,
  };
}

// Exported for ergonomics — callers may want to compose with custom sources.
export type { MessageSource };

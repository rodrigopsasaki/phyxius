import type { Clock } from "@phyxiusjs/clock";

import type { MessageSource, NackReason, QueueMessage } from "./types.js";

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * A deterministic, in-memory `MessageSource` for tests and local development.
 * Not for production — no persistence, no redelivery on crash, no
 * distributed coordination. It exists to:
 *
 *   1. Drive consumer tests without standing up a real broker.
 *   2. Serve as the reference implementation new broker adapters can compare
 *      their semantics against.
 *
 * The test-only surface is exposed via the returned `MemoryQueue` handle —
 * `enqueue`, `getPending`, `getDeadLettered`, etc. Normal consumer code sees
 * only the `MessageSource` shape.
 */
export interface MemoryQueue extends MessageSource {
  // ── Production-shaped methods (inherited from MessageSource) ────────────

  // ── Test-shaped methods ─────────────────────────────────────────────────

  /**
   * Enqueue a message. Assigns an ID and receivedAt timestamp if not given.
   * The first waiting `receive()` resolves with this message; otherwise it
   * sits in the pending queue.
   */
  enqueue(message: Partial<QueueMessage> & { body: unknown }): QueueMessage;

  /** Messages waiting to be received. */
  getPending(): ReadonlyArray<QueueMessage>;

  /** Messages currently being processed (received, not yet ack'd or nack'd). */
  getInFlight(): ReadonlyArray<QueueMessage>;

  /** Messages nack'd with `{ type: "dead-letter" }`. */
  getDeadLettered(): ReadonlyArray<{ readonly message: QueueMessage; readonly cause: string }>;

  /** Every nack decision seen by this source (for deep assertions). */
  getNackHistory(): ReadonlyArray<{ readonly message: QueueMessage; readonly reason: NackReason }>;

  /** Every ack decision seen by this source. */
  getAckHistory(): ReadonlyArray<QueueMessage>;
}

export interface MemorySourceOptions {
  readonly clock: Clock;
  /**
   * How long `receive()` blocks when the queue is empty before returning
   * `null`. Default: infinity (pure signal-driven). Set to a finite value
   * for tests that want to probe the idle path.
   */
  readonly idleTimeoutMs?: number;
}

export function createMemorySource(options: MemorySourceOptions): MemoryQueue {
  const { clock, idleTimeoutMs } = options;

  const pending: QueueMessage[] = [];
  const inFlight = new Map<string, QueueMessage>();
  const deadLettered: { message: QueueMessage; cause: string }[] = [];
  const nackHistory: { message: QueueMessage; reason: NackReason }[] = [];
  const ackHistory: QueueMessage[] = [];

  // Resolver for the currently blocked receive(), if any. At most one at a
  // time — receive is called sequentially by the consumer loop.
  let pendingResolver: ((message: QueueMessage | null) => void) | null = null;
  let pendingSignal: AbortSignal | undefined;
  let pendingAbortHandler: (() => void) | undefined;
  let nextId = 1;

  function idFor(): string {
    return `msg-${nextId++}`;
  }

  function deliver(message: QueueMessage): boolean {
    if (!pendingResolver) return false;
    const resolver = pendingResolver;
    pendingResolver = null;
    clearPendingSignal();
    inFlight.set(message.id, message);
    resolver(message);
    return true;
  }

  /**
   * If a receive() is blocked and there's a pending message, deliver the
   * oldest pending message to it. Safe to call when either or both are
   * absent — it's a no-op.
   */
  function maybeDeliverNext(): void {
    if (!pendingResolver || pending.length === 0) return;
    const next = pending.shift() as QueueMessage;
    deliver(next);
  }

  function clearPendingSignal(): void {
    if (pendingSignal && pendingAbortHandler) {
      pendingSignal.removeEventListener("abort", pendingAbortHandler);
    }
    pendingSignal = undefined;
    pendingAbortHandler = undefined;
  }

  return {
    // ── MessageSource ────────────────────────────────────────────────────

    async receive(signal?: AbortSignal): Promise<QueueMessage | null> {
      if (signal?.aborted) return null;

      // Fast path: queue has messages.
      const next = pending.shift();
      if (next) {
        inFlight.set(next.id, next);
        return next;
      }

      // Slow path: block until enqueue, abort, or idle timeout.
      return new Promise<QueueMessage | null>((resolve) => {
        pendingResolver = resolve;
        pendingSignal = signal;

        if (signal) {
          pendingAbortHandler = () => {
            if (pendingResolver === resolve) {
              pendingResolver = null;
              clearPendingSignal();
              resolve(null);
            }
          };
          signal.addEventListener("abort", pendingAbortHandler, { once: true });
        }

        if (idleTimeoutMs !== undefined && idleTimeoutMs >= 0) {
          const timer = clock.timeout(idleTimeoutMs as never);
          void clock
            .deadline(timer.deadline)
            .then(() => {
              if (pendingResolver === resolve) {
                pendingResolver = null;
                clearPendingSignal();
                resolve(null);
              }
            })
            .catch(() => {
              // Deadline cancelled — nothing to do.
            })
            .finally(() => {
              timer.release();
            });
        }
      });
    },

    async ack(message: QueueMessage): Promise<void> {
      inFlight.delete(message.id);
      ackHistory.push(message);
    },

    async nack(message: QueueMessage, reason: NackReason): Promise<void> {
      inFlight.delete(message.id);
      nackHistory.push({ message, reason });

      if (reason.type === "dead-letter") {
        deadLettered.push({ message, cause: reason.cause });
        return;
      }

      const requeued: QueueMessage = {
        ...message,
        deliveryCount: (message.deliveryCount ?? 1) + 1,
      };

      if (reason.type === "requeue-now") {
        // Put at the head so the next receive picks it up first. Yield a
        // macrotask before delivering — real brokers always interleave
        // network/disk I/O between nack and redelivery. Doing it here
        // matches that shape and prevents tight-loop retry cycles from
        // starving the event loop when a consumer and a source share a
        // process.
        pending.unshift(requeued);
        setImmediate(maybeDeliverNext);
        return;
      }

      // retry — delayMs is honored via the clock when provided.
      const { delayMs } = reason;
      if (delayMs !== undefined && delayMs > 0) {
        const timer = clock.timeout(delayMs);
        void clock
          .deadline(timer.deadline)
          .then(() => {
            pending.push(requeued);
            maybeDeliverNext();
          })
          .catch(() => {
            // Deadline cancelled — drop the requeue.
          })
          .finally(() => {
            timer.release();
          });
      } else {
        pending.push(requeued);
        // Same macrotask yield as requeue-now.
        setImmediate(maybeDeliverNext);
      }
    },

    async close(): Promise<void> {
      // Wake any blocked receive() so the consumer's stop() can progress.
      if (pendingResolver) {
        const resolver = pendingResolver;
        pendingResolver = null;
        clearPendingSignal();
        resolver(null);
      }
    },

    // ── Test helpers ─────────────────────────────────────────────────────

    enqueue(partial): QueueMessage {
      const message: QueueMessage = {
        id: partial.id ?? idFor(),
        body: partial.body,
        receivedAt: partial.receivedAt ?? clock.now(),
        deliveryCount: partial.deliveryCount ?? 1,
        ...(partial.headers !== undefined ? { headers: partial.headers } : {}),
        ...(partial.metadata !== undefined ? { metadata: partial.metadata } : {}),
      };

      if (pendingResolver) {
        inFlight.set(message.id, message);
        const resolver = pendingResolver;
        pendingResolver = null;
        clearPendingSignal();
        resolver(message);
      } else {
        pending.push(message);
      }

      return message;
    },

    getPending() {
      return [...pending];
    },

    getInFlight() {
      return [...inFlight.values()];
    },

    getDeadLettered() {
      return [...deadLettered];
    },

    getNackHistory() {
      return [...nackHistory];
    },

    getAckHistory() {
      return [...ackHistory];
    },
  };
}

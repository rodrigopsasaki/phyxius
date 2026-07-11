import type { Instant, Millis } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { HandlerError, RunningHandler } from "@phyxiusjs/handler";

// ── Message ────────────────────────────────────────────────────────────────

/**
 * A message pulled from a broker. Brokers differ wildly in their native
 * shapes; this is the common denominator the consumer depends on. Adapters
 * for specific brokers (SQS, Redis, Kafka, RabbitMQ, ...) map their native
 * messages to this shape.
 */
export interface QueueMessage {
  /**
   * Broker-assigned message ID. Flows into the handler invocation as the
   * correlation ID so HTTP-to-queue traces remain linked when callers set
   * it deliberately; otherwise it's just a stable ID for this message.
   */
  readonly id: string;

  /**
   * The message payload. Usually a decoded object (the broker adapter
   * parses JSON / protobuf / etc. before handing to the consumer), but
   * can be anything — the route's `decode` function is the authority.
   */
  readonly body: unknown;

  /**
   * Headers/attributes/metadata from the broker. Lowercased keys by
   * convention, same shape as `HttpRequest.headers`.
   */
  readonly headers?: Readonly<Record<string, string>>;

  /** When the consumer received this message. Sourced from the clock. */
  readonly receivedAt: Instant;

  /**
   * How many times this message has been delivered (including this time).
   * 1 on first delivery. Brokers that don't track this may omit it.
   */
  readonly deliveryCount?: number;

  /**
   * Broker-specific extras (visibility timeout, receipt handle, partition,
   * offset, etc.). Threaded through unchanged for the source's ack / nack.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ── Nack shape ─────────────────────────────────────────────────────────────

/**
 * Why the consumer is refusing to accept a message. The source translates
 * these into broker-native operations (SQS ChangeMessageVisibility,
 * Redis XPENDING + XCLAIM, Kafka commit-offset skip, etc.).
 *
 * Sources that don't support a variant should approximate as closely as
 * possible — e.g. a broker without native delay can treat `{ type: "retry",
 * delayMs }` the same as `{ type: "retry" }`. Never throw from `nack`; the
 * consumer has already decided to surrender the message.
 */
export type NackReason =
  /** Transient failure. Return to the queue for redelivery, optionally delayed. */
  | { readonly type: "retry"; readonly delayMs?: Millis; readonly cause?: string }
  /** Terminal failure. Route to the dead-letter destination. Never retry. */
  | { readonly type: "dead-letter"; readonly cause: string }
  /** The consumer cannot take this message right now (overloaded, shutting down). Requeue immediately. */
  | { readonly type: "requeue-now"; readonly cause?: string };

// ── Message source ─────────────────────────────────────────────────────────

/**
 * The contract every broker adapter implements. Pull-based because any
 * push-based broker can be trivially wrapped in a pull interface; the
 * reverse coupling is much harder to undo.
 *
 * The consumer loop is:
 *
 *     while (running) {
 *       const msg = await source.receive(signal);
 *       if (!msg) continue;              // idle; loop to re-check running
 *       ...dispatch to handler...
 *     }
 *
 * A source is also responsible for its own flow-control — long-polling,
 * backoff on empty, connection recovery. The consumer trusts it.
 */
export interface MessageSource {
  /**
   * Pull the next available message. Should block (long-poll) until a
   * message is ready, or return `null` on idle timeout so the consumer
   * can re-check its running flag.
   *
   * When `signal` aborts, pending calls must resolve with `null` promptly
   * so `stop()` completes without hanging.
   */
  receive(signal?: AbortSignal): Promise<QueueMessage | null>;

  /** Acknowledge successful processing. Must be idempotent. */
  ack(message: QueueMessage): Promise<void>;

  /** Return the message to the queue / DLQ / etc. per `reason`. Must be idempotent. */
  nack(message: QueueMessage, reason: NackReason): Promise<void>;

  /**
   * Optional: graceful teardown (close connection, cancel subscription).
   * Called by the consumer's `stop()`.
   */
  close?(): Promise<void>;
}

// ── Consumer ───────────────────────────────────────────────────────────────

/**
 * What to do with a message once the handler has produced a result. The
 * consumer translates this into `source.ack` or `source.nack(..., reason)`.
 */
export type QueueOutcome = { readonly action: "ack" } | { readonly action: "nack"; readonly reason: NackReason };

/**
 * Consumer options. One consumer = one `source` + one `handler`. For
 * multiplexed brokers (same topic, multiple message types), either run
 * multiple consumers or discriminate inside `decode`.
 */
export interface QueueConsumerOptions<TInput, TOutput> {
  /** Message source — the broker adapter or test fixture. */
  readonly source: MessageSource;

  /** The handler every message will be dispatched to. */
  readonly handler: RunningHandler<TInput, TOutput>;

  /**
   * Decode the raw message into the handler's typed input. Throwing here
   * surfaces as an adapter-level failure — the message is nacked with a
   * dead-letter reason so it doesn't spin forever.
   */
  readonly decode: (message: QueueMessage) => TInput;

  /**
   * Optional: override the default Result → QueueOutcome mapping. If
   * omitted, `defaultOnResult` is used (see README for the full table).
   *
   * Settlement never depends on this callback behaving: if it throws, the
   * consumer journals a `queue:on_result_error` event and falls back to
   * `defaultOnResult` for that message rather than letting the throw
   * escape unacked/unnacked.
   */
  readonly onResult?: (result: Result<TOutput, HandlerError>, message: QueueMessage) => QueueOutcome;

  /**
   * Upper bound on messages the consumer will have in flight at once.
   * The handler has its own concurrency bounds; this controls how many
   * messages the consumer pulls off the source before waiting. Default: 1.
   *
   * Setting this higher than 1 enables parallel processing, but be aware
   * that the handler's `concurrency.max` is the real ceiling — messages
   * beyond it will be rejected with `BACKPRESSURE_REJECT` and nacked.
   */
  readonly maxConcurrent?: number;

  /** Optional: emitted on consumer lifecycle events for observability. */
  readonly emit?: (event: QueueConsumerEvent) => void;
}

/**
 * Consumer lifecycle events. Not journal events (those come from the handler).
 * These are the consumer's own operational surface — useful for metrics
 * and debugging but deliberately transport-specific and not part of the
 * transport-stable HandlerEvent stream.
 */
export type QueueConsumerEvent =
  | { readonly type: "queue:started"; readonly at: Instant }
  | { readonly type: "queue:stopped"; readonly at: Instant; readonly inFlightAtStop: number }
  | {
      readonly type: "queue:receive_error";
      readonly at: Instant;
      readonly cause: unknown;
      /** Consecutive receive() failures including this one — drives the backoff delay. */
      readonly consecutiveFailures: number;
    }
  | { readonly type: "queue:ack_error"; readonly at: Instant; readonly messageId: string; readonly cause: unknown }
  | { readonly type: "queue:nack_error"; readonly at: Instant; readonly messageId: string; readonly cause: unknown }
  | { readonly type: "queue:decode_error"; readonly at: Instant; readonly messageId: string; readonly cause: unknown }
  | {
      readonly type: "queue:on_result_error";
      readonly at: Instant;
      readonly messageId: string;
      readonly cause: unknown;
    };

export type QueueConsumerStatus = "idle" | "running" | "stopping" | "stopped";

/**
 * Running consumer handle. Start pulls the first message; stop drains
 * in-flight work up to the handler's own drain timeout.
 */
export interface QueueConsumer {
  /** Begin the consume loop. Resolves once the loop is running. */
  start(): Promise<void>;

  /**
   * Graceful stop. Stops pulling new messages, waits for in-flight work to
   * complete, then calls `source.close?()`. Safe to call repeatedly.
   */
  stop(): Promise<void>;

  /** Current lifecycle state. */
  getStatus(): QueueConsumerStatus;

  /** How many messages are currently being processed. */
  getInFlight(): number;
}

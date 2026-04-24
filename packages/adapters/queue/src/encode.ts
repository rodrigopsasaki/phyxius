import type { Millis } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { HandlerError } from "@phyxiusjs/handler";

import type { QueueMessage, QueueOutcome } from "./types.js";

/**
 * Default Result → QueueOutcome mapping. Maps every `HandlerError` variant
 * to a sensible ack/nack decision. Routes can override with `onResult`
 * for domain-specific policy (e.g. "ack on validation because we log it
 * upstream," or "DLQ on TIMEOUT because we already retried at the caller").
 *
 *   Ok(T)                       → ack
 *   VALIDATION_ERROR(input)     → nack dead-letter  ("will never succeed")
 *   VALIDATION_ERROR(output)    → nack dead-letter  ("our bug; the message is toxic for this version")
 *   TIMEOUT                     → nack retry
 *   HANDLER_ERROR               → nack retry
 *   RETRY_EXHAUSTED             → nack dead-letter  ("handler already retried internally")
 *   CIRCUIT_OPEN                → nack retry with delay = time-until-breaker-close
 *   BACKPRESSURE_REJECT         → nack requeue-now  ("full, another worker can take it")
 *   DROPPED                     → nack requeue-now  (same)
 *   HANDLER_NOT_RUNNING         → nack requeue-now  (shutting down; don't lose the message)
 *
 * The shape of this table is what makes the handler transport-stable: a
 * `TIMEOUT` becomes a 504 on HTTP and a retry on queue, but it's the same
 * typed error producing the same journal entry under the hood. One source
 * of truth for "what went wrong," different transport translations.
 */
export function defaultOnResult<T>(result: Result<T, HandlerError>, _message: QueueMessage): QueueOutcome {
  if (result._tag === "Ok") {
    return { action: "ack" };
  }

  const {error} = result;

  switch (error.type) {
    case "VALIDATION_ERROR":
      return {
        action: "nack",
        reason: {
          type: "dead-letter",
          cause: `validation:${error.target}`,
        },
      };

    case "TIMEOUT":
      return {
        action: "nack",
        reason: {
          type: "retry",
          cause: `timeout:${error.timeoutMs}ms`,
        },
      };

    case "HANDLER_ERROR":
      return {
        action: "nack",
        reason: { type: "retry", cause: "handler_error" },
      };

    case "RETRY_EXHAUSTED":
      return {
        action: "nack",
        reason: {
          type: "dead-letter",
          cause: `retry_exhausted:${error.attempts}`,
        },
      };

    case "CIRCUIT_OPEN": {
      // Delay until the breaker's expected half-open transition. Sources
      // that don't support delay treat this as a plain retry — no harm.
      const delayMs = Math.max(0, error.willRetryAfter - error.openedAt) as Millis;
      return {
        action: "nack",
        reason: {
          type: "retry",
          delayMs,
          cause: "circuit_open",
        },
      };
    }

    case "BACKPRESSURE_REJECT":
      return {
        action: "nack",
        reason: { type: "requeue-now", cause: "queue_full" },
      };

    case "DROPPED":
      return {
        action: "nack",
        reason: { type: "requeue-now", cause: "dropped" },
      };

    case "HANDLER_NOT_RUNNING":
      return {
        action: "nack",
        reason: { type: "requeue-now", cause: "shutting_down" },
      };
  }
}

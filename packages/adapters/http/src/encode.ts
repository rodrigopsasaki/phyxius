import type { Result } from "@phyxiusjs/fp";
import type { HandlerError } from "@phyxiusjs/handler";
import type { HttpResponse } from "./types.js";

/**
 * Default Result → HttpResponse encoder. Maps every HandlerError variant to
 * a standard HTTP status. Routes can override with their own `encode` if
 * they want a different shape — but the defaults are sensible for most APIs.
 *
 *   Ok(T)                 → 200 + JSON(T)
 *   VALIDATION_ERROR(in)  → 400 { error: "ValidationError", issues: [...] }
 *   VALIDATION_ERROR(out) → 500 { error: "InternalError" }    // it's our bug
 *   TIMEOUT               → 504 { error: "Timeout", timeoutMs }
 *   HANDLER_ERROR         → 500 { error: "InternalError" }
 *   RETRY_EXHAUSTED       → 500 { error: "InternalError", attempts }
 *   CIRCUIT_OPEN          → 503 { error: "ServiceUnavailable" } + Retry-After
 *   BACKPRESSURE_REJECT   → 503 { error: "ServiceUnavailable", reason: "queue_full" }
 *   DROPPED               → 503 { error: "ServiceUnavailable", reason: "dropped" }
 *   HANDLER_NOT_RUNNING   → 503 { error: "ServiceUnavailable", reason: "shutting_down" }
 */
export function defaultEncode<T>(result: Result<T, HandlerError>): HttpResponse {
  if (result._tag === "Ok") {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result.value,
    };
  }

  const { error } = result;

  switch (error.type) {
    case "VALIDATION_ERROR":
      if (error.target === "input") {
        return {
          status: 400,
          headers: { "content-type": "application/json" },
          body: {
            error: "ValidationError",
            issues: error.error.issues,
          },
        };
      }
      // Output validation failure = server bug. Don't leak internals.
      return {
        status: 500,
        headers: { "content-type": "application/json" },
        body: { error: "InternalError" },
      };

    case "TIMEOUT":
      return {
        status: 504,
        headers: { "content-type": "application/json" },
        body: { error: "Timeout", timeoutMs: error.timeoutMs },
      };

    case "HANDLER_ERROR":
      return {
        status: 500,
        headers: { "content-type": "application/json" },
        body: { error: "InternalError" },
      };

    case "RETRY_EXHAUSTED":
      return {
        status: 500,
        headers: { "content-type": "application/json" },
        body: { error: "InternalError", attempts: error.attempts },
      };

    case "CIRCUIT_OPEN": {
      const retryAfterSec = Math.max(0, Math.ceil((error.willRetryAfter - error.openedAt) / 1000));
      return {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfterSec),
        },
        body: { error: "ServiceUnavailable", reason: "circuit_open" },
      };
    }

    case "BACKPRESSURE_REJECT":
      return {
        status: 503,
        headers: { "content-type": "application/json" },
        body: { error: "ServiceUnavailable", reason: "queue_full" },
      };

    case "DROPPED":
      return {
        status: 503,
        headers: { "content-type": "application/json" },
        body: { error: "ServiceUnavailable", reason: "dropped" },
      };

    case "HANDLER_NOT_RUNNING":
      return {
        status: 503,
        headers: { "content-type": "application/json" },
        body: { error: "ServiceUnavailable", reason: "shutting_down" },
      };
  }
}

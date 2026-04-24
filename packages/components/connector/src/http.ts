import type { ConnectorError } from "./types.js";

// ── HTTP deepdive ───────────────────────────────────────────────────────────
//
// The curated table for HTTP-shaped providers. Nearly every real connector
// talks to a REST API underneath — Stripe, Slack, OpenAI, Twilio, SendGrid,
// anything. This file is the shared translation layer those connectors
// compose onto, so the same status code always produces the same typed
// variant regardless of which vendor's SDK is in the middle.
//
// The mapping is deliberately narrow. Every status we special-case has a
// handler-policy implication — retry, surface, fail. Everything else in
// 4xx collapses to `VALIDATION` (the client sent something wrong);
// everything else in 5xx collapses to `PROVIDER_ERROR` (they admit
// something broke).
//
// Reference: RFC 9110 §15 (status codes). No vendor-specific codes here
// — those belong in the vendor's own connector package, layered on top.

// ── Request context ─────────────────────────────────────────────────────────

/**
 * Optional structured context a caller can pass alongside a status code.
 * `retryAfterMs` is the only field that influences the mapping; the rest
 * exists so callers can keep a single typed context object for logging.
 */
export interface HttpErrorContext {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

// ── mapHttpStatus ───────────────────────────────────────────────────────────

/**
 * Translate an HTTP response status into a `ConnectorError`. Use this
 * from a connector's `mapError` when the provider returned a non-2xx
 * response:
 *
 *     mapError: (cause) => {
 *       if (cause instanceof HttpResponseError) {
 *         return mapHttpStatus(cause.status, cause, {
 *           retryAfterMs: parseRetryAfter(cause.headers["retry-after"]),
 *         });
 *       }
 *       return mapFetchError(cause);
 *     }
 *
 * | Status      | ConnectorError               | Intent              |
 * | ----------- | ---------------------------- | ------------------- |
 * | 401         | UNAUTHORIZED                 | Surface             |
 * | 403         | FORBIDDEN                    | Surface             |
 * | 404         | NOT_FOUND                    | Surface             |
 * | 408         | TIMEOUT                      | Retry               |
 * | 422         | VALIDATION                   | Surface             |
 * | 429         | RATE_LIMITED (+ retryAfterMs)| Retry w/ backoff    |
 * | 4xx (other) | VALIDATION                   | Surface             |
 * | 5xx         | PROVIDER_ERROR               | Retry w/ backoff    |
 */
export function mapHttpStatus(status: number, cause: unknown, ctx?: HttpErrorContext): ConnectorError {
  if (status === 401) return { type: "UNAUTHORIZED", cause };
  if (status === 403) return { type: "FORBIDDEN", cause };
  if (status === 404) return { type: "NOT_FOUND", cause };
  if (status === 408) return { type: "TIMEOUT", timeoutMs: 0 };
  if (status === 422) return { type: "VALIDATION", cause };

  if (status === 429) {
    return ctx?.retryAfterMs !== undefined
      ? { type: "RATE_LIMITED", retryAfterMs: ctx.retryAfterMs, cause }
      : { type: "RATE_LIMITED", cause };
  }

  if (status >= 500 && status < 600) {
    return { type: "PROVIDER_ERROR", cause };
  }

  if (status >= 400 && status < 500) {
    // Catch-all for 4xx we didn't special-case: assume the request was
    // bad and surface it. Providers with richer error taxonomies can
    // wrap this function and pre-translate their custom 4xx codes.
    return { type: "VALIDATION", cause };
  }

  // Non-error status (2xx / 3xx) or genuinely unknown (1xx / 6xx+).
  // Callers shouldn't normally invoke this with success codes; if they
  // do, we fall through to PROVIDER_ERROR rather than silently swallow.
  return { type: "PROVIDER_ERROR", cause };
}

// ── mapFetchError ───────────────────────────────────────────────────────────

/**
 * Translate an error thrown by `fetch` (or any pre-response socket-level
 * failure) into a `ConnectorError`. Called when the request never got as
 * far as a status code — DNS resolution failed, TCP refused, TLS handshake
 * timed out, the remote closed the connection mid-response, etc.
 *
 * Duck-types the errno because node:fetch wraps the underlying cause
 * inside a `TypeError` with a `.cause` chain:
 *
 *     TypeError: fetch failed
 *       cause: Error: getaddrinfo ENOTFOUND api.example.com
 *         code: "ENOTFOUND"
 *
 * We look at both `cause.code` and `cause.cause?.code` to be robust to
 * either shape.
 *
 * Mapping:
 *
 * | errno / name          | ConnectorError   | Notes                    |
 * | --------------------- | ---------------- | ------------------------ |
 * | ABORT_ERR             | TIMEOUT          | AbortSignal fired        |
 * | UND_ERR_ABORTED       | TIMEOUT          | undici's abort variant   |
 * | UND_ERR_HEADERS_TIMEOUT | TIMEOUT        | undici response timeout  |
 * | UND_ERR_BODY_TIMEOUT  | TIMEOUT          | undici body timeout      |
 * | UND_ERR_CONNECT_TIMEOUT | CONNECTION_ERROR | undici connect timeout |
 * | ECONNREFUSED          | CONNECTION_ERROR |                          |
 * | ENOTFOUND             | CONNECTION_ERROR | DNS                      |
 * | EHOSTUNREACH          | CONNECTION_ERROR |                          |
 * | ECONNRESET            | CONNECTION_ERROR | Connection dropped       |
 * | EPIPE                 | CONNECTION_ERROR | Peer closed early        |
 * | ETIMEDOUT             | CONNECTION_ERROR | Socket-level timeout     |
 * | UND_ERR_SOCKET        | CONNECTION_ERROR | undici socket error      |
 * | anything else         | PROVIDER_ERROR   |                          |
 */
export function mapFetchError(cause: unknown): ConnectorError {
  const code = extractErrno(cause);
  const name = extractName(cause);

  // AbortError: the caller's AbortSignal fired. Treat as a timeout —
  // the handler's budget expired before the provider responded.
  if (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    code === "UND_ERR_ABORTED" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return { type: "TIMEOUT", timeoutMs: 0 };
  }

  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET"
  ) {
    return { type: "CONNECTION_ERROR", cause };
  }

  return { type: "PROVIDER_ERROR", cause };
}

// ── parseRetryAfter ─────────────────────────────────────────────────────────

/**
 * Parse an HTTP `Retry-After` header. The RFC allows two formats:
 *
 *   Retry-After: 120                    (seconds, non-negative integer)
 *   Retry-After: Wed, 21 Oct 2025 07:28:00 GMT   (HTTP-date)
 *
 * Returns the delay in **milliseconds**, clamped to zero for dates in
 * the past. Returns `undefined` when the header is absent or malformed
 * — callers should fall back to their own backoff policy in that case.
 *
 * Date parsing uses `Date.parse` + a reference to `Date.now()`. For
 * test determinism, inject a `now` function.
 */
export function parseRetryAfter(value: string | null | undefined, now: () => number = Date.now): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  // Integer-seconds form. Match strictly — the RFC allows only a
  // non-negative decimal integer, no fraction, no sign.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }

  // Anything that looks numeric but didn't match the strict form
  // ("12.5", "-1", "12 abc", "1e3") is malformed — don't let it fall
  // through to Date.parse, which is implementation-defined for those
  // and happily accepts e.g. "12.5" as an epoch value in some engines.
  if (/^[-+.\d]/.test(trimmed)) return undefined;

  // HTTP-date form.
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const delta = parsed - now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

// ── Internals ───────────────────────────────────────────────────────────────

function extractErrno(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const top = (cause as { code?: unknown }).code;
  if (typeof top === "string") return top;
  const nested = (cause as { cause?: { code?: unknown } }).cause?.code;
  return typeof nested === "string" ? nested : undefined;
}

function extractName(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const { name } = cause as { name?: unknown };
  return typeof name === "string" ? name : undefined;
}

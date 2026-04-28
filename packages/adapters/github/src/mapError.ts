/**
 * Translate GitHub provider-native errors into the typed
 * `ConnectorError` vocabulary.
 *
 * GitHub does *not* always speak HTTP-status-codes idiomatically —
 * the cases worth special-handling are documented inline below.
 * The transport layer detects these and raises a `GithubHttpError`
 * whose `githubCategory` field already encodes the distinction, so
 * this mapper is mostly a switch over the category. Only when the
 * category is `unknown` do we fall through to the generic
 * `mapHttpStatus` from `@phyxiusjs/connector` — the case where we
 * received an HTTP response but couldn't classify it.
 *
 * For pre-response failures (DNS, TLS, socket reset), we delegate
 * to `mapFetchError`, which already understands node:fetch's nested
 * cause chains.
 */

import { mapFetchError, mapHttpStatus, parseRetryAfter, type ConnectorError } from "@phyxiusjs/connector";

import { GithubHttpError } from "./types.js";

/**
 * The single mapError every operation in this package uses. Invoked
 * by `defineConnector`'s try/catch wrapper; callers don't invoke it
 * directly. Pure function, no side effects, no throws.
 */
export function mapGithubError(cause: unknown): ConnectorError {
  if (cause instanceof GithubHttpError) {
    return mapGithubHttpError(cause);
  }
  return mapFetchError(cause);
}

function mapGithubHttpError(cause: GithubHttpError): ConnectorError {
  const retryAfterMs = parseRetryAfter(cause.headers["retry-after"]);

  switch (cause.githubCategory) {
    // ── Auth / permission — never retry ─────────────────────────────────────
    case "unauthorized":
      return { type: "UNAUTHORIZED", cause };
    case "forbidden":
      return { type: "FORBIDDEN", cause };
    case "not-found":
      return { type: "NOT_FOUND", cause };

    // ── Validation — surface to caller ──────────────────────────────────────
    case "validation":
      return { type: "VALIDATION", cause };

    // ── Rate limits — retry honoring retry-after ────────────────────────────
    //
    // GitHub's primary rate-limit (5000/hour authenticated REST) returns
    // 403 with `X-RateLimit-Remaining: 0`. The transport layer detects
    // this before reaching us and tags it as `primary-rate-limit`, so we
    // know it's a rate-limit exhaust rather than an authorization
    // problem. Use `X-RateLimit-Reset` for the wait time when present.
    case "primary-rate-limit": {
      const resetMs = parseRateLimitReset(cause.headers["x-ratelimit-reset"]);
      if (resetMs !== undefined) {
        return { type: "RATE_LIMITED", retryAfterMs: resetMs, cause };
      }
      return retryAfterMs !== undefined
        ? { type: "RATE_LIMITED", retryAfterMs, cause }
        : { type: "RATE_LIMITED", cause };
    }

    // GitHub's secondary rate-limit (concurrent-request burst, write
    // density) returns 403 or 429 with body messages like
    // "You have exceeded a secondary rate limit." There's no clean
    // header — `Retry-After` sometimes appears, sometimes not. When
    // absent, surface without a hint and let the handler's exponential
    // backoff take over.
    case "secondary-rate-limit":
      return retryAfterMs !== undefined
        ? { type: "RATE_LIMITED", retryAfterMs, cause }
        : { type: "RATE_LIMITED", cause };

    // GitHub's abuse-detection mechanism returns 403 with body
    // "abuse detection mechanism" or "abuse rate limit". Same retry
    // semantics as secondary rate-limit; the distinction matters for
    // observability only.
    case "abuse-detection":
      return retryAfterMs !== undefined
        ? { type: "RATE_LIMITED", retryAfterMs, cause }
        : { type: "RATE_LIMITED", cause };

    // ── Transient — retry with backoff ──────────────────────────────────────
    case "timeout":
      return { type: "TIMEOUT", timeoutMs: 0 };
    case "server-error":
      return { type: "PROVIDER_ERROR", cause };

    // ── GraphQL — surface body as validation ────────────────────────────────
    //
    // A 200 with `errors` in the body means the query was syntactically
    // sent but semantically rejected. Treat as VALIDATION so it surfaces
    // to the caller without retry — re-issuing won't change the result.
    case "graphql-errors":
      return { type: "VALIDATION", cause };

    // ── Unknown — fall through to generic status mapper ─────────────────────
    case "unknown":
    default:
      return mapHttpStatus(cause.status, cause, retryAfterMs !== undefined ? { retryAfterMs } : undefined);
  }
}

/**
 * Parse `X-RateLimit-Reset` (Unix seconds) into a millisecond delay
 * from now. Returns undefined when the header is absent or
 * malformed; callers fall back to the request's Retry-After or to
 * the handler's default backoff.
 */
function parseRateLimitReset(value: string | undefined, now: () => number = Date.now): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return undefined;
  const deltaMs = seconds * 1000 - now();
  return deltaMs > 0 ? deltaMs : 0;
}

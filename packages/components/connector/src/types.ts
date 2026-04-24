import type { HandlerSpec } from "@phyxiusjs/handler";

// ── ConnectorError — the typed vocabulary ───────────────────────────────────

/**
 * The typed error union every connector speaks. Each variant has a
 * handler-policy implication — **retry**, **surface to caller**, or
 * **fail fast** — and the union is deliberately small for the same reason
 * the Postgres SQLSTATE table is small: over-modelling creates phantom
 * decisions the handler will never act on.
 *
 * Provider-native errors (Stripe API codes, Slack slugs, OpenAI status
 * strings, SMTP response lines) get translated into this vocabulary by
 * the connector's `mapError` function. Everything downstream — retry
 * predicates, circuit-breaker policies, dashboards, alert rules — reads
 * the same eight variants regardless of which provider produced them.
 *
 * Intent by variant:
 *
 * - `UNAUTHORIZED` / `FORBIDDEN` — credential / permission problem.
 *   **Surface to caller.** Never retry.
 * - `NOT_FOUND` — the thing doesn't exist. **Surface to caller.**
 * - `VALIDATION` — client sent something the provider rejected as
 *   malformed. **Surface to caller.**
 * - `RATE_LIMITED` — the provider is throttling us. **Retry with backoff**
 *   — honoring `retryAfterMs` when the provider tells us how long to wait.
 * - `TIMEOUT` — upstream didn't respond in time. **Retry.**
 * - `CONNECTION_ERROR` — DNS / socket / TLS failed before the provider
 *   saw us. **Retry with backoff.**
 * - `PROVIDER_ERROR` — the provider admitted a server-side failure (5xx,
 *   internal error, transient outage). **Retry with backoff.**
 */
export type ConnectorError =
  | { readonly type: "UNAUTHORIZED"; readonly cause: unknown }
  | { readonly type: "FORBIDDEN"; readonly cause: unknown }
  | { readonly type: "NOT_FOUND"; readonly cause: unknown }
  | { readonly type: "VALIDATION"; readonly cause: unknown }
  | { readonly type: "RATE_LIMITED"; readonly retryAfterMs?: number; readonly cause: unknown }
  | { readonly type: "TIMEOUT"; readonly timeoutMs: number }
  | { readonly type: "CONNECTION_ERROR"; readonly cause: unknown }
  | { readonly type: "PROVIDER_ERROR"; readonly cause: unknown };

// ── ConnectorFailure — the thrown envelope ──────────────────────────────────

/**
 * What a connector's `run` actually throws. Carries the typed
 * `ConnectorError` plus the `provider` name so downstream code can
 * attribute failures without re-deriving them from the cause stack.
 *
 * `ConnectorFailure` is an `Error` subclass because the handler's retry
 * loop, circuit breaker, and journal all consume thrown values. Making
 * it a proper Error keeps stack traces usable for incident investigation
 * while the typed `error` field keeps policy decisions deterministic.
 *
 * Inside a retry predicate:
 *
 *     retry.exponential({
 *       maxAttempts: 5,
 *       shouldRetry: (cause) => {
 *         if (!isConnectorFailure(cause)) return false;
 *         const { type } = cause.error;
 *         return type === "RATE_LIMITED" || type === "CONNECTION_ERROR" ||
 *                type === "PROVIDER_ERROR" || type === "TIMEOUT";
 *       },
 *     });
 */
export class ConnectorFailure extends Error {
  readonly error: ConnectorError;
  readonly provider: string;

  constructor(provider: string, error: ConnectorError) {
    super(`[${provider}] ${error.type}`);
    this.name = "ConnectorFailure";
    this.error = error;
    this.provider = provider;
  }
}

/**
 * Narrow an `unknown` (typically a retry predicate's argument or a
 * `HandlerError.cause`) to a `ConnectorFailure`.
 */
export function isConnectorFailure(x: unknown): x is ConnectorFailure {
  return x instanceof ConnectorFailure;
}

// ── ConnectorSpec — the shape-fits extension ────────────────────────────────

/**
 * A `ConnectorSpec` is a `HandlerSpec` with two added fields: `provider`
 * and `mapError`. It inherits every required-stability decision from the
 * handler shape — timeout, concurrency, retry, circuit breaker — because
 * calling a 3rd-party API is the exact problem those decisions were
 * designed for. Nothing about wrapping Stripe or Slack changes the set of
 * policies you need.
 *
 * That the extension fits cleanly is the design test passing: if a
 * connector needed fields the handler doesn't have, either the connector
 * is modelled wrong or the handler is missing something. In this case
 * the shape fits — the connector just specializes the error translation
 * and attaches a provider identity.
 *
 * `TInput` / `TOutput` / `TFields` carry through unchanged from the
 * handler: every connector still validates its inputs, validates its
 * outputs, and curates its own observation fields.
 */
export interface ConnectorSpec<TInput, TOutput, TFields> extends HandlerSpec<TInput, TOutput, TFields> {
  /**
   * The provider's stable name. Ships on every `ConnectorFailure` and
   * shows up in journal entries when you declare `provider` as an
   * observed field. Keep it lowercase and dot-free: `"stripe"`,
   * `"slack"`, `"openai"`, `"http"`.
   */
  readonly provider: string;

  /**
   * Pure translation from a provider-native error to a `ConnectorError`.
   * Called automatically when `run` throws — users don't invoke it
   * directly. The function must not throw and must not have side
   * effects; the whole point is that it's a deterministic mapping.
   *
   * For HTTP-shaped providers, compose `mapHttpStatus` + `mapFetchError`
   * from this package rather than writing the full table by hand.
   */
  readonly mapError: (cause: unknown) => ConnectorError;
}

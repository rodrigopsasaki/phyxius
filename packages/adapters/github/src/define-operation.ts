/**
 * The shared spec helper every operation in this package uses.
 *
 * `defineGithubOperation` wraps `defineConnector` with sensible
 * github-shaped defaults (timeouts, concurrency, retry-with-rate-
 * limit-awareness, circuit breaker) and binds the transport into
 * the run closure. The result is a `HandlerSpec` ready to spawn
 * against a runtime, exactly like any other handler.
 *
 * Defaults are deliberate, not arbitrary:
 *
 *   - `timeout: 30s`. GitHub's p99 for typical reads is well under
 *     5s, but during incidents we've seen 25s+ responses from
 *     api.github.com. 30s gives headroom without becoming a tarpit.
 *
 *   - `concurrency: { max: 50, queueSize: 200, backpressure: "reject" }`.
 *     The primary REST budget is 5000 req/hour ≈ 83 concurrent in
 *     flight (Little's Law with 60s avg latency under load). 50
 *     leaves margin and matches the http-orders example precedent.
 *
 *   - `retry: exponential up to 3 attempts`. Honors retry-after
 *     when present; backs off exponentially otherwise. Only retries
 *     on transient ConnectorError variants. Permanent failures
 *     (UNAUTHORIZED, FORBIDDEN, NOT_FOUND, VALIDATION) surface
 *     immediately.
 *
 *   - `circuitBreaker: 10 consecutive failures → 30s open`. Keeps
 *     the bot from hammering GitHub when the API is genuinely
 *     down; resets when service recovers.
 *
 * Operations that need different defaults pass overrides. Search
 * (separate budget) and write operations (lower concurrency) are
 * the common cases.
 */

import { ms, type Millis } from "@phyxiusjs/clock";
import {
  cb,
  retry,
  type CircuitBreakerPolicy,
  type ConcurrencyPolicy,
  type HandlerSpec,
  type HandlerTools,
  type RetryPolicy,
} from "@phyxiusjs/handler";
import { defineConnector, isConnectorFailure } from "@phyxiusjs/connector";
import type { Validator } from "@phyxiusjs/validate";

import { mapGithubError } from "./mapError.js";
import type { Transport } from "./transport.js";

const DEFAULT_TIMEOUT: Millis = ms(30_000);
const DEFAULT_CONCURRENCY: ConcurrencyPolicy = {
  max: 50,
  queueSize: 200,
  backpressure: "reject",
};

/**
 * Default retry: up to 3 attempts, exponential backoff starting at
 * 500ms, only for transient ConnectorError variants. Honors
 * retry-after via the framework's exponential policy.
 */
const DEFAULT_RETRY: RetryPolicy = retry.exponential({
  maxAttempts: 3,
  initialDelay: ms(500),
  shouldRetry: (cause) => {
    if (!isConnectorFailure(cause)) return false;
    const { type } = cause.error;
    return type === "RATE_LIMITED" || type === "TIMEOUT" || type === "CONNECTION_ERROR" || type === "PROVIDER_ERROR";
  },
});

const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerPolicy = cb.policy({
  failureThreshold: 10,
  resetTimeout: ms(30_000),
});

export interface GithubOperationOptions<TInput, TOutput, TFields> {
  readonly name: string;
  readonly input: Validator<TInput>;
  readonly output: Validator<TOutput>;
  readonly fields: TFields;

  /** Optional override for default 30s timeout. */
  readonly timeout?: Millis;
  readonly concurrency?: ConcurrencyPolicy;
  readonly retry?: RetryPolicy;
  readonly circuitBreaker?: CircuitBreakerPolicy;

  /** The work. Receives the validated input, handler tools, and the bound transport. */
  readonly run: (input: TInput, tools: HandlerTools, transport: Transport) => Promise<TOutput>;

  /** The transport this operation runs against. */
  readonly transport: Transport;
}

export function defineGithubOperation<TInput, TOutput, TFields>(
  options: GithubOperationOptions<TInput, TOutput, TFields>,
): HandlerSpec<TInput, TOutput, TFields> {
  const { transport } = options;
  return defineConnector<TInput, TOutput, TFields>({
    name: options.name,
    provider: "github",
    input: options.input,
    output: options.output,
    fields: options.fields,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    retry: options.retry ?? DEFAULT_RETRY,
    circuitBreaker: options.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER,
    mapError: mapGithubError,
    run: async (input, tools) => options.run(input, tools, transport),
  });
}

// ── Re-exports so operations don't need to import from many places ───────────

export { mapGithubError } from "./mapError.js";
export type { Transport } from "./transport.js";

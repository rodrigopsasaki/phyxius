import type { Millis } from "@phyxiusjs/clock";
import type { CircuitBreakerPolicy } from "@phyxiusjs/circuit-breaker";
import type { RetryPolicy } from "@phyxiusjs/retry";

import type { ConcurrencyPolicy } from "./types.js";

// ── StabilityPolicy ─────────────────────────────────────────────────────────

/**
 * The four required stability fields on a `HandlerSpec`, packaged as a
 * named, reusable value. Pair with `stability.policy({ ... })` to
 * declare workload archetypes once and spread them into every handler
 * that fits the archetype, so "interactive HTTP request" or
 * "idempotent provider write" becomes a vocabulary instead of a
 * copy-pasted bag of literals.
 *
 * The shape is identical to the relevant slice of `HandlerSpec` —
 * there is no transformation. `stability.policy` exists so a value
 * can be named, frozen, and reused. The `defineHandler` call site
 * still declares its full stability surface (the "no non-decision"
 * rule is preserved at the type level); the policy makes that
 * declaration semantically legible:
 *
 *     defineHandler({
 *       ...interactiveHttp,
 *       name: "user.lookup",
 *       input, output, fields, run,
 *     });
 *
 * Reading that, you know exactly what kind of operation this is.
 * Reading a four-line literal of timeouts and retry policies, you
 * have to infer.
 */
export interface StabilityPolicy {
  readonly timeout: Millis;
  readonly concurrency: ConcurrencyPolicy;
  readonly retry: RetryPolicy;
  readonly circuitBreaker: CircuitBreakerPolicy;
}

// ── stability ───────────────────────────────────────────────────────────────

/**
 * Helpers for declaring stability decisions as named values.
 *
 * @example
 * ```ts
 * import { ms } from "@phyxiusjs/clock";
 * import { cb, defineHandler, retry, stability } from "@phyxiusjs/handler";
 *
 * // Declare archetypes once, named after what they mean.
 * export const interactiveHttp = stability.policy({
 *   timeout: ms(2_000),
 *   concurrency: { max: 50, queueSize: 200, backpressure: "reject" },
 *   retry: retry.none(),
 *   circuitBreaker: cb.policy({ failureThreshold: 20, resetTimeout: ms(30_000) }),
 * });
 *
 * export const idempotentProviderWrite = stability.policy({
 *   timeout: ms(10_000),
 *   concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
 *   retry: retry.exponential({ maxAttempts: 5, initialDelay: ms(500) }),
 *   circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),
 * });
 *
 * // Spread at the call site — every handler still declares its
 * // stability surface, but now the declaration carries a name.
 * defineHandler({
 *   ...interactiveHttp,
 *   name: "user.lookup",
 *   input, output, fields, run,
 * });
 * ```
 */
export const stability = {
  /**
   * Freeze a stability decision as a reusable, semantically-named
   * value. Returns the policy unchanged (frozen) so the call site reads
   * as a declaration, not a transformation.
   *
   * The helper is one line of runtime work — its real product is a
   * pattern that solves a future problem: in a year, two hundred
   * handlers all carrying `timeout: ms(5_000), retry.exponential(...)`
   * would technically satisfy the "no non-decision" rule while
   * smearing intent across two hundred sites. A reader of any single
   * handler couldn't tell whether the literal is "the standard
   * interactive timeout" or "a deliberate domain-specific choice."
   *
   * Named policies put the meaning back. Change `interactiveHttp`
   * once, every site that uses it updates. Read a handler that spreads
   * `interactiveHttp`, and you know exactly which archetype it is.
   * Decisions stay explicit; ceremony stops accumulating.
   */
  policy(p: StabilityPolicy): Readonly<StabilityPolicy> {
    return Object.freeze({ ...p });
  },
} as const;

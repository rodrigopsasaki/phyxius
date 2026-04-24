import type { HandlerSpec } from "@phyxiusjs/handler";

import { ConnectorFailure, type ConnectorSpec } from "./types.js";

// ── defineConnector ─────────────────────────────────────────────────────────

/**
 * Materialize a `ConnectorSpec` as a plain `HandlerSpec`. The returned
 * spec is usable with `spawn()` unchanged — everything the handler layer
 * cares about is already there, because a ConnectorSpec IS a HandlerSpec
 * plus two fields.
 *
 * The one thing `defineConnector` adds is a try/catch around the user's
 * `run` body: any throw inside the connector's work is caught, passed
 * through the spec's `mapError`, and re-thrown as a `ConnectorFailure`
 * carrying the typed `ConnectorError`. The handler's retry loop,
 * circuit breaker, and journal all consume `ConnectorFailure` as just
 * "another thrown value," but inside a retry predicate (or when you
 * pattern-match on `HandlerError.cause`) you can narrow to the typed
 * connector error and make policy decisions on named variants.
 *
 * Idempotent: if a nested `defineConnector` has already wrapped the
 * error, we don't re-wrap — the innermost provider's identity is what
 * matters to the policy layer.
 *
 * The cross-spec requirement (`TInput`, `TOutput`, `TFields`) is
 * preserved so the returned `HandlerSpec` stays fully typed.
 */
export function defineConnector<TInput, TOutput, TFields>(
  spec: ConnectorSpec<TInput, TOutput, TFields>,
): HandlerSpec<TInput, TOutput, TFields> {
  return {
    name: spec.name,
    input: spec.input,
    output: spec.output,
    fields: spec.fields,
    timeout: spec.timeout,
    concurrency: spec.concurrency,
    retry: spec.retry,
    circuitBreaker: spec.circuitBreaker,
    run: async (input, tools) => {
      try {
        return await spec.run(input, tools);
      } catch (cause) {
        // Don't double-wrap: a nested connector's ConnectorFailure
        // already carries the typed error + provider. Re-wrapping would
        // lose the inner identity (the provider closest to the actual
        // failure), which is the one humans and dashboards want.
        if (cause instanceof ConnectorFailure) throw cause;

        const mapped = spec.mapError(cause);
        throw new ConnectorFailure(spec.provider, mapped);
      }
    },
  };
}

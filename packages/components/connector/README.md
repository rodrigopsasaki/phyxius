# Connector

The third-party integration primitive. `ConnectorSpec extends HandlerSpec`, a curated `ConnectorError` union, and an HTTP translation table every real REST-shaped provider reuses.

---

## What this really is

A thin refinement of `@phyxiusjs/handler` and a **typed vocabulary for upstream failures**.

Every time you call out to a 3rd-party — Stripe, Slack, OpenAI, Twilio, your own internal service, anything — you hit the same problem: the provider speaks their dialect (HTTP status codes, SDK exception classes, error slugs), and your handler layer speaks its own. Retry policies want to know "is this retryable." Circuit breakers want to know "is this a real failure or a constraint." Dashboards want to know "which provider, which kind of failure, which minute." None of that can be decided on a raw thrown value.

So every codebase ends up writing the same translation layer, slightly differently, in front of each integration. This package is that translation layer, factored out once and shared.

- A `ConnectorSpec<I, O, F>` is a `HandlerSpec<I, O, F>` plus two fields: `provider` (a stable name) and `mapError` (pure translation). Everything else — timeout, concurrency, retry, circuit breaker, input/output validators, observation fields — comes straight from the handler substrate.
- A `ConnectorError` is an eight-variant typed union. Retry predicates narrow on it. Dashboards group by it. It's the same across every provider.
- A `ConnectorFailure` is the thrown envelope — an `Error` subclass carrying the typed `ConnectorError` and the provider identity. Instance checks flow through the retry loop and land on `HandlerError.cause` for pattern matching.
- HTTP helpers (`mapHttpStatus`, `mapFetchError`, `parseRetryAfter`) are the curated table every REST-shaped connector composes onto. One place to read when a new status code starts mattering, one place to update when it does.

That's the whole package. No framework, no registry, no lifecycle — just the shape and the mapping.

---

## The shape-fits principle

`ConnectorSpec extends HandlerSpec` is the interesting move, and it's a design test passing.

The claim: **a 3rd-party API call is exactly the thing the handler was designed for**. It has an input (the request) and an output (the response). It has a timeout (the upstream can hang). It needs concurrency limits (you don't want to blow out connection pools). It needs retry (networks are flaky). It needs a circuit breaker (a dead upstream shouldn't eat your whole service). It needs observability (which provider, which minute, which failure mode).

Those are the handler's required fields, verbatim. So a connector doesn't need a new spec shape — it needs the existing one plus a translation hook. That it extends cleanly is confirmation that `HandlerSpec` was the right shape in the first place; if it didn't extend, we'd have learned that either the connector concept is wrong or the handler substrate is under-specified.

The same logic will apply to whatever comes next. A schedulable task, a queue consumer, a background job, a state-machine step — if it's work with an input, an output, and a set of failure modes, it's a handler. Specializations add what they add, the substrate carries the rest.

---

## Installation

```bash
npm install @phyxiusjs/connector @phyxiusjs/handler
```

---

## Quick start

A tiny connector around `fetch`:

```ts
import { z } from "zod";
import { ms } from "@phyxiusjs/clock";
import { observe } from "@phyxiusjs/observe";
import { cb, retry, spawn } from "@phyxiusjs/handler";
import {
  ConnectorFailure,
  defineConnector,
  isConnectorFailure,
  mapFetchError,
  mapHttpStatus,
  parseRetryAfter,
  type ConnectorError,
} from "@phyxiusjs/connector";

const fields = observe.fields({
  provider: observe.field<string>(),
  method: observe.field<string>(),
  url: observe.field<string>(),
  status: observe.number(),
});

const githubUser = defineConnector({
  name: "github.get-user",
  provider: "github",
  input: z.object({ username: z.string() }),
  output: z.object({ id: z.number(), login: z.string() }),
  fields,

  // Required stability fields — same as any handler.
  timeout: ms(5_000),
  concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
  retry: retry.exponential({
    maxAttempts: 3,
    initialDelay: ms(200),
    shouldRetry: (cause) => {
      if (!isConnectorFailure(cause)) return false;
      const { type } = cause.error;
      return type === "RATE_LIMITED" || type === "CONNECTION_ERROR" || type === "PROVIDER_ERROR" || type === "TIMEOUT";
    },
  }),
  circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),

  // Translate provider-native errors into the typed vocabulary.
  mapError: (cause): ConnectorError => {
    if (cause instanceof HttpResponseError) {
      return mapHttpStatus(cause.status, cause, {
        retryAfterMs: parseRetryAfter(cause.headers.get("retry-after")),
      });
    }
    return mapFetchError(cause);
  },

  // The actual work.
  run: async ({ username }, { signal }) => {
    fields.provider.set("github");
    fields.method.set("GET");
    fields.url.set(`https://api.github.com/users/${username}`);

    const res = await fetch(`https://api.github.com/users/${username}`, { signal });
    fields.status.set(res.status);

    if (!res.ok) {
      throw new HttpResponseError(res.status, await res.text(), res.headers);
    }
    return res.json();
  },
});

// `defineConnector` returns a plain HandlerSpec. Spawn it like anything else.
const running = await spawn(githubUser, { clock, journal });

const result = await running.invoke({ username: "rodrigopsasaki" });
```

That's a timeout-bounded, retry-aware, circuit-broken, rate-limit-honoring GitHub connector. The stability layer is the handler's; the translation layer is ours; the provider-specific glue fits in ~20 lines of `run`.

---

## `ConnectorSpec`

```ts
interface ConnectorSpec<TInput, TOutput, TFields> extends HandlerSpec<TInput, TOutput, TFields> {
  provider: string;
  mapError: (cause: unknown) => ConnectorError;
}
```

Two added fields. Everything else is the handler.

- **`provider`** — a stable, lowercase, dot-free name (`"stripe"`, `"slack"`, `"openai"`, `"http"`). Attached to every `ConnectorFailure` thrown by the wrapped `run`, and conventionally also observed as a field so it shows up on every journal entry.
- **`mapError`** — pure, no side effects, no throws. Called automatically when the connector's `run` body throws. The translated `ConnectorError` gets wrapped in a `ConnectorFailure` and re-thrown. Users never invoke this directly.

---

## `ConnectorError`

The vocabulary. Eight variants; every one has a handler-policy implication.

| Variant            | Intent                | Typical source                                 |
| ------------------ | --------------------- | ---------------------------------------------- |
| `UNAUTHORIZED`     | Surface. Never retry. | 401, expired key, missing token                |
| `FORBIDDEN`        | Surface. Never retry. | 403, permission denied                         |
| `NOT_FOUND`        | Surface.              | 404, resource doesn't exist                    |
| `VALIDATION`       | Surface.              | 400 / 422, bad request shape                   |
| `RATE_LIMITED`     | Retry with backoff.   | 429, provider throttle. Carries `retryAfterMs` |
| `TIMEOUT`          | Retry.                | 408, abort signal, upstream hung               |
| `CONNECTION_ERROR` | Retry with backoff.   | DNS / socket / TLS failed before response      |
| `PROVIDER_ERROR`   | Retry with backoff.   | 5xx, provider admitted server-side failure     |

The union is deliberately narrow. If you think you need a ninth variant, ask: would the retry policy treat it differently from the eight that exist? If not, don't model it. Over-modelling the failure space creates phantom decisions that never fire.

---

## `ConnectorFailure`

What a connector's `run` actually throws on failure:

```ts
class ConnectorFailure extends Error {
  readonly error: ConnectorError;
  readonly provider: string;
}
```

The `message` is `[provider] VARIANT`, so a stack trace tells you the provider and the variant at a glance. Stack preservation is deliberate — incident investigation still wants to know where the throw originated.

Narrowing is what you'd expect:

```ts
// Inside a retry predicate
shouldRetry: (cause) => {
  if (!isConnectorFailure(cause)) return false;
  return cause.error.type === "RATE_LIMITED";
};

// After invocation
if (result._tag === "Err" && result.error.type === "HANDLER_ERROR" && isConnectorFailure(result.error.cause)) {
  switch (result.error.cause.error.type) {
    case "RATE_LIMITED":
      /* ... */
      break;
    case "UNAUTHORIZED":
      /* ... */
      break;
  }
}
```

`ConnectorFailure` is idempotent through `defineConnector`: if a nested connector has already wrapped the error, the outer wrapper re-throws it unchanged. The **innermost** provider's identity wins, because that's the one closest to the actual failure — the one humans and dashboards want to see.

---

## HTTP deepdive

Most real connectors talk HTTP underneath. `mapHttpStatus` + `mapFetchError` + `parseRetryAfter` are the shared translation layer those connectors compose onto.

### `mapHttpStatus(status, cause, ctx?)`

| Status      | `ConnectorError`                  | Intent           |
| ----------- | --------------------------------- | ---------------- |
| 401         | `UNAUTHORIZED`                    | Surface          |
| 403         | `FORBIDDEN`                       | Surface          |
| 404         | `NOT_FOUND`                       | Surface          |
| 408         | `TIMEOUT`                         | Retry            |
| 422         | `VALIDATION`                      | Surface          |
| 429         | `RATE_LIMITED` (+ `retryAfterMs`) | Retry w/ backoff |
| 4xx (other) | `VALIDATION`                      | Surface          |
| 5xx         | `PROVIDER_ERROR`                  | Retry w/ backoff |

The 4xx catch-all collapses to `VALIDATION` because that's the useful default ("you sent the provider something bad, surface it"). Vendor-specific codes that deserve different treatment can be pre-translated in the connector's own `mapError` before falling through to `mapHttpStatus`.

### `mapFetchError(cause)`

For pre-response failures — the request never got as far as a status code:

| `code` / `name`                                                                                                              | `ConnectorError`   |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `AbortError`, `ABORT_ERR`, `UND_ERR_ABORTED`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`                              | `TIMEOUT`          |
| `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET` | `CONNECTION_ERROR` |
| anything else                                                                                                                | `PROVIDER_ERROR`   |

Duck-types on both `cause.code` and `cause.cause?.code` because `node:fetch` wraps the underlying errno inside a `TypeError("fetch failed")`. Robust across node/undici versions without coupling to a specific error class.

### `parseRetryAfter(value, now?)`

Parses RFC 9110 `Retry-After` headers — both integer-seconds and HTTP-date forms — and returns **milliseconds**. Malformed or absent input returns `undefined`; callers should fall back to their own backoff in that case. Inject `now` for determinism in tests.

---

## Why one curated table beats 12 hand-rolled ones

Every team writes this translation layer anyway. You've seen it — a file called `stripe-errors.ts`, another called `slack-client.ts`, another called `http-helpers.ts`, each with slightly different decisions about whether 408 retries, whether 422 is the same as 400, whether a TCP reset is "retryable network" or "provider down."

Three problems with that:

1. **Drift.** Three files, three opinions. Retry semantics for Stripe disagree with retry semantics for Slack, for no reason anyone can articulate.
2. **No shared dashboard.** A `RATE_LIMITED` on Stripe and a `RATE_LIMITED` on Slack should produce the same dashboard query ("what's our RATE_LIMITED rate this hour, by provider?"). If they're expressed as provider-specific types, you can't write that query without grepping every connector.
3. **Knowledge trapped per-file.** The next engineer touching `stripe-errors.ts` doesn't know what conventions live in `slack-client.ts`. The table gets rebuilt from scratch, poorly.

One curated table, one typed union, one `isConnectorFailure` check in the retry predicate — and all three problems go away.

---

## Per-connector deepdive — the curated product

A real connector (`@phyxiusjs/connector-stripe`, `@phyxiusjs/connector-slack`) is not just a mapError. It's a curated **observability product** for that provider:

- The observe fields that matter for that provider (for Stripe: `chargeId`, `amount`, `currency`; for Slack: `channel`, `ts`, `team`; for OpenAI: `model`, `tokensIn`, `tokensOut`).
- The retry predicate that honors that provider's conventions (Stripe's `idempotency_key` retry semantics, OpenAI's backoff guidance).
- Any provider-specific pre-translation in `mapError` (Stripe's `card_declined` is a `VALIDATION`, not a `PROVIDER_ERROR`).
- The right defaults for timeouts and concurrency for that provider's published limits.

This package ships the primitive and the HTTP table. Per-provider connectors are their own downstream packages — a one-afternoon job once the primitive is stable, and worth doing well because each one is a narrative-observability product: **"at 3am, one customer wanted an order but Stripe had an outage; here are the three requests that hit it, here's the exact charge ID each one was trying to create."** That story is only available if the observe fields are curated.

---

## Testing

```ts
import { createControlledClock } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { spawn } from "@phyxiusjs/handler";
import { defineConnector, isConnectorFailure } from "@phyxiusjs/connector";

const clock = createControlledClock({ initialTime: 0 });
const journal = new Journal({ clock });

const spec = defineConnector({
  /* ... */
});
const handler = await spawn(spec, { clock, journal });

const result = await handler.invoke(input);

// Same assertion shape as any handler.
if (result._tag === "Err" && result.error.type === "HANDLER_ERROR") {
  expect(isConnectorFailure(result.error.cause)).toBe(true);
}
```

Because `defineConnector` produces a plain `HandlerSpec`, the full handler test surface — `ControlledClock`, `Journal` snapshots, retry loop behavior, circuit-breaker state — is available unchanged. No mock-fetch-HTTP-server required unless you're integration-testing the actual provider.

---

## What this does NOT do

- **No connector implementations.** Stripe / Slack / OpenAI / etc are separate packages. This is the shape and the HTTP table.
- **No HTTP client.** Use `fetch`, `undici`, `axios` — whatever. The mapping helpers work on the errors those clients throw; they don't care which one you used.
- **No automatic `fetch` wrapping.** A future `httpConnector()` helper that takes a URL template and handles the fetch + response body reading could live on top of this, but the primitive stays pure.
- **No SDK wrapping.** Official provider SDKs (stripe-node, @slack/web-api, openai) throw their own errors; pre-translate them in your `mapError` before falling through to `mapHttpStatus` / `mapFetchError`.

---

## What you get

- **A shape-fits specialization.** `ConnectorSpec extends HandlerSpec` — every required-stability decision carries through. No new vocabulary for concurrency, retries, breakers, or journaling.
- **A typed error vocabulary.** Eight variants, every one policy-bearing. Retry predicates, dashboards, alerts, and pattern-match sites all read the same union regardless of provider.
- **An HTTP deepdive.** One curated table for status codes + one for Node / undici errnos. Every HTTP-shaped connector inherits correct retry semantics for free.
- **Per-provider observability as a curated product.** Each downstream connector gets to design what its journal entries look like, knowing the substrate already carries the common fields (attempts, duration, outcome, correlationId).

The connector is small because the work it does is narrow: refine the handler shape, give upstream failures a typed name, and publish the HTTP mapping table. Everything that could be per-provider stays per-provider.

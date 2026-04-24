# HTTP

The HTTP adapter for `@phyxiusjs/handler`. Translates Node `IncomingMessage`/`ServerResponse` into handler invocations, and handler results back into HTTP responses.

---

## What this really is

A thin translator. ~350 lines, zero runtime state, no framework layer. It owns exactly three concerns:

1. **Parsing** — turn an `IncomingMessage` into a pure `HttpRequest` value.
2. **Routing** — match method + path against a compiled route table.
3. **Encoding** — map `Result<T, HandlerError>` to a sensible HTTP status.

Everything else — timeouts, retries, validation, circuit breakers, concurrency, observability — lives in the handler. The adapter doesn't know those exist. Which is the point: switch this package out for `@phyxiusjs/queue` tomorrow and the same handler runs with the same stability guarantees and the same journal entries, behind a different transport.

---

## Installation

```bash
npm install @phyxiusjs/http @phyxiusjs/handler
```

---

## Quick start

```ts
import { createServer } from "node:http";
import { z } from "zod";

import { createSystemClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { defineHandler, spawn, retry, cb } from "@phyxiusjs/handler";
import { createHttpAdapter } from "@phyxiusjs/http";

// 1. Define the handler (see @phyxiusjs/handler for the full story).
const orderFields = observe.fields({
  customerId: observe.field<string>(),
  amount: observe.number(),
});

const orderSpec = defineHandler({
  name: "order.process",
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ chargeId: z.string(), amount: z.number() }),
  fields: orderFields,
  timeout: ms(5_000),
  concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
  retry: retry.exponential({ maxAttempts: 3, initialDelay: ms(200) }),
  circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),
  run: async ({ customerId, amount }) => {
    orderFields.customerId.set(customerId);
    orderFields.amount.set(amount);
    return { chargeId: `charge_${customerId}`, amount };
  },
});

// 2. Materialize the handler.
const clock = createSystemClock();
const journal = new Journal({ clock });
const orderHandler = await spawn(orderSpec, { clock, journal });

// 3. Wire it to an HTTP route.
const adapter = createHttpAdapter({
  routes: [
    {
      method: "POST",
      path: "/orders",
      handler: orderHandler,
      decode: (req) => req.body as { customerId: string; amount: number },
    },
  ],
});

// 4. Serve it.
createServer(adapter.listener).listen(3000);
```

That's the whole integration. The handler owns stability and observability; the adapter only translates.

---

## The `HttpAdapter` surface

```ts
interface HttpAdapter {
  // Pure core — takes a parsed HttpRequest, returns a response. Never throws.
  handle(request: HttpRequest): Promise<HttpResponse>;

  // Node glue — use with http.createServer or express-style middleware.
  listener(req: IncomingMessage, res: ServerResponse): Promise<void>;

  // Compiled route table (diagnostics / testing).
  readonly routes: CompiledRoutes;
}
```

**`handle` is the test surface.** You can exercise every route, every encoding, every 404 / 405 path, without touching Node's HTTP stack. That's deliberate — treating `IncomingMessage` as an adapter-layer detail keeps the core unit-testable.

---

## Routes

```ts
interface HttpRoute<TInput, TOutput> {
  method: HttpMethod; // "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"
  path: string; // "/orders/:id" — `:param` only, no wildcards
  handler: RunningHandler<TInput, TOutput>;
  decode: (req: HttpRequest) => TInput;
  encode?: (result: Result<TOutput, HandlerError>, req: HttpRequest) => HttpResponse;
}
```

- **`decode`** turns the parsed HTTP request into the handler's typed input. Everything the route needs — body, params, query, headers — comes from the `HttpRequest`. Throw from here if the adapter literally cannot construct an input; `onInternalError` will catch it. Most routes should let the handler's `input` validator reject malformed input so the failure becomes a typed `VALIDATION_ERROR` instead.
- **`encode`** is optional. If omitted, `defaultEncode` maps every `HandlerError` variant to a standard HTTP status (see below).

Routes are compiled at construction time and sorted by specificity (more literal segments first), so `/items/new` wins over `/items/:id`. No runtime regex, no wildcards — if you need more, decode from a broader path and dispatch inside the handler.

---

## Default encoder

Every `HandlerError` variant has a sensible mapping. Override per-route for anything else.

| Result                       | Status | Body                                                            | Headers                  |
| ---------------------------- | ------ | --------------------------------------------------------------- | ------------------------ |
| `Ok(T)`                      | 200    | `T` (JSON)                                                      |                          |
| `VALIDATION_ERROR("input")`  | 400    | `{ error: "ValidationError", issues: [...] }`                   |                          |
| `VALIDATION_ERROR("output")` | 500    | `{ error: "InternalError" }` _(server bug — no details leaked)_ |                          |
| `TIMEOUT`                    | 504    | `{ error: "Timeout", timeoutMs }`                               |                          |
| `HANDLER_ERROR`              | 500    | `{ error: "InternalError" }`                                    |                          |
| `RETRY_EXHAUSTED`            | 500    | `{ error: "InternalError", attempts }`                          |                          |
| `CIRCUIT_OPEN`               | 503    | `{ error: "ServiceUnavailable", reason: "circuit_open" }`       | `Retry-After: <seconds>` |
| `BACKPRESSURE_REJECT`        | 503    | `{ error: "ServiceUnavailable", reason: "queue_full" }`         |                          |
| `DROPPED`                    | 503    | `{ error: "ServiceUnavailable", reason: "dropped" }`            |                          |
| `HANDLER_NOT_RUNNING`        | 503    | `{ error: "ServiceUnavailable", reason: "shutting_down" }`      |                          |

The mapping is intentional: client errors are 4xx, server bugs are 500, capacity pushback is 503. If you want `CIRCUIT_OPEN` to be a 502 or `RETRY_EXHAUSTED` to be a 504, pass your own `encode` on the route.

---

## Correlation IDs

Inbound correlation IDs flow through to the handler, onto the journal entry, and into every field you observe:

```ts
createHttpAdapter({
  routes: [...],
  correlationIdHeaders: ["x-trace-id", "x-correlation-id", "x-request-id"],
});
```

The first header present wins. Default order: `x-correlation-id`, `x-request-id`. If nothing matches, the handler allocates one. Either way the value appears as `correlationId` on the `HandlerEvent`, so every log line, every trace span, every downstream call can stitch back to the same request.

---

## Error hooks

```ts
createHttpAdapter({
  routes: [...],
  on404:           (req) => ({ status: 404, body: { error: "NotFound", path: req.path } }),
  on405:           (req) => ({ status: 405, body: { error: "MethodNotAllowed", method: req.method } }),
  onInternalError: (error, req) => ({ status: 500, body: { error: "InternalError" } }),
});
```

`onInternalError` only fires for adapter-level failures (body parse throws, decode throws). Handler failures — including bugs in `run` — are already typed as `HANDLER_ERROR` and encoded, not re-thrown.

---

## Testing

The adapter is a pure function over a pure data type. No server needed:

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { spawn } from "@phyxiusjs/handler";
import { createHttpAdapter } from "@phyxiusjs/http";

const clock = createControlledClock({ initialTime: 0 });
const journal = new Journal({ clock });
const handler = await spawn(orderSpec, { clock, journal });

const adapter = createHttpAdapter({
  routes: [{ method: "POST", path: "/orders", handler, decode: (r) => r.body }],
});

const response = await adapter.handle({
  method: "POST",
  path: "/orders",
  params: {},
  query: {},
  headers: { "content-type": "application/json", "x-correlation-id": "req-abc" },
  body: { customerId: "alice", amount: 99.99 },
});

expect(response.status).toBe(200);
expect(journal.getSnapshot().entries[0].data.correlationId).toBe("req-abc");
```

Every integration path — routing, decoding, encoding, error mapping, correlation flow — is exercised without a socket.

---

## What this does NOT do

- **No middleware layer.** Cross-cutting concerns (auth, rate-limits, logging) are handler concerns — declare them once on the spec and they apply to every transport.
- **No body parsing beyond JSON.** Form-encoded, multipart, and binary payloads are returned as raw strings/buffers; decode them in your `decode` function.
- **No streaming responses.** The handler returns one value; the adapter returns one response. Streaming is a different adapter.
- **No regex routing, no wildcards, no optional segments.** `:param` only. Intentional minimalism.
- **No process management.** `http.createServer` is yours to wire. The adapter just gives you a listener.

---

## What you get

- **Transport-stable journal.** Every HTTP request produces the same `HandlerEvent` shape as a queue message or a cron tick. One dashboard, one alerting surface.
- **Every failure mode typed and HTTP-mapped.** No generic 500s swallowing real failures. A timeout is a 504. A full queue is a 503. A validation issue carries its path.
- **Pure core, testable without sockets.** `handle(HttpRequest): Promise<HttpResponse>` is the whole adapter — the Node listener is a 20-line wrapper.
- **Correlation-in, correlation-out.** IDs flow into the journal entry untouched.

The HTTP adapter is deliberately small. The handler is where the work lives.

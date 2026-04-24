import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import {
  cb,
  defineHandler,
  retry,
  spawn,
  type HandlerEvent,
  type HandlerRuntime,
  type RunningHandler,
} from "@phyxiusjs/handler";

import { createHttpAdapter } from "../src/index.js";
import type { HttpRequest, HttpRoute } from "../src/types.js";

// ── Test helpers ────────────────────────────────────────────────────────────

function setup() {
  const clock = createControlledClock({ initialTime: 0 });
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 100 });
  const runtime: HandlerRuntime = { clock, journal };
  return { clock, journal, runtime };
}

const orderFields = observe.fields({
  customerId: observe.field<string>(),
  amount: observe.number(),
});

const orderSpec = defineHandler({
  name: "order.process",
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ chargeId: z.string(), amount: z.number() }),
  fields: orderFields,
  timeout: ms(1000),
  concurrency: { max: 4, queueSize: 10, backpressure: "reject" },
  retry: retry.none(),
  circuitBreaker: cb.none(),
  run: async ({ customerId, amount }) => {
    orderFields.customerId.set(customerId);
    orderFields.amount.set(amount);
    return { chargeId: `charge_${customerId}`, amount };
  },
});

const echoFields = observe.fields({ echoed: observe.field<string>() });

const echoSpec = defineHandler({
  name: "echo",
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string() }),
  fields: echoFields,
  timeout: ms(1000),
  concurrency: { max: 2, queueSize: 5, backpressure: "reject" },
  retry: retry.none(),
  circuitBreaker: cb.none(),
  run: async ({ value }) => ({ value }),
});

function req(partial: Partial<HttpRequest> & { method: HttpRequest["method"]; path: string }): HttpRequest {
  return {
    params: {},
    query: {},
    headers: {},
    body: undefined,
    ...partial,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createHttpAdapter", () => {
  it("routes a POST to the handler and encodes the Ok result", async () => {
    const { runtime, journal } = setup();
    const handler = await spawn(orderSpec, runtime);

    const route: HttpRoute<{ customerId: string; amount: number }, { chargeId: string; amount: number }> = {
      method: "POST",
      path: "/orders",
      handler,
      decode: (r) => r.body as { customerId: string; amount: number },
    };

    const adapter = createHttpAdapter({ routes: [route as HttpRoute<unknown, unknown>] });

    const response = await adapter.handle(
      req({
        method: "POST",
        path: "/orders",
        body: { customerId: "alice", amount: 99.99 },
        headers: { "content-type": "application/json", "x-correlation-id": "req-abc" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ chargeId: "charge_alice", amount: 99.99 });

    // Journal entry was produced with the correlation ID flowing through.
    const { entries } = journal.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.correlationId).toBe("req-abc");
    expect(entries[0]?.data.source).toBe("http");
    expect(entries[0]?.data.observed).toMatchObject({ customerId: "alice", amount: 99.99 });

    await handler.stop();
  });

  it("extracts path params and passes them via params", async () => {
    const { runtime } = setup();
    const handler = await spawn(echoSpec, runtime);

    let seenParams: Readonly<Record<string, string>> = {};

    const route: HttpRoute<{ value: string }, { value: string }> = {
      method: "GET",
      path: "/echo/:value",
      handler,
      decode: (r) => {
        seenParams = r.params;
        return { value: r.params["value"] ?? "" };
      },
    };

    const adapter = createHttpAdapter({ routes: [route as HttpRoute<unknown, unknown>] });

    const response = await adapter.handle(req({ method: "GET", path: "/echo/hello%20world" }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ value: "hello world" });
    expect(seenParams["value"]).toBe("hello world");

    await handler.stop();
  });

  it("returns 404 when no route matches", async () => {
    const adapter = createHttpAdapter({ routes: [] });
    const response = await adapter.handle(req({ method: "GET", path: "/nope" }));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "NotFound" });
  });

  it("returns 405 when the path matches but the method doesn't", async () => {
    const { runtime } = setup();
    const handler = await spawn(echoSpec, runtime);

    const adapter = createHttpAdapter({
      routes: [
        {
          method: "GET",
          path: "/echo/:value",
          handler: handler as RunningHandler<unknown, unknown>,
          decode: (r) => ({ value: (r.params["value"] as string) ?? "" }),
        },
      ],
    });

    const response = await adapter.handle(req({ method: "POST", path: "/echo/hi" }));
    expect(response.status).toBe(405);

    await handler.stop();
  });

  it("applies the default encoder for input validation failures (400)", async () => {
    const { runtime } = setup();
    const handler = await spawn(orderSpec, runtime);

    const adapter = createHttpAdapter({
      routes: [
        {
          method: "POST",
          path: "/orders",
          handler: handler as RunningHandler<unknown, unknown>,
          decode: (r) => r.body,
        },
      ],
    });

    // amount: -1 violates .positive() → input validation error.
    const response = await adapter.handle(
      req({ method: "POST", path: "/orders", body: { customerId: "alice", amount: -1 } }),
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "ValidationError" });

    await handler.stop();
  });

  it("lets the route override encode", async () => {
    const { runtime } = setup();
    const handler = await spawn(echoSpec, runtime);

    const adapter = createHttpAdapter({
      routes: [
        {
          method: "GET",
          path: "/echo/:value",
          handler: handler as RunningHandler<unknown, unknown>,
          decode: (r) => ({ value: (r.params["value"] as string) ?? "" }),
          encode: (result) => {
            if (result._tag === "Ok") {
              return {
                status: 201,
                headers: { "x-custom": "yes" },
                body: { wrapped: result.value },
              };
            }
            return { status: 500, body: { error: "x" } };
          },
        },
      ],
    });

    const response = await adapter.handle(req({ method: "GET", path: "/echo/hey" }));
    expect(response.status).toBe(201);
    expect(response.headers?.["x-custom"]).toBe("yes");
    expect(response.body).toEqual({ wrapped: { value: "hey" } });

    await handler.stop();
  });

  it("falls back to onInternalError when decode throws", async () => {
    const { runtime } = setup();
    const handler = await spawn(echoSpec, runtime);

    const adapter = createHttpAdapter({
      routes: [
        {
          method: "POST",
          path: "/boom",
          handler: handler as RunningHandler<unknown, unknown>,
          decode: () => {
            throw new Error("decode exploded");
          },
        },
      ],
      onInternalError: (error, _req) => ({
        status: 500,
        headers: { "content-type": "application/json" },
        body: { error: "InternalError", message: (error as Error).message },
      }),
    });

    const response = await adapter.handle(req({ method: "POST", path: "/boom", body: {} }));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "InternalError", message: "decode exploded" });

    await handler.stop();
  });

  it("picks up a custom correlation-id header when configured", async () => {
    const { runtime, journal } = setup();
    const handler = await spawn(echoSpec, runtime);

    const adapter = createHttpAdapter({
      routes: [
        {
          method: "POST",
          path: "/echo",
          handler: handler as RunningHandler<unknown, unknown>,
          decode: (r) => r.body,
        },
      ],
      correlationIdHeaders: ["x-trace-id"],
    });

    await adapter.handle(
      req({
        method: "POST",
        path: "/echo",
        headers: { "x-trace-id": "trace-123", "x-correlation-id": "ignored" },
        body: { value: "hi" },
      }),
    );

    const { entries } = journal.getSnapshot();
    expect(entries[0]?.data.correlationId).toBe("trace-123");

    await handler.stop();
  });

  it("routes to the more-specific path when overlapping routes exist", async () => {
    const { runtime } = setup();
    const handler = await spawn(echoSpec, runtime);

    const calls: string[] = [];

    const adapter = createHttpAdapter({
      routes: [
        {
          method: "GET",
          path: "/items/:id",
          handler: handler as RunningHandler<unknown, unknown>,
          decode: (r) => {
            calls.push(`by-id:${r.params["id"]}`);
            return { value: `id:${r.params["id"]}` };
          },
        },
        {
          method: "GET",
          path: "/items/new",
          handler: handler as RunningHandler<unknown, unknown>,
          decode: () => {
            calls.push("new");
            return { value: "new" };
          },
        },
      ],
    });

    const newResp = await adapter.handle(req({ method: "GET", path: "/items/new" }));
    expect(newResp.status).toBe(200);
    expect(newResp.body).toEqual({ value: "new" });

    const byIdResp = await adapter.handle(req({ method: "GET", path: "/items/42" }));
    expect(byIdResp.status).toBe(200);
    expect(byIdResp.body).toEqual({ value: "id:42" });

    expect(calls).toEqual(["new", "by-id:42"]);

    await handler.stop();
  });
});

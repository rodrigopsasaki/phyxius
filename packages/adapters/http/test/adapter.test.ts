import { describe, it, expect, beforeEach } from "vitest";
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSystemClock } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { createRuntime } from "@phyxiusjs/runtime";
import { defineFunction, ServiceError, NO_RETRY, NO_CIRCUIT_BREAKER } from "@phyxiusjs/service";
import { ok, err } from "@phyxiusjs/fp";
import { z } from "zod";
import { createHandler, defineHandler, type HandlerJournalEvent } from "@phyxiusjs/handler";
import { createHttpAdapter } from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEchoFunction() {
  return defineFunction({
    name: "http.echo",
    layer: "data",
    input: z.object({ message: z.string() }),
    output: z.object({ echo: z.string() }),
    policy: {
      timeout: 5_000 as import("@phyxiusjs/clock").Millis,
      retry: NO_RETRY,
      circuitBreaker: NO_CIRCUIT_BREAKER,
    },
    handler: async (_ctx, input) => ok({ echo: input.message }),
  });
}

function makeFailingFunction() {
  return defineFunction({
    name: "http.fail",
    layer: "data",
    input: z.object({ message: z.string() }),
    output: z.object({ result: z.string() }),
    policy: {
      timeout: 5_000 as import("@phyxiusjs/clock").Millis,
      retry: NO_RETRY,
      circuitBreaker: NO_CIRCUIT_BREAKER,
    },
    handler: async (_ctx, _input) => err(ServiceError.internal("Deliberate test failure")),
  });
}

async function makeRequest(
  adapter: { handle(req: IncomingMessage, res: ServerResponse): Promise<void> },
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      await adapter.handle(req, res);
    });

    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unexpected server address type"));
        return;
      }

      const {port} = address;
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

      const reqHeaders: Record<string, string> = {
        "content-type": "application/json",
        ...headers,
      };
      if (bodyStr) {
        reqHeaders["content-length"] = String(Buffer.byteLength(bodyStr));
      }

      const req2 = request(
        {
          hostname: "localhost",
          port,
          path,
          method,
          headers: reqHeaders,
        },
        (res2: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res2.on("data", (c: Buffer) => chunks.push(c));
          res2.on("end", () => {
            server.close();
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsedBody: unknown;
            try {
              parsedBody = JSON.parse(raw);
            } catch {
              parsedBody = raw;
            }
            const responseHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res2.headers)) {
              if (v !== undefined) {
                responseHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
              }
            }
            resolve({ status: res2.statusCode ?? 0, body: parsedBody, headers: responseHeaders });
          });
        },
      );

      req2.on("error", (e: Error) => {
        server.close();
        reject(e);
      });

      if (bodyStr) {
        req2.write(bodyStr);
      }
      req2.end();
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("HTTP Adapter", () => {
  let clock: ReturnType<typeof createSystemClock>;
  let journal: Journal<HandlerJournalEvent>;
  let runtime: ReturnType<typeof createRuntime>;

  beforeEach(() => {
    clock = createSystemClock();
    journal = new Journal({ clock });
    runtime = createRuntime({ clock });
  });

  describe("route matching", () => {
    it("routes to the correct handler based on method and path", async () => {
      const fn = makeEchoFunction();
      const handler = createHandler(
        defineHandler({
          name: "echo",
          fn,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "POST",
            path: "/echo",
            handler,
            transform: (_params, body) => {
              const b = body as { message: string };
              return { message: b.message };
            },
          },
        ],
      });

      const response = await makeRequest(adapter, "POST", "/echo", { message: "hello" });
      expect(response.status).toBe(200);
      expect((response.body as { echo: string }).echo).toBe("hello");

      await handler.stop();
    });

    it("returns 404 for unmatched routes", async () => {
      const handler = createHandler(
        defineHandler({
          name: "echo",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "GET",
            path: "/known",
            handler,
            transform: () => ({ message: "test" }),
          },
        ],
      });

      const response = await makeRequest(adapter, "GET", "/unknown");
      expect(response.status).toBe(404);

      await handler.stop();
    });

    it("returns 405 when path matches but method does not", async () => {
      const handler = createHandler(
        defineHandler({
          name: "echo",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "POST",
            path: "/data",
            handler,
            transform: () => ({ message: "test" }),
          },
        ],
      });

      const response = await makeRequest(adapter, "GET", "/data");
      expect(response.status).toBe(405);

      await handler.stop();
    });

    it("static route wins over parameterized when path matches both", async () => {
      const echoFn = makeEchoFunction();

      const staticHandler = createHandler(
        defineHandler({
          name: "static",
          fn: echoFn,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      const paramHandler = createHandler(
        defineHandler({
          name: "param",
          fn: echoFn,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await staticHandler.start();
      await paramHandler.start();

      const adapter = createHttpAdapter({
        routes: [
          // Intentionally listed param first — adapter should sort by specificity
          {
            method: "GET",
            path: "/users/:id",
            handler: paramHandler,
            transform: (params) => ({ message: `user:${params.id}` }),
          },
          {
            method: "GET",
            path: "/users/me",
            handler: staticHandler,
            transform: () => ({ message: "static-me" }),
          },
        ],
      });

      const response = await makeRequest(adapter, "GET", "/users/me");
      expect(response.status).toBe(200);
      // Static handler returns "static-me", param would return "user:me"
      expect((response.body as { echo: string }).echo).toBe("static-me");

      await staticHandler.stop();
      await paramHandler.stop();
    });

    it("extracts path params and passes them to transform", async () => {
      const fn = makeEchoFunction();
      const handler = createHandler(
        defineHandler({
          name: "param-echo",
          fn,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "GET",
            path: "/greet/:name",
            handler,
            transform: (params) => ({ message: `Hello, ${params.name}!` }),
          },
        ],
      });

      const response = await makeRequest(adapter, "GET", "/greet/Alice");
      expect(response.status).toBe(200);
      expect((response.body as { echo: string }).echo).toBe("Hello, Alice!");

      await handler.stop();
    });
  });

  describe("response mapping", () => {
    it("returns 500 when handler execution fails", async () => {
      const handler = createHandler(
        defineHandler({
          name: "failing",
          fn: makeFailingFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "POST",
            path: "/fail",
            handler,
            transform: (_params, body) => {
              const b = body as { message: string };
              return { message: b.message };
            },
          },
        ],
      });

      const response = await makeRequest(adapter, "POST", "/fail", { message: "break" });
      expect(response.status).toBe(500);

      await handler.stop();
    });

    it("returns 503 via custom on503 handler when backpressure triggers", async () => {
      // Use a very slow function with tight concurrency to force backpressure
      const slowFn = defineFunction({
        name: "slow",
        layer: "data",
        input: z.object({ x: z.number() }),
        output: z.object({ x: z.number() }),
        policy: {
          timeout: 10_000 as import("@phyxiusjs/clock").Millis,
          retry: NO_RETRY,
          circuitBreaker: NO_CIRCUIT_BREAKER,
        },
        handler: async (_ctx, input) => {
          await new Promise((r) => setTimeout(r, 300));
          return ok({ x: input.x });
        },
      });

      const handler = createHandler(
        defineHandler({
          name: "slow",
          fn: slowFn,
          concurrency: { max: 1, backpressure: "reject", queueSize: 0 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "GET",
            path: "/slow",
            handler: handler as unknown as import("@phyxiusjs/handler").Handler<unknown, unknown>,
            transform: () => ({ x: 1 }),
          },
        ],
        on503: () => ({
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "1" },
          body: { error: "Overloaded" },
        }),
      });

      // Fire first request (fills the 1 slot)
      const first = makeRequest(adapter, "GET", "/slow");
      // Give it a tick to start executing
      await new Promise((r) => setTimeout(r, 20));
      // Fire second request while first is in-flight — queue is 0 so it should get 503
      const second = makeRequest(adapter, "GET", "/slow");

      const [r1, r2] = await Promise.all([first, second]);

      // One should succeed, the other should be 503
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toContain(200);
      expect(statuses).toContain(503);

      await handler.stop();
    });

    it("sets x-correlation-id on successful responses", async () => {
      const handler = createHandler(
        defineHandler({
          name: "corr",
          fn: makeEchoFunction(),
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "POST",
            path: "/corr",
            handler,
            transform: (_p, body) => ({ message: (body as { message: string }).message }),
          },
        ],
      });

      const response = await makeRequest(
        adapter,
        "POST",
        "/corr",
        { message: "hi" },
        {
          "x-correlation-id": "my-corr-id",
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers["x-correlation-id"]).toBe("my-corr-id");

      await handler.stop();
    });
  });

  describe("integration smoke test", () => {
    it("HTTP request → Handler → Journal entry with correct source and correlationId", async () => {
      const fn = makeEchoFunction();
      const handler = createHandler(
        defineHandler({
          name: "http.echo",
          fn,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal, runtime },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "POST",
            path: "/smoke",
            handler,
            transform: (_p, body) => ({ message: (body as { message: string }).message }),
          },
        ],
      });

      await makeRequest(
        adapter,
        "POST",
        "/smoke",
        { message: "integration" },
        {
          "x-correlation-id": "smoke-test-id",
        },
      );

      const snapshot = journal.getSnapshot();
      expect(snapshot.totalCount).toBe(1);

      const event = snapshot.entries[0]?.data;
      expect(event).toBeDefined();
      if (!event) return;

      expect(event.source).toBe("http");
      expect(event.correlationId).toBe("smoke-test-id");
      expect(event.outcome).toBe("success");
      expect(event.functionName).toBe("http.echo");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);

      await handler.stop();
    });
  });
});

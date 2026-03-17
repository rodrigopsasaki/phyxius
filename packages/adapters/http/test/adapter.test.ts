import { describe, it, expect, beforeEach } from "vitest";
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSystemClock } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { createHandler, defineHandler, type HandlerEvent } from "@phyxiusjs/handler";
import { createHttpAdapter } from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function echoProcessor(input: { message: string }): Promise<{ echo: string }> {
  return Promise.resolve({ echo: input.message });
}

function failingProcessor(_input: { message: string }): Promise<{ result: string }> {
  return Promise.reject(new Error("Deliberate test failure"));
}

function slowProcessor(input: { x: number }): Promise<{ x: number }> {
  return new Promise((resolve) => setTimeout(() => resolve({ x: input.x }), 300));
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

      const { port } = address;
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
  let journal: Journal<HandlerEvent>;

  beforeEach(() => {
    clock = createSystemClock();
    journal = new Journal({ clock });
  });

  describe("route matching", () => {
    it("routes to the correct handler based on method and path", async () => {
      const handler = createHandler(
        defineHandler({
          name: "echo",
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
      const staticHandler = createHandler(
        defineHandler({
          name: "static",
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
      );

      const paramHandler = createHandler(
        defineHandler({
          name: "param",
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
      );

      await staticHandler.start();
      await paramHandler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "GET",
            path: "/users/:id",
            handler: paramHandler,
            transform: (params) => ({ message: `user:${params["id"]}` }),
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
      expect((response.body as { echo: string }).echo).toBe("static-me");

      await staticHandler.stop();
      await paramHandler.stop();
    });

    it("extracts path params and passes them to transform", async () => {
      const handler = createHandler(
        defineHandler({
          name: "param-echo",
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
      );

      await handler.start();

      const adapter = createHttpAdapter({
        routes: [
          {
            method: "GET",
            path: "/greet/:name",
            handler,
            transform: (params) => ({ message: `Hello, ${params["name"]}!` }),
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
          processor: failingProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
      const handler = createHandler(
        defineHandler({
          name: "slow",
          processor: slowProcessor,
          concurrency: { max: 1, backpressure: "reject", queueSize: 0 },
        }),
        { clock, journal },
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

      const first = makeRequest(adapter, "GET", "/slow");
      await new Promise((r) => setTimeout(r, 20));
      const second = makeRequest(adapter, "GET", "/slow");

      const [r1, r2] = await Promise.all([first, second]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toContain(200);
      expect(statuses).toContain(503);

      await handler.stop();
    });

    it("sets x-correlation-id on successful responses", async () => {
      const handler = createHandler(
        defineHandler({
          name: "corr",
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
      const handler = createHandler(
        defineHandler({
          name: "http.echo",
          processor: echoProcessor,
          concurrency: { max: 5, backpressure: "reject", queueSize: 10 },
        }),
        { clock, journal },
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
      expect(event.handlerName).toBe("http.echo");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);

      // Verify HTTP metadata flows through to observed data
      expect(event.observed["method"]).toBe("POST");
      expect(event.observed["path"]).toBe("/smoke");

      await handler.stop();
    });
  });
});

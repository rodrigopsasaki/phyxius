import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import {
  createHandler,
  createHttpAdapter,
  DEFAULT_HANDLER_CONFIG,
  type HttpRequest,
  type HttpResponse,
  type HandlerEvent,
} from "../src/index.js";
import { EffectUtils } from "../src/utils.js";

describe("HTTP Adapter Integration", () => {
  let clock: ReturnType<typeof createSystemClock>;
  let events: HandlerEvent[];

  beforeEach(() => {
    clock = createSystemClock();
    events = [];
  });

  it("should process HTTP requests through the Handler", async () => {
    // Create HTTP adapter
    const httpAdapter = createHttpAdapter({ timeoutMs: 5000 });

    // Create Handler with simple HTTP processor
    const handler = createHandler<HttpRequest, HttpResponse>({
      name: "http-handler",
      processor: (request, _context) => {
        // Simple processor that echoes the request
        const response: HttpResponse = {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: {
            message: "Hello from Handler!",
            method: request.method,
            url: request.url,
            timestamp: Date.now(),
          },
        };
        return EffectUtils.succeed(response);
      },
      config: DEFAULT_HANDLER_CONFIG,
      clock,
      emit: (event) => events.push(event),
    });

    // Start the handler
    const startResult = await handler.start(httpAdapter).unsafeRunPromise();
    expect(startResult._tag).toBe("Ok");
    expect(handler.state).toBe("running");

    // Simulate an HTTP request
    const request: HttpRequest = {
      method: "GET",
      url: "/api/hello",
      headers: {
        "user-agent": "test-client/1.0",
        accept: "application/json",
      },
      body: null,
    };

    // Process the request
    const responsePromise = httpAdapter.simulateRequest(request);

    // Give the handler time to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await responsePromise;

    // Verify response
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toMatchObject({
      message: "Hello from Handler!",
      method: "GET",
      url: "/api/hello",
    });

    // Verify events were emitted
    expect(events.length).toBeGreaterThan(0);

    const startEvent = events.find((e) => e.type === "handler:started");
    expect(startEvent).toBeDefined();
    expect(startEvent?.handlerId).toBe(handler.id);

    const workEvents = events.filter((e) => e.type.startsWith("work:"));
    expect(workEvents.length).toBeGreaterThan(0);

    // Stop the handler
    const stopResult = await handler.stop().unsafeRunPromise();
    expect(stopResult._tag).toBe("Ok");
    expect(handler.state).toBe("stopped");
  });

  it("should handle processing errors gracefully", async () => {
    const httpAdapter = createHttpAdapter({ timeoutMs: 5000 });

    // Create Handler that always fails
    const handler = createHandler<HttpRequest, HttpResponse>({
      name: "failing-handler",
      processor: (_request, _context) => {
        return EffectUtils.fromPromise(Promise.reject(new Error("Processing failed intentionally")));
      },
      config: DEFAULT_HANDLER_CONFIG,
      clock,
      emit: (event) => events.push(event),
    });

    // Start the handler
    await handler.start(httpAdapter).unsafeRunPromise();

    // Simulate a request
    const request: HttpRequest = {
      method: "POST",
      url: "/api/fail",
      headers: {},
      body: { test: "data" },
    };

    const response = await httpAdapter.simulateRequest(request);

    // Should get error response
    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      error: "Internal Server Error",
    });

    // Give the handler time to emit events
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check that work completion was recorded as failure
    const completedEvents = events.filter((e) => e.type === "work:completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].success).toBe(false);

    await handler.stop().unsafeRunPromise();
  });

  it("should support different HTTP methods and complex responses", async () => {
    const httpAdapter = createHttpAdapter();

    // Create Handler that processes different HTTP methods
    const handler = createHandler<HttpRequest, HttpResponse>({
      name: "method-handler",
      processor: (request, _context) => {
        let response: HttpResponse;

        switch (request.method) {
          case "GET":
            response = {
              statusCode: 200,
              headers: { "content-type": "application/json" },
              body: { message: "GET successful", data: [] },
            };
            break;

          case "POST":
            response = {
              statusCode: 201,
              headers: { "content-type": "application/json" },
              body: { message: "Created", id: 123, input: request.body },
            };
            break;

          case "DELETE":
            response = {
              statusCode: 204,
              headers: {},
              body: null,
            };
            break;

          default:
            response = {
              statusCode: 405,
              headers: { allow: "GET, POST, DELETE" },
              body: { error: "Method not allowed" },
            };
        }

        return EffectUtils.succeed(response);
      },
      config: DEFAULT_HANDLER_CONFIG,
      clock,
    });

    await handler.start(httpAdapter).unsafeRunPromise();

    // Test GET
    const getResponse = await httpAdapter.simulateRequest({
      method: "GET",
      url: "/api/items",
      headers: {},
      body: null,
    });
    expect(getResponse.statusCode).toBe(200);

    // Test POST
    const postResponse = await httpAdapter.simulateRequest({
      method: "POST",
      url: "/api/items",
      headers: { "content-type": "application/json" },
      body: { name: "test item" },
    });
    expect(postResponse.statusCode).toBe(201);
    expect(postResponse.body).toMatchObject({
      message: "Created",
      id: 123,
      input: { name: "test item" },
    });

    // Test DELETE
    const deleteResponse = await httpAdapter.simulateRequest({
      method: "DELETE",
      url: "/api/items/123",
      headers: {},
      body: null,
    });
    expect(deleteResponse.statusCode).toBe(204);

    // Test unsupported method
    const patchResponse = await httpAdapter.simulateRequest({
      method: "PATCH",
      url: "/api/items/123",
      headers: {},
      body: {},
    });
    expect(patchResponse.statusCode).toBe(405);

    await handler.stop().unsafeRunPromise();
  });
});

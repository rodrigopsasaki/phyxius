import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import { effect, succeed } from "@phyxiusjs/effect";
import { Journal } from "@phyxiusjs/journal";
import { createHandler, DEFAULT_HANDLER_CONFIG, type ProcessorPipeline, type HandlerEvent } from "../src/index.js";
import { createHttpAdapter, type HttpRequest, type HttpResponse } from "../src/adapters/http.js";

describe("HTTP Adapter Integration", () => {
  let clock: ReturnType<typeof createSystemClock>;
  let events: HandlerEvent[];
  let journal: Journal<HandlerEvent>;

  beforeEach(() => {
    clock = createSystemClock();
    events = [];
    journal = new Journal({
      clock,
      maxEntries: 1000,
      overflow: "bounded:drop_oldest",
    });
  });

  it("should process HTTP requests through the Handler", async () => {
    const httpAdapter = createHttpAdapter(clock);

    // Simple processor that converts HTTP requests to responses
    const processor: ProcessorPipeline<HttpRequest, HttpResponse> = {
      process: (input: HttpRequest) =>
        succeed({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { message: `Hello from ${input.method} ${input.url}` },
        }),
    };

    const handler = createHandler({
      name: "http-test-handler",
      processor,
      config: DEFAULT_HANDLER_CONFIG,
      clock,
      journal,
      emit: (event) => events.push(event),
    });

    // Queue the request BEFORE starting the handler
    const requestPromise = httpAdapter.simulateRequest({
      method: "GET",
      url: "/api/test",
      headers: { "user-agent": "test-client" },
      body: null,
    });

    // Start handler with HTTP adapter - it will process the queued request
    const startResult = await handler.start(httpAdapter).unsafeRunPromise();
    expect(startResult._tag).toBe("Ok");
    expect(handler.state).toBe("running");

    // Wait for processing
    const response = await requestPromise;

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toEqual({
      message: "Hello from GET /api/test",
    });

    // Stop handler
    const stopResult = await handler.stop().unsafeRunPromise();
    expect(stopResult._tag).toBe("Ok");

    // Check that work was processed
    const workReceivedEvents = events.filter((e) => e.type === "work:received");
    const workCompletedEvents = events.filter((e) => e.type === "work:completed");

    expect(workReceivedEvents).toHaveLength(1);
    expect(workCompletedEvents).toHaveLength(1);
    expect(workCompletedEvents[0]?.success).toBe(true);
  });

  it("should handle processing errors gracefully", async () => {
    const httpAdapter = createHttpAdapter(clock);

    // Processor that always fails
    const processor: ProcessorPipeline<HttpRequest, HttpResponse> = {
      process: () =>
        effect(async () => ({
          _tag: "Err" as const,
          error: new Error("Processing failed"),
        })),
    };

    const handler = createHandler({
      name: "error-test-handler",
      processor,
      config: DEFAULT_HANDLER_CONFIG,
      clock,
      journal,
      emit: (event) => events.push(event),
    });

    // Queue request BEFORE starting handler
    const requestPromise = httpAdapter.simulateRequest({
      method: "POST",
      url: "/api/fail",
      headers: {},
      body: { data: "test" },
    });

    // Start handler
    const startResult = await handler.start(httpAdapter).unsafeRunPromise();
    expect(startResult._tag).toBe("Ok");

    const response = await requestPromise;

    // Should get error response
    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toHaveProperty("error", "Internal Server Error");

    // Stop handler
    await handler.stop().unsafeRunPromise();

    // Check that work failed properly
    const workCompletedEvents = events.filter((e) => e.type === "work:completed");
    expect(workCompletedEvents).toHaveLength(1);
    expect(workCompletedEvents[0]?.success).toBe(false);
  });

  it("should support different HTTP methods and complex responses", async () => {
    const httpAdapter = createHttpAdapter(clock);

    // Processor that handles different methods differently
    const processor: ProcessorPipeline<HttpRequest, HttpResponse> = {
      process: (input: HttpRequest) =>
        succeed(
          input.method === "POST"
            ? {
                statusCode: 201,
                headers: { "content-type": "application/json", location: "/api/new-resource" },
                body: { id: "123", created: true },
              }
            : {
                statusCode: 200,
                headers: { "content-type": "text/plain" },
                body: `Method: ${input.method}`,
              },
        ),
    };

    const handler = createHandler({
      name: "multi-method-handler",
      processor,
      config: DEFAULT_HANDLER_CONFIG,
      clock,
      journal,
      emit: (event) => events.push(event),
    });

    // Queue both requests BEFORE starting handler
    const postPromise = httpAdapter.simulateRequest({
      method: "POST",
      url: "/api/create",
      headers: { "content-type": "application/json" },
      body: { name: "test" },
    });

    const getPromise = httpAdapter.simulateRequest({
      method: "GET",
      url: "/api/test",
      headers: {},
      body: null,
    });

    // Start handler - it will process both queued requests
    await handler.start(httpAdapter).unsafeRunPromise();

    // Wait for both responses
    const [postResponse, getResponse] = await Promise.all([postPromise, getPromise]);

    expect(postResponse.statusCode).toBe(201);
    expect(postResponse.headers.location).toBe("/api/new-resource");
    expect(postResponse.body).toEqual({ id: "123", created: true });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.headers["content-type"]).toBe("text/plain");
    expect(getResponse.body).toBe("Method: GET");

    await handler.stop().unsafeRunPromise();

    // Should have processed both requests
    const workCompletedEvents = events.filter((e) => e.type === "work:completed");
    expect(workCompletedEvents).toHaveLength(2);
    expect(workCompletedEvents.every((e) => e.success)).toBe(true);
  });
});

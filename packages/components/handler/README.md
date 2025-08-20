# @phyxiusjs/handler

Reliable entrypoint abstraction for processing external work units with fault tolerance.

## What is Handler?

Handler is the **reliable boundary** between external systems and your business logic. It provides a transport-agnostic way to process work units (HTTP requests, queue messages, events) with built-in fault tolerance, observability, and resource management.

**The Problem**: External systems are unreliable. Processing can fail. Resources leak. Systems crash under load.

**The Solution**: Handler wraps your business logic with reliability primitives from the phyxius ecosystem.

## Features

- **Transport Agnostic**: HTTP, queues, streams plug in as adapters
- **Fault Tolerant**: Circuit breakers, timeouts, graceful error handling
- **Observable**: Complete event stream for monitoring and debugging
- **Resource Safe**: Automatic cleanup using Effect patterns
- **Context Aware**: Request-scoped data flows automatically
- **Production Ready**: Backpressure, metrics, graceful shutdown

## Quick Start

```bash
npm install @phyxiusjs/handler @phyxiusjs/clock
```

### Basic Usage

```typescript
import { createHandler, createHttpAdapter, DEFAULT_HANDLER_CONFIG } from "@phyxiusjs/handler";
import { createSystemClock } from "@phyxiusjs/clock";
import { EffectUtils } from "@phyxiusjs/handler";

// Create a handler that processes HTTP requests
const handler = createHandler({
  name: "api-handler",
  processor: (request, context) => {
    // Your business logic here
    const response = {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { message: "Hello from Handler!", timestamp: Date.now() },
    };

    return EffectUtils.succeed(response);
  },
  config: DEFAULT_HANDLER_CONFIG,
  clock: createSystemClock(),
  emit: (event) => console.log("Handler event:", event),
});

// Create an HTTP adapter (or your own transport)
const httpAdapter = createHttpAdapter();

// Start processing
await handler.start(httpAdapter).unsafeRunPromise();

// Handler is now processing requests!
console.log("Handler state:", handler.state); // "running"

// Gracefully stop
await handler.stop().unsafeRunPromise();
```

### With Error Handling

```typescript
const handler = createHandler({
  name: "robust-handler",
  processor: async (data, context) => {
    try {
      // Your business logic
      const result = await processData(data);
      return EffectUtils.succeed(result);
    } catch (error) {
      // Errors are automatically wrapped and handled
      return EffectUtils.fromPromise(Promise.reject(error));
    }
  },
  config: {
    ...DEFAULT_HANDLER_CONFIG,
    maxConcurrency: 5, // Process max 5 items concurrently
    timeoutMs: 10000, // 10 second timeout per item
    circuitBreaker: {
      failureThreshold: 10, // Open circuit after 10 failures
      windowMs: 60000, // In 1 minute window
      cooldownMs: 30000, // Wait 30s before retry
    },
  },
  clock: createSystemClock(),
  emit: (event) => {
    // Rich observability events
    if (event.type === "work:completed") {
      console.log(`Work ${event.correlationId}: ${event.success ? "SUCCESS" : "FAILED"} (${event.durationMs}ms)`);
    }
  },
});
```

## Architecture

```
External System → Adapter → Handler → Your Business Logic
                    ↓
            [Work Units with correlation IDs]
                    ↓
    [Circuit Breaker, Timeouts, Backpressure]
                    ↓
          [Request-scoped Context]
                    ↓
           [Complete Observability]
```

## Core Concepts

### Work Units

Everything flows through the system as **WorkUnits** - structured data with correlation IDs for tracing:

```typescript
interface WorkUnit<TInput> {
  correlationId: string; // For tracing
  input: TInput; // Your data
  receivedAt: Instant; // When received
  metadata?: Record<string, unknown>; // Optional context
}
```

### Adapters

Adapters handle transport-specific concerns. Handler works with any adapter:

```typescript
interface Adapter<TInput, TOutput> {
  receive(): AsyncIterable<WorkUnit<TInput>>; // Get work
  respond(id: string, result: WorkResult<TOutput>): Effect<AdapterError, void>; // Send response
  close(): Effect<AdapterError, void>; // Cleanup
  isHealthy(): boolean; // Health check
}
```

### Processors

Your business logic is a pure function:

```typescript
type ProcessorFn<TInput, TOutput> = (input: TInput, context: PhyxiusContext) => Effect<HandlerError, TOutput>;
```

## Built-in HTTP Adapter

The HTTP adapter demonstrates the pattern and works great for simple use cases:

```typescript
import { HttpRequest, HttpResponse, createHttpAdapter } from "@phyxiusjs/handler";

const httpAdapter = createHttpAdapter({ timeoutMs: 5000 });

const handler = createHandler<HttpRequest, HttpResponse>({
  name: "web-server",
  processor: (request, context) => {
    // Handle different HTTP methods
    switch (request.method) {
      case "GET":
        return EffectUtils.succeed({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { message: "Hello World" },
        });

      case "POST":
        return EffectUtils.succeed({
          statusCode: 201,
          headers: { "content-type": "application/json" },
          body: { created: true, data: request.body },
        });

      default:
        return EffectUtils.succeed({
          statusCode: 405,
          headers: { allow: "GET, POST" },
          body: { error: "Method not allowed" },
        });
    }
  },
  config: DEFAULT_HANDLER_CONFIG,
  clock: createSystemClock(),
});

await handler.start(httpAdapter).unsafeRunPromise();

// Simulate requests (in real usage, this would be your web server)
const response = await httpAdapter.simulateRequest({
  method: "GET",
  url: "/api/hello",
  headers: { accept: "application/json" },
  body: null,
});

console.log(response); // { statusCode: 200, body: { message: "Hello World" } }
```

## Observability

Handler emits comprehensive events for monitoring:

```typescript
const handler = createHandler({
  // ... config
  emit: (event) => {
    switch (event.type) {
      case "handler:started":
        console.log(`Handler ${event.handlerId} started with ${event.adapterName}`);
        break;

      case "work:received":
        console.log(`Work ${event.correlationId} queued (queue size: ${event.queueSize})`);
        break;

      case "work:completed":
        console.log(`Work ${event.correlationId} ${event.success ? "completed" : "failed"} in ${event.durationMs}ms`);
        break;

      case "circuit:opened":
        console.log(`Circuit breaker opened! ${event.errorCount} errors in ${event.windowMs}ms`);
        break;

      case "backpressure:triggered":
        console.log(`Backpressure triggered! Queue size: ${event.queueSize}, strategy: ${event.strategy}`);
        break;
    }
  },
});
```

## Metrics

Get real-time metrics about your handler:

```typescript
const metrics = handler.getMetrics();
console.log({
  state: metrics.state, // current state
  activeCount: metrics.activeCount, // work units being processed
  queueSize: metrics.queueSize, // work units waiting
  successCount: metrics.successCount, // total successful
  errorCount: metrics.errorCount, // total failed
  errorRate: metrics.errorRate, // errors per second
  avgProcessingTimeMs: metrics.avgProcessingTimeMs,
});
```

## Error Handling

Handler provides structured error handling with specific error codes:

```typescript
try {
  await handler.start(adapter).unsafeRunPromise();
} catch (error) {
  if (error instanceof HandlerError) {
    switch (error.code) {
      case "HANDLER_ALREADY_RUNNING":
        console.log("Handler is already running");
        break;
      case "ADAPTER_ERROR":
        console.log("Adapter failed:", error.cause);
        break;
      case "CIRCUIT_OPEN":
        console.log("Circuit breaker is open, requests failing fast");
        break;
    }
  }
}
```

## Custom Adapters

Create your own adapter for any transport:

```typescript
class QueueAdapter implements Adapter<QueueMessage, QueueResponse> {
  readonly name = "queue-adapter";

  async *receive() {
    while (this.isActive) {
      const messages = await this.pollQueue();
      for (const message of messages) {
        yield {
          correlationId: message.id,
          input: message,
          receivedAt: this.clock.now(),
          metadata: { source: "sqs", region: "us-east-1" },
        };
      }
    }
  }

  respond(correlationId: string, result: WorkResult<QueueResponse>) {
    // Ack/Nack the message based on result
    return result._tag === "Ok" ? this.ackMessage(correlationId) : this.nackMessage(correlationId);
  }

  close() {
    return EffectUtils.fromPromise(this.cleanup());
  }

  isHealthy() {
    return this.queueConnection.isHealthy();
  }
}
```

## Configuration

Customize behavior with comprehensive configuration:

```typescript
const config: HandlerConfig = {
  maxConcurrency: 10, // Max concurrent work units
  timeoutMs: 30000, // Per-work-unit timeout
  shutdownTimeoutMs: 10000, // Graceful shutdown timeout

  circuitBreaker: {
    failureThreshold: 10, // Failures before opening
    windowMs: 60000, // Time window for failures
    cooldownMs: 30000, // Wait before retry
  },

  backpressure: {
    maxQueueSize: 100, // Max queued work units
    overflowStrategy: "reject", // "reject" | "drop-oldest" | "drop-newest"
  },
};
```

## Why Handler?

### Before Handler

```typescript
// Fragile, hard to test, no observability
app.post("/api/data", async (req, res) => {
  try {
    const result = await processData(req.body); // Can hang forever
    res.json(result); // No retry logic
  } catch (error) {
    res.status(500).json({ error: "Something broke" }); // No tracing
  }
});
```

### After Handler

```typescript
// Reliable, observable, testable
const handler = createHandler({
  name: "data-processor",
  processor: (data, context) => {
    // Pure function, easy to test
    // Automatic timeout, context, tracing
    return processData(data);
  },
  config: PRODUCTION_CONFIG, // Circuit breaker, backpressure, etc.
  clock: createSystemClock(), // Deterministic time
  emit: sendToMonitoring, // Complete observability
});
```

## Next Steps

- **Extend with Queues**: Create adapters for SQS, Kafka, Redis
- **Add Process Supervision**: Integrate with `@phyxiusjs/process` for automatic restart
- **Event Sourcing**: Use `@phyxiusjs/journal` to record all processing events
- **Advanced Context**: Leverage `@phyxiusjs/context` for request-scoped dependencies

---

Handler transforms unreliable external interfaces into reliable, observable, testable components. It's the missing piece between your transport layer and business logic.

**Build reliable systems by construction, not by accident.**

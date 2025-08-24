# @phyxiusjs/handler

Process external work with explicit reliability decisions.

## What This Is

Handler is a boundary between your code and external systems. It makes you choose how to handle the things that will go wrong: timeouts, failures, overload. No magic, just explicit decisions.

## The Decisions You Make

When processing external work, you're making choices whether you realize it or not:

- How long before timeout?
- What happens on failure?
- How many retries?
- What about overload?
- How do you shut down cleanly?

Handler makes these decisions explicit and configurable.

## Installation

```bash
npm install @phyxiusjs/handler @phyxiusjs/clock @phyxiusjs/journal
```

## Basic Example

```typescript
import { createHandler, DEFAULT_HANDLER_CONFIG } from "@phyxiusjs/handler";
import { createSystemClock } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { succeed } from "@phyxiusjs/effect";

const handler = createHandler({
  name: "my-handler",
  processor: {
    process: (input, context) => {
      // Your business logic
      const result = doWork(input);
      return succeed(result);
    },
  },
  config: DEFAULT_HANDLER_CONFIG,
  clock: createSystemClock(),
  journal: new Journal({
    clock: createSystemClock(),
    maxEntries: 10000,
    overflow: "bounded:drop_oldest",
  }),
});

// Start with your adapter
await handler.start(adapter).unsafeRunPromise();

// Check metrics
const metrics = handler.getMetrics();
console.log(`Active: ${metrics.activeCount}, Queued: ${metrics.queueSize}`);

// Stop gracefully
await handler.stop().unsafeRunPromise();
```

## HTTP Example

```typescript
import { createHandler, createHttpAdapter } from "@phyxiusjs/handler";
import { succeed, effect } from "@phyxiusjs/effect";

const handler = createHandler<HttpRequest, HttpResponse>({
  name: "http-api",

  processor: {
    process: (request, context) => {
      if (request.method === "GET") {
        return succeed({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { message: "Hello" },
        });
      }

      if (request.method === "POST") {
        return effect(async () => {
          const result = await processData(request.body);
          return {
            _tag: "Ok",
            value: {
              statusCode: 201,
              headers: { "content-type": "application/json" },
              body: result,
            },
          };
        });
      }

      return succeed({
        statusCode: 405,
        headers: { allow: "GET, POST" },
        body: { error: "Method not allowed" },
      });
    },
  },

  config: {
    maxConcurrency: 20, // Process 20 at once
    timeoutMs: 30000, // 30 second timeout
    shutdownTimeoutMs: 10000, // 10 seconds to shut down

    circuitBreaker: {
      failureThreshold: 10, // Open after 10 failures
      windowMs: 60000, // In 60 seconds
      cooldownMs: 30000, // Wait 30 seconds before retry
    },

    backpressure: {
      maxQueueSize: 1000,
      overflowStrategy: "reject", // Your choice: reject, drop-oldest, drop-newest
    },
  },

  clock: createSystemClock(),
  journal: new Journal({ clock, maxEntries: 100000 }),
});

const httpAdapter = createHttpAdapter(clock);
await handler.start(httpAdapter).unsafeRunPromise();
```

## Architecture

```
External System
      ↓
   Adapter (Transport-specific)
      ↓
   Handler
      ├── Backpressure Queue (configurable limits)
      ├── Circuit Breaker (fail fast when broken)
      ├── Timeout Guard (nothing hangs forever)
      └── Process Supervision (restart on crash)
      ↓
Your Business Logic
```

## Observability

Handler emits events for everything that happens:

```typescript
const handler = createHandler({
  // ... config
  emit: (event) => {
    console.log(event);
    // Examples:
    // { type: "work:received", correlationId: "xyz", queueSize: 10 }
    // { type: "work:completed", correlationId: "xyz", durationMs: 145, success: true }
    // { type: "circuit:opened", errorCount: 10, windowMs: 60000 }
    // { type: "backpressure:triggered", queueSize: 1000 }
  },
});
```

Get metrics anytime:

```typescript
const metrics = handler.getMetrics();
// {
//   state: "running",
//   activeCount: 15,
//   queueSize: 234,
//   successCount: 10523,
//   errorCount: 47,
//   errorRate: 0.12,
//   throughputPerSecond: 89.3,
//   avgProcessingTimeMs: 124,
//   p95ProcessingTimeMs: 451
// }
```

## Testing

Use controlled time for deterministic tests:

```typescript
import { createControlledClock } from "@phyxiusjs/clock";

test("timeout behavior", async () => {
  const clock = createControlledClock();

  const handler = createHandler({
    processor: {
      process: async (input) => {
        await clock.sleep(1000);
        return succeed({ processed: input });
      },
    },
    config: {
      ...DEFAULT_HANDLER_CONFIG,
      timeoutMs: 500,
    },
    clock,
  });

  await handler.start(adapter).unsafeRunPromise();

  // Trigger timeout
  clock.advance(600);

  // Verify timeout happened
});
```

## Custom Adapters

Create adapters for any transport:

```typescript
class MyAdapter implements Adapter<Input, Output> {
  async *receive() {
    // Yield work units as they arrive
    while (this.isActive) {
      const work = await this.getWork();
      yield {
        correlationId: generateId(),
        input: work,
        receivedAt: this.clock.now(),
      };
    }
  }

  respond(correlationId, result) {
    // Send response back
    if (result._tag === "Ok") {
      return this.sendSuccess(correlationId, result.value);
    } else {
      return this.sendError(correlationId, result.error);
    }
  }

  close() {
    // Cleanup
    return this.disconnect();
  }

  isHealthy() {
    return this.connection.isAlive();
  }
}
```

## Configuration Choices

Every config option is a decision you're making explicitly:

```typescript
{
  maxConcurrency: 10,        // How much parallel work?
  timeoutMs: 30000,          // How long is too long?
  shutdownTimeoutMs: 10000,  // How long to wait for graceful shutdown?

  circuitBreaker: {
    failureThreshold: 10,    // How many failures before giving up?
    windowMs: 60000,         // Over what time period?
    cooldownMs: 30000        // How long before trying again?
  },

  backpressure: {
    maxQueueSize: 100,       // How much to buffer?
    overflowStrategy: "reject" // What to do when full?
  }
}
```

## What Handler Doesn't Do

- Doesn't prevent all failures (they still happen)
- Doesn't make async code synchronous
- Doesn't hide complexity (it exposes it)
- Doesn't work without configuration (you must choose)

## What Handler Does Do

- Makes timeout/retry/backpressure decisions explicit
- Provides metrics and events for everything
- Cleans up resources properly
- Shuts down gracefully
- Works with any transport via adapters
- Tests deterministically with controlled time

## Using with Phyxius

Handler uses these Phyxius primitives:

- **Clock**: All time operations
- **Atom**: State management without races
- **Effect**: Structured async with cleanup
- **Process**: Supervised execution
- **Journal**: Event history
- **FP Utils**: Explicit error handling

## Production Notes

Things to consider:

- Set timeouts based on your SLAs
- Choose backpressure strategy based on your workload
- Monitor circuit breaker opens
- Watch queue sizes
- Configure graceful shutdown timeout
- Test with controlled clock for edge cases

## Status

We use this in production. It works for us. Your mileage may vary.

## License

MIT

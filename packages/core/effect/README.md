# Effect

**Async that can't leak. Resources that clean up. Concurrency you can reason about.**

Every production outage you've debugged starts the same way: resources leak, operations hang, promises never resolve, timeouts don't work, cleanup never happens.

Effect fixes this. Structured concurrency, automatic cleanup, explicit errors.

## The Problem

```typescript
// This is broken. The leaks just haven't killed you yet.
async function fetchWithTimeout(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();

    // Timeout that might not clean up
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Timeout"));
    }, 5000);

    // Request that might not be cancelled
    fetch(url, { signal: controller.signal })
      .then((response) => response.text())
      .then((text) => {
        clearTimeout(timeout); // Did this run?
        resolve(text);
      })
      .catch((error) => {
        clearTimeout(timeout); // What about this?
        reject(error);
      });
  });
}

// Concurrent operations with no cleanup guarantee
Promise.race([
  fetchWithTimeout("https://api1.com"),
  fetchWithTimeout("https://api2.com"),
  fetchWithTimeout("https://api3.com"),
]);
// Two of these will "lose" the race. Did they clean up? Are they still running?
```

Promises are fire-and-forget missiles. Once launched, you can't reliably cancel them, manage their resources, or prevent them from doing work after you've moved on.

## The Solution

```typescript
import { effect, race, sleep } from "@phyxius/effect";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();

// Interruptible, resource-safe async computation
const fetchData = effect(async (env) => {
  // Check for cancellation
  if (env.cancel.isCanceled()) {
    return { _tag: "Err", error: "Cancelled" };
  }

  const response = await fetch("https://api.com");
  const data = await response.text();

  return { _tag: "Ok", value: data };
});

// Race with automatic cleanup of losers
const winner = await race([
  fetchData,
  fetchData.timeout(1000), // Loser gets cancelled automatically
  sleep(2000), // This too
]).unsafeRunPromise({ clock });

// All losing effects are interrupted and cleaned up
```

Effects are blueprints, not executions. They describe what you want to do without doing it. When you run them, you get structured concurrency, automatic cleanup, and explicit error handling.

## Start Simple: Basic Effects

```typescript
import { effect, succeed, fail } from "@phyxius/effect";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();

// Create effects (don't run them yet)
const successful = succeed(42);
const failing = fail(new Error("Oops"));

// Compose effects
const doubled = successful.map((x) => x * 2);

// Run them
const result1 = await doubled.unsafeRunPromise({ clock });
console.log(result1); // { _tag: "Ok", value: 84 }

const result2 = await failing.unsafeRunPromise({ clock });
console.log(result2); // { _tag: "Err", error: Error("Oops") }
```

Effects use `Result<E, A>` types instead of throwing exceptions. Success is `{ _tag: "Ok", value: A }`, failure is `{ _tag: "Err", error: E }`. No surprise exceptions.

## Add Async: Promise Integration

```typescript
import { fromPromise, effect } from "@phyxius/effect";

// Wrap existing promises
const apiCall = fromPromise(fetch("https://api.com"));

// Custom async effects
const customEffect = effect(async (env) => {
  // Access the environment for cancellation, clock, etc
  const start = env.clock?.now().wallMs ?? Date.now();

  // Do async work
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const end = env.clock?.now().wallMs ?? Date.now();

  return { _tag: "Ok", value: end - start };
});

const result = await customEffect.unsafeRunPromise({ clock });
console.log(result); // { _tag: "Ok", value: 1000 }
```

`fromPromise` converts existing promises into Effects. Custom effects get access to the environment with cancellation tokens, clock, and scope for resource management.

## Add Cancellation: Interruptible Operations

```typescript
import { effect, sleep } from "@phyxius/effect";

const longRunning = effect(async (env) => {
  for (let i = 0; i < 100; i++) {
    // Check for cancellation on each iteration
    if (env.cancel.isCanceled()) {
      return { _tag: "Err", error: "Cancelled" };
    }

    // Simulate work
    await sleep(100).unsafeRunPromise({ clock });
    console.log(`Step ${i}`);
  }

  return { _tag: "Ok", value: "Completed" };
});

// Fork the effect (run in background)
const fiber = await longRunning.fork().unsafeRunPromise({ clock });

// Wait a bit
await sleep(500).unsafeRunPromise({ clock });

// Interrupt it
await fiber.interrupt().unsafeRunPromise({ clock });
console.log("Effect was interrupted");
```

Fibers are lightweight threads that can be interrupted cleanly. Interruption propagates through the cancellation token, allowing operations to clean up gracefully.

## Add Timeouts: Guaranteed Deadlines

```typescript
import { effect, sleep } from "@phyxius/effect";

const slowOperation = effect(async () => {
  await sleep(5000).unsafeRunPromise({ clock }); // 5 seconds
  return { _tag: "Ok", value: "Finally done" };
});

// Timeout after 2 seconds
const timedOperation = slowOperation.timeout(2000);

const result = await timedOperation.unsafeRunPromise({ clock });
console.log(result); // { _tag: "Err", error: { _tag: "Timeout" } }
```

Timeouts are first-class citizens. They respect the clock abstraction, so they work perfectly in tests with controlled time.

## Add Resource Management: RAII Pattern

```typescript
import { acquireUseRelease, effect } from "@phyxius/effect";

// Resource that needs cleanup
class DatabaseConnection {
  constructor(public url: string) {}

  async query(sql: string): Promise<any> {
    console.log(`Querying: ${sql}`);
    return { rows: [] };
  }

  async close(): Promise<void> {
    console.log("Database connection closed");
  }
}

const withDatabase = acquireUseRelease(
  // Acquire: Create the resource
  effect(async () => {
    const conn = new DatabaseConnection("postgresql://...");
    console.log("Database connection opened");
    return { _tag: "Ok", value: conn };
  }),

  // Use: Do work with the resource
  (conn) =>
    effect(async () => {
      const result = await conn.query("SELECT * FROM users");
      return { _tag: "Ok", value: result };
    }),

  // Release: Clean up (guaranteed to run)
  (conn, cause) =>
    effect(async () => {
      console.log(`Closing connection due to: ${cause}`);
      await conn.close();
      return { _tag: "Ok", value: undefined };
    }),
);

const result = await withDatabase.unsafeRunPromise({ clock });
// Output:
// Database connection opened
// Querying: SELECT * FROM users
// Closing connection due to: ok
```

`acquireUseRelease` guarantees cleanup. The release function always runs with the cause - whether the operation succeeded ("ok"), failed ("error"), or was interrupted ("interrupted").

## Add Error Recovery: Retry Logic

```typescript
import { effect } from "@phyxius/effect";

let attempts = 0;

const flakyOperation = effect(async () => {
  attempts++;
  console.log(`Attempt ${attempts}`);

  if (attempts < 3) {
    return { _tag: "Err", error: new Error(`Failure ${attempts}`) };
  }

  return { _tag: "Ok", value: "Success!" };
});

const retriedOperation = flakyOperation.retry({
  maxAttempts: 5,
  baseDelayMs: 100,
  backoffFactor: 2,
  maxDelayMs: 1000,
});

const result = await retriedOperation.unsafeRunPromise({ clock });
console.log(result); // { _tag: "Ok", value: "Success!" }

// Output:
// Attempt 1
// Attempt 2
// Attempt 3
```

Retry policies use exponential backoff with configurable limits. Delays respect the clock abstraction for perfect testing.

## Add Concurrency: Race and Parallel

```typescript
import { race, all, effect, sleep } from "@phyxius/effect";

const fast = effect(async () => {
  await sleep(100).unsafeRunPromise({ clock });
  return { _tag: "Ok", value: "Fast" };
});

const slow = effect(async () => {
  await sleep(1000).unsafeRunPromise({ clock });
  return { _tag: "Ok", value: "Slow" };
});

const timeout = effect(async () => {
  await sleep(500).unsafeRunPromise({ clock });
  return { _tag: "Err", error: "Timeout" };
});

// Race: First to complete wins, others are cancelled
const winner = await race([fast, slow, timeout]).unsafeRunPromise({ clock });
console.log(winner); // { _tag: "Ok", value: "Fast" }

// Parallel: All must succeed
const allResults = await all([fast, fast, fast]).unsafeRunPromise({ clock });
console.log(allResults); // { _tag: "Ok", value: ["Fast", "Fast", "Fast"] }
```

`race` cancels the losers automatically. `all` fails fast if any effect fails. Both provide structured concurrency with guaranteed cleanup.

## Add Observability: Complete Telemetry

```typescript
import { effect, sleep } from "@phyxius/effect";

const observable = effect(
  async (env) => {
    await sleep(100).unsafeRunPromise({ clock });
    return { _tag: "Ok", value: "Done" };
  },
  {
    emit: (event) => {
      console.log("Effect event:", event);
    },
  },
);

const result = await observable.unsafeRunPromise({ clock });
// Output:
// Effect event: { type: "effect:start", effectId: "...", timestamp: 1640995200000 }
// Effect event: { type: "effect:success", effectId: "...", timestamp: 1640995200100 }
```

Every operation emits structured events. Monitor performance, track errors, understand exactly what's happening in your async operations.

## Advanced: Error Handling

```typescript
import { effect, fail } from "@phyxius/effect";

const risky = effect(async () => {
  if (Math.random() < 0.5) {
    return { _tag: "Err", error: "Network error" };
  }
  return { _tag: "Ok", value: "Success" };
});

// Handle specific errors
const recovered = risky.catch((error) => {
  if (error === "Network error") {
    return effect(async () => ({ _tag: "Ok", value: "Fallback data" }));
  }
  return fail(error); // Re-throw other errors
});

// Chain operations
const pipeline = risky
  .map((data) => data.toUpperCase())
  .flatMap((data) => effect(async () => ({ _tag: "Ok", value: `Processed: ${data}` })))
  .catch((error) => effect(async () => ({ _tag: "Ok", value: `Error: ${error}` })));

const result = await pipeline.unsafeRunPromise({ clock });
console.log(result); // { _tag: "Ok", value: "Processed: SUCCESS" } or "Error: Network error"
```

Error handling is explicit and composable. Use `catch` for recovery, `map` for transformations, `flatMap` for chaining. No hidden exceptions.

## Advanced: Fiber Coordination

```typescript
import { effect, sleep, all } from "@phyxius/effect";

async function coordinatedWork() {
  // Start three concurrent operations
  const fiber1 = await effect(async () => {
    await sleep(1000).unsafeRunPromise({ clock });
    return { _tag: "Ok", value: "Task 1" };
  })
    .fork()
    .unsafeRunPromise({ clock });

  const fiber2 = await effect(async () => {
    await sleep(800).unsafeRunPromise({ clock });
    return { _tag: "Ok", value: "Task 2" };
  })
    .fork()
    .unsafeRunPromise({ clock });

  const fiber3 = await effect(async () => {
    await sleep(1200).unsafeRunPromise({ clock });
    return { _tag: "Ok", value: "Task 3" };
  })
    .fork()
    .unsafeRunPromise({ clock });

  // Wait for all to complete
  const results = await all([fiber1.join(), fiber2.join(), fiber3.join()]).unsafeRunPromise({ clock });

  return results;
}

const results = await coordinatedWork();
console.log(results); // { _tag: "Ok", value: ["Task 1", "Task 2", "Task 3"] }
```

Fibers enable CSP-style concurrency. Fork operations, coordinate with join, interrupt when needed. Perfect for worker pools, pipeline processing, and concurrent data flows.

## Advanced: Custom Resource Scopes

```typescript
import { effect, acquireUseRelease } from "@phyxius/effect";

// Complex resource with multiple cleanup steps
class HttpServer {
  private connections = new Set<string>();

  constructor(public port: number) {}

  start(): void {
    console.log(`Server listening on port ${this.port}`);
  }

  addConnection(id: string): void {
    this.connections.add(id);
    console.log(`Connection ${id} added`);
  }

  async stop(): Promise<void> {
    console.log("Graceful shutdown starting...");

    // Close all connections
    for (const conn of this.connections) {
      console.log(`Closing connection ${conn}`);
    }
    this.connections.clear();

    console.log("Server stopped");
  }
}

const withServer = acquireUseRelease(
  // Acquire server
  effect(async () => {
    const server = new HttpServer(8080);
    server.start();
    return { _tag: "Ok", value: server };
  }),

  // Use server
  (server) =>
    effect(async (env) => {
      // Simulate handling requests
      server.addConnection("conn-1");
      server.addConnection("conn-2");

      // Simulate some work
      await sleep(1000).unsafeRunPromise({ clock });

      // Maybe an error occurs
      if (Math.random() < 0.3) {
        return { _tag: "Err", error: "Request failed" };
      }

      return { _tag: "Ok", value: "Requests handled" };
    }),

  // Release (always runs regardless of success/failure)
  (server, cause) =>
    effect(async () => {
      console.log(`Shutdown cause: ${cause}`);
      await server.stop();
      return { _tag: "Ok", value: undefined };
    }),
);

const result = await withServer.unsafeRunPromise({ clock });
// Output:
// Server listening on port 8080
// Connection conn-1 added
// Connection conn-2 added
// Shutdown cause: ok (or error)
// Graceful shutdown starting...
// Closing connection conn-1
// Closing connection conn-2
// Server stopped
```

Resource management with cause propagation. Cleanup code knows whether it's running due to success, failure, or interruption.

## The Full Power: Distributed System Orchestration

```typescript
import { effect, race, all, sleep, acquireUseRelease } from "@phyxius/effect";

// Distributed cache with automatic failover
class CacheNode {
  constructor(
    public id: string,
    public healthy: boolean = true,
  ) {}

  async get(key: string): Promise<string | null> {
    if (!this.healthy) throw new Error(`Node ${this.id} is down`);
    await sleep(Math.random() * 100).unsafeRunPromise({ clock });
    return Math.random() < 0.7 ? `value-${key}` : null;
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.healthy) throw new Error(`Node ${this.id} is down`);
    await sleep(Math.random() * 50).unsafeRunPromise({ clock });
  }

  markDown(): void {
    this.healthy = false;
  }
  markUp(): void {
    this.healthy = true;
  }
}

class DistributedCache {
  constructor(private nodes: CacheNode[]) {}

  // Get with failover - try all nodes, return first success
  get(key: string): Effect<string, string> {
    const attempts = this.nodes.map((node) =>
      effect(async () => {
        const value = await node.get(key);
        if (value === null) {
          return { _tag: "Err", error: `Cache miss on ${node.id}` };
        }
        return { _tag: "Ok", value };
      }).catch((error) => effect(async () => ({ _tag: "Err", error: `${node.id}: ${error}` }))),
    );

    return race(attempts);
  }

  // Set with replication - write to all healthy nodes
  set(key: string, value: string): Effect<string, void> {
    const writes = this.nodes
      .filter((node) => node.healthy)
      .map((node) =>
        effect(async () => {
          await node.set(key, value);
          return { _tag: "Ok", value: undefined };
        }),
      );

    return all(writes).map(() => undefined);
  }

  // Health check with automatic recovery
  healthCheck(): Effect<never, void> {
    return effect(async (env) => {
      while (!env.cancel.isCanceled()) {
        // Check each node
        for (const node of this.nodes) {
          try {
            await node.get("health-check");
            if (!node.healthy) {
              console.log(`Node ${node.id} recovered`);
              node.markUp();
            }
          } catch {
            if (node.healthy) {
              console.log(`Node ${node.id} failed`);
              node.markDown();
            }
          }
        }

        // Wait before next check
        await sleep(5000).unsafeRunPromise({ clock });
      }

      return { _tag: "Ok", value: undefined };
    });
  }
}

// Service orchestration with graceful shutdown
const runCacheService = acquireUseRelease(
  // Acquire: Initialize the distributed cache
  effect(async () => {
    const nodes = [new CacheNode("node-1"), new CacheNode("node-2"), new CacheNode("node-3")];

    const cache = new DistributedCache(nodes);
    console.log("Distributed cache initialized");

    return { _tag: "Ok", value: cache };
  }),

  // Use: Run the cache service
  (cache) =>
    effect(async (env) => {
      // Start health check in background
      const healthFiber = await cache.healthCheck().fork().unsafeRunPromise({ clock });

      // Simulate cache operations
      for (let i = 0; i < 10 && !env.cancel.isCanceled(); i++) {
        // Try to get value
        const getResult = await cache.get(`key-${i}`).unsafeRunPromise({ clock });

        if (getResult._tag === "Err") {
          // Cache miss - set the value
          const setResult = await cache.set(`key-${i}`, `data-${i}`).unsafeRunPromise({ clock });

          if (setResult._tag === "Ok") {
            console.log(`Cached key-${i}`);
          } else {
            console.log(`Failed to cache key-${i}: ${setResult.error}`);
          }
        } else {
          console.log(`Cache hit: key-${i} = ${getResult.value}`);
        }

        await sleep(1000).unsafeRunPromise({ clock });
      }

      // Clean shutdown of health check
      await healthFiber.interrupt().unsafeRunPromise({ clock });

      return { _tag: "Ok", value: "Service completed successfully" };
    }),

  // Release: Graceful shutdown
  (cache, cause) =>
    effect(async () => {
      console.log(`Cache service shutdown: ${cause}`);
      // Drain pending operations, save state, etc.
      return { _tag: "Ok", value: undefined };
    }),
);

// Run the service with timeout and interruption support
const serviceWithTimeout = runCacheService.timeout(30000);

const result = await serviceWithTimeout.unsafeRunPromise({ clock });

if (result._tag === "Ok") {
  console.log("Service completed:", result.value);
} else if (result.error._tag === "Timeout") {
  console.log("Service timed out");
} else {
  console.log("Service failed:", result.error);
}
```

This is the full power of Effect. Distributed systems with failover, health checks, replication, graceful shutdown, timeout handling, and perfect resource cleanup. Every operation is interruptible, every resource is managed, every error is explicit.

## Interface

```typescript
interface Effect<E, A> {
  unsafeRunPromise(env?: Partial<EffectEnv>): Promise<Result<E, A>>;
  map<B>(fn: (value: A) => B): Effect<E, B>;
  flatMap<E2, B>(fn: (value: A) => Effect<E2, B>): Effect<E | E2, B>;
  catch<E2, B>(fn: (error: E) => Effect<E2, B>): Effect<E2, A | B>;
  timeout(ms: number): Effect<E | { _tag: "Timeout" }, A>;
  fork(): Effect<never, Fiber<E, A>>;
  retry(policy: RetryPolicy): Effect<E | { _tag: "Interrupted" }, A>;
}

type Result<E, A> = { _tag: "Ok"; value: A } | { _tag: "Err"; error: E };

interface EffectEnv {
  clock?: Clock;
  cancel: CancelToken;
  scope: Scope;
}

interface Fiber<E, A> {
  join(): Effect<E, A>;
  interrupt(): Effect<never, void>;
  poll(): Effect<never, Result<E, A> | undefined>;
}
```

## Installation

```bash
npm install @phyxius/effect @phyxius/clock
```

## What You Get

**Async that can't leak.** Structured concurrency guarantees cleanup. No zombie operations, no resource leaks.

**Resources that clean up.** RAII pattern with cause propagation. Acquire/use/release cycle always completes.

**Concurrency you can reason about.** Fibers, cancellation, timeouts, race conditions - all explicit and composable.

**Errors you can handle.** No surprise exceptions. `Result` types make success and failure explicit.

**Systems that scale.** From simple async operations to distributed orchestration. One abstraction, infinite scale.

Effect solves async. Everything else builds on that foundation.

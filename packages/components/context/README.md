# Context

Static data that flows through your code. Values without parameter threading. Ambient access that just works.

Every bug you've traced that starts with "where did this value come from?" comes back to the same problem: values get lost, parameters explode, and context disappears across async boundaries.

Context fixes this. Static data bag, automatic propagation, zero parameter threading.

Two implementations, one interface:

- AsyncLocalStorage context for Node.js applications with automatic async propagation.
- Global context fallback for environments without AsyncLocalStorage support.

---

## Why parameter threading is broken

### Deep function parameter pollution

```js
// This is broken. Every function becomes a parameter tunnel.
async function handleRequest(req, res) {
  const userId = req.headers["user-id"];
  const traceId = req.headers["x-trace-id"];
  const requestId = generateId();

  await processOrder(req.body, userId, traceId, requestId);
}

async function processOrder(order, userId, traceId, requestId) {
  await validateOrder(order, userId, traceId, requestId);
  await chargePayment(order, userId, traceId, requestId);
  await updateInventory(order, userId, traceId, requestId);
}

// Every function signature polluted with context parameters
async function validateOrder(order, userId, traceId, requestId) {
  console.log(`[${traceId}] [${requestId}] Validating order for ${userId}`);
}
```

### Lost values in async operations

```js
// Global state gets mixed up across concurrent operations
let currentUserId = null;
let currentTraceId = null;

async function handleRequest(req, res) {
  currentUserId = req.headers["user-id"];
  currentTraceId = req.headers["x-trace-id"];

  // These run concurrently - context gets scrambled
  await Promise.all([processOrder(req.body), logActivity("request_received"), updateMetrics()]);
}

async function processOrder(order) {
  // Which user? Which request? Global state is unreliable.
  console.log(`Processing order for ${currentUserId}`);
}
```

Manual parameter passing becomes impossible at scale. Global variables create race conditions. You need automatic value propagation without the ceremony.

---

## The Problem

Applications need contextual information to flow through complex async call chains without manually threading parameters through every function signature.

```ts
// Parameter explosion makes functions unusable
class OrderProcessor {
  async process(
    order: Order,
    userId: string,
    traceId: string,
    requestId: string,
    sessionId: string,
    permissions: string[],
    metadata: Record<string, unknown>,
  ) {
    // Every method needs all these parameters
    await this.validate(order, userId, traceId, requestId, sessionId, permissions, metadata);
    await this.charge(order, userId, traceId, requestId, sessionId, permissions, metadata);
    await this.fulfill(order, userId, traceId, requestId, sessionId, permissions, metadata);
  }
}
```

---

## Context helps you with this

### Example 1 — Automatic value propagation

```ts
import { context } from "@phyxius/context";

// Values flow automatically through async operations
async function handleRequest(req: Request) {
  await context.scope(async () => {
    context.set("user_id", req.headers["user-id"]);
    context.set("trace_id", req.headers["x-trace-id"]);
    context.set("request_id", generateId());

    await processOrder(req.body);
  });
}

async function processOrder(order: any) {
  // Values are automatically available, no parameters needed
  const userId = context.get("user_id");
  const traceId = context.get("trace_id");
  const requestId = context.get("request_id");

  console.log(`[${traceId}] [${requestId}] Processing order for ${userId}`);

  await validateOrder(order);
  await chargePayment(order);
}

async function validateOrder(order: any) {
  // Context automatically flows through all function calls
  const userId = context.get("user_id");
  const traceId = context.get("trace_id");

  console.log(`[${traceId}] Validating order for ${userId}`);
}
```

### Example 2 — Nested contexts with inheritance

```ts
async function handleBatchJob() {
  await context.scope(async () => {
    context.set("job_id", "batch_001");
    context.set("start_time", Date.now());

    for (let i = 0; i < 100; i++) {
      // Each item gets its own context that inherits job info
      await context.scope(async () => {
        context.set("item_id", i);
        context.set("attempt", 1);

        const jobId = context.get("job_id"); // Available from parent
        const itemId = context.get("item_id"); // From current context

        console.log(`Job ${jobId} processing item ${itemId}`);
        await processItem();
      });
    }
  });
}
```

### Example 3 — Building structured metadata incrementally

```ts
async function handleApiRequest(req: Request) {
  await context.scope(async () => {
    // Start with basic request info
    context.merge("request", {
      method: req.method,
      path: req.path,
      ip: req.ip,
    });

    // Add authentication details
    if (req.user) {
      context.merge("request", {
        user_id: req.user.id,
        role: req.user.role,
      });
    }

    // Collect events as they happen
    context.push("events", "request_started");

    await processRequest(req);

    context.push("events", "request_completed");

    // Full context available at the end
    const requestInfo = context.get("request");
    const events = context.get("events");
    console.log("Request completed:", { requestInfo, events });
  });
}
```

### Example 4 — Concurrent operations with isolated contexts

```ts
async function processBatch(items: any[]) {
  // Each item gets its own isolated context
  const results = await Promise.all(
    items.map((item) =>
      context.scope(async () => {
        context.set("item_id", item.id);
        context.set("worker", `worker_${Math.random()}`);

        // Work in complete isolation
        await processItem(item);

        return {
          id: context.get("item_id"),
          worker: context.get("worker"),
          result: "completed",
        };
      }),
    ),
  );

  return results;
}
```

---

## Context does NOT help you with this

### Example 1 — Complex business logic

```ts
// Not Context's job - use domain services:
class OrderService {
  async validateOrder(order: Order): Promise<ValidationResult> {
    // Business logic goes here
    return this.validator.validate(order);
  }
}
```

### Example 2 — State management

```ts
// Not Context's job - use state libraries:
const store = createStore(orderReducer);
store.dispatch(createOrder(order));
```

### Example 3 — Database connections

```ts
// Not Context's job - use connection pools:
const db = createPool({ connectionString: "..." });
await db.query("SELECT * FROM orders");
```

---

## Why not just use global variables?

Global variables seem simple but create serious problems in concurrent applications:

- **Race conditions**: Multiple async operations modify the same globals simultaneously.
- **Lost context**: Values get overwritten before async operations complete.
- **No isolation**: Concurrent requests interfere with each other.
- **No scoping**: Values persist longer than they should.

Context uses AsyncLocalStorage to provide isolated value propagation that works correctly with async operations.

---

## What this is not

Context is not a dependency injection system, not a state manager, not a database. It does not replace service containers, Redux, or data access layers. It does not handle serialization, persistence, or network propagation.

Context is focused on local value propagation within a single process. It provides a simple data bag that flows through your async execution without manual parameter passing.

If you want dependency injection, use a DI container. If you want distributed tracing, use OpenTelemetry. If you want ambient values that flow through your code, use Context.

---

## Installation

```bash
npm install @phyxius/context
```

---

## What you get

- Static data that flows through your code: values automatically propagate through async operations.
- Values without parameter threading: no more polluted function signatures.
- Ambient access that just works: get values where you need them without ceremony.

Context does not fix async programming. It gives you automatic value propagation to eliminate parameter threading and make contextual data available where you need it. Everything else builds on that foundation.

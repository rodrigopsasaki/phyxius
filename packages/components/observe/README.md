# @phyxiusjs/observe

> Observability utilities for manipulating context data

Observe provides a convenient namespace with static functions for adding observability data to contexts created by `@phyxiusjs/context`. It's a thin layer that makes it easy to set, increment, and track data without directly manipulating context objects.

## Installation

```bash
npm install @phyxiusjs/observe @phyxiusjs/context
```

## Quick Start

```typescript
import { context } from "@phyxiusjs/context";
import { observe } from "@phyxiusjs/observe";

await context.scope(
  async () => {
    // Set operation metadata
    observe.set("operation", "user.login");
    observe.set("startTime", Date.now());

    // Track events as they happen
    observe.push("events", { type: "auth.attempt", method: "password" });

    // Increment counters
    observe.inc("attempts");

    // Business logic here...
    const user = await authenticateUser(credentials);

    // Add more observability data
    observe.set("userId", user.id);
    observe.push("events", { type: "auth.success", userId: user.id });
    observe.set("endTime", Date.now());
  },
  { initial: { requestId: "req-123" } },
);
```

## API Reference

### `observe.set(key, value)`

Sets a key-value pair in the current context data.

```typescript
observe.set("operation", "user.login");
observe.set("metadata", { source: "api", version: "v1" });
observe.set("startTime", Date.now());
```

### `observe.get(key)`

Gets a value from the current context data.

```typescript
const operation = observe.get("operation");
const startTime = observe.get("startTime") as number;
```

### `observe.push(arrayName, value)`

Pushes a value to an array in the context data. Creates the array if it doesn't exist.

```typescript
observe.push("events", { type: "database.query", table: "users" });
observe.push("errors", new Error("Connection failed"));
observe.push("metrics", { name: "response_time", value: 150 });
```

### `observe.inc(key, amount?)`

Increments a numeric counter. Initializes to the increment amount if the key doesn't exist.

```typescript
observe.inc("attempts"); // Increment by 1
observe.inc("retries", 3); // Increment by 3
observe.inc("bytes_sent", 1024); // Track cumulative values
```

### `observe.has(key)`

Checks if a key exists in the current context data.

```typescript
if (observe.has("userId")) {
  // User is authenticated
}

if (!observe.has("startTime")) {
  observe.set("startTime", Date.now());
}
```

### `observe.delete(key)`

Removes a key from the current context data.

```typescript
observe.delete("temporaryData");
const wasDeleted = observe.delete("cache"); // returns boolean
```

### `observe.all()`

Gets all context data as a readonly object.

```typescript
const allData = observe.all();
console.log(allData.operation, allData.events);
```

## Usage Patterns

### Request Tracking

```typescript
await context.scope(
  async () => {
    observe.set("operation", "api.processPayment");
    observe.set("requestId", req.headers["x-request-id"]);
    observe.set("userId", req.user?.id);
    observe.set("startTime", Date.now());

    try {
      observe.push("events", { type: "payment.start" });
      const result = await processPayment(req.body);

      observe.push("events", { type: "payment.success", amount: result.amount });
      observe.set("status", "success");

      return result;
    } catch (error) {
      observe.push("events", { type: "payment.error", error: error.message });
      observe.set("status", "error");
      throw error;
    } finally {
      observe.set("endTime", Date.now());
      observe.set("duration", observe.get("endTime") - observe.get("startTime"));
    }
  },
  { initial: {} },
);
```

### Performance Monitoring

```typescript
await context.scope(
  async () => {
    observe.set("operation", "database.bulkInsert");
    observe.set("batchSize", records.length);

    for (const record of records) {
      try {
        await insertRecord(record);
        observe.inc("successCount");
      } catch (error) {
        observe.inc("errorCount");
        observe.push("errors", { recordId: record.id, error: error.message });
      }
    }

    const successRate = observe.get("successCount") / records.length;
    observe.set("successRate", successRate);
  },
  { initial: { successCount: 0, errorCount: 0, errors: [] } },
);
```

### Distributed Tracing

```typescript
await context.scope(
  async () => {
    observe.set("traceId", generateTraceId());
    observe.set("operation", "order.process");
    observe.push("spans", { name: "order.validate", start: Date.now() });

    await validateOrder(order);
    observe.push("spans", { name: "order.validate", end: Date.now() });

    observe.push("spans", { name: "inventory.reserve", start: Date.now() });
    await reserveInventory(order.items);
    observe.push("spans", { name: "inventory.reserve", end: Date.now() });

    observe.push("spans", { name: "payment.charge", start: Date.now() });
    await chargePayment(order.payment);
    observe.push("spans", { name: "payment.charge", end: Date.now() });
  },
  { initial: { spans: [] } },
);
```

## Integration with Context

Observe works directly with any context created by `@phyxiusjs/context`:

```typescript
// Typed contexts work perfectly
interface RequestContext {
  requestId: string;
  operation?: string;
  events?: Array<{ type: string; timestamp: number }>;
  metrics?: Record<string, number>;
}

await context.scope<RequestContext>(
  async () => {
    // Type-safe context access
    const ctx = context.get<RequestContext>();
    console.log(ctx.data.requestId); // string

    // observe namespace still works
    observe.set("operation", "user.profile.update");
    observe.push("events", { type: "profile.start", timestamp: Date.now() });
  },
  { initial: { requestId: "req-456" } },
);
```

## Context Inheritance

Observe respects context inheritance - child contexts inherit and can modify parent observability data:

```typescript
await context.scope(
  async () => {
    observe.set("service", "user-api");
    observe.push("trace", { span: "root", operation: "getUser" });

    await context.scope(async () => {
      // Child can see and modify parent data
      observe.push("trace", { span: "child", operation: "validateToken" });
      observe.inc("validations");

      console.log(observe.get("service")); // "user-api"
    });

    // Parent sees child modifications
    const trace = observe.get("trace") as Array<{ span: string; operation: string }>;
    console.log(trace.length); // 2 spans
  },
  { initial: {} },
);
```

## Error Handling

All observe functions throw an error if no active context is available:

```typescript
// This will throw "No active context available"
observe.set("key", "value");

// Always use within a context scope
await context.scope(async () => {
  observe.set("key", "value"); // Works fine
});
```

## Why Observe?

Observe is designed to be a **utility namespace** - it provides convenient methods for common observability patterns without being opinionated about how you structure your data. It's perfect for:

- **Adding observability** to existing applications without refactoring
- **Incremental adoption** - start simple, add more sophisticated patterns later
- **Auto-completion** - IDE support for discovering available operations
- **Consistency** - standard way to add observability data across teams

## License

MIT © [Rodrigo Sasaki](https://github.com/rodrigopsasaki)

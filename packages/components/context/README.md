# @phyxiusjs/context

> Pure AsyncLocalStorage primitive for typed thread-local data

Context is a minimal, zero-dependency primitive that provides thread-local storage with full TypeScript support. It has zero knowledge of domain concerns like correlation IDs, timestamps, or observability - it simply manages typed data that flows through async operations automatically.

## Installation

```bash
npm install @phyxiusjs/context
```

## Features

- **Pure Primitive**: Zero domain knowledge, just AsyncLocalStorage mechanics
- **Full TypeScript Support**: Generic typing for compile-time safety
- **Inheritance**: Child contexts can inherit and override parent data
- **Isolation**: Concurrent contexts are completely isolated
- **Zero Dependencies**: Minimal footprint, works everywhere
- **Martin Odersky Approved**: Support for complex, nested type hierarchies

## Quick Start

### Basic Usage

```typescript
import { context } from "@phyxiusjs/context";

// Simple untyped context
await context.scope(
  async () => {
    const ctx = context.get();
    console.log(ctx.data); // Record<string, unknown>
  },
  { initial: { service: "api", version: "1.0" } },
);
```

### Typed Context

```typescript
interface UserSession {
  userId: string;
  permissions: string[];
  preferences: {
    theme: "light" | "dark";
    notifications: boolean;
  };
}

await context.scope<UserSession>(
  async () => {
    const ctx = context.get<UserSession>();

    // Full type safety!
    console.log(ctx.data.userId); // string
    console.log(ctx.data.permissions); // string[]
    console.log(ctx.data.preferences.theme); // "light" | "dark"
  },
  {
    initial: {
      userId: "user123",
      permissions: ["read", "write"],
      preferences: {
        theme: "dark",
        notifications: true,
      },
    },
  },
);
```

## API Reference

### `context.scope<T>(callback, options?)`

Creates a new context scope and executes a callback within it.

**Parameters:**

- `callback: () => Promise<any> | any` - Function to execute within the context
- `options?: ContextScopeOptions<T>` - Configuration options

**Options:**

- `initial?: T` - Initial data for the context
- `inherit?: boolean` - Whether to inherit from parent context (default: `true`)

**Returns:** The result of the callback function

### `context.get<T>()`

Gets the current active context, throwing if none exists.

**Returns:** `PhyxiusContext<T>` - The current context
**Throws:** Error if no active context is available

### `context.current<T>()`

Gets the current active context or undefined if none exists.

**Returns:** `PhyxiusContext<T> | undefined` - The current context or undefined

## Examples

### Inheritance

```typescript
interface AppContext {
  service: string;
  version: string;
  requestId?: string;
}

// Parent context
await context.scope<AppContext>(
  async () => {
    // Child context inherits and extends
    await context.scope<AppContext>(
      async () => {
        const ctx = context.get<AppContext>();
        console.log(ctx.data);
        // { service: "api", version: "1.0", requestId: "req-123" }
      },
      {
        initial: { requestId: "req-123" },
      },
    );
  },
  {
    initial: { service: "api", version: "1.0" },
  },
);
```

### No Inheritance

```typescript
await context.scope(
  async () => {
    await context.scope(
      async () => {
        const ctx = context.get();
        console.log(ctx.data); // { child: "data" }
      },
      {
        initial: { child: "data" },
        inherit: false,
      },
    );
  },
  {
    initial: { parent: "data" },
  },
);
```

### Complex Types

```typescript
interface DatabaseContext {
  connection: {
    host: string;
    port: number;
    credentials: {
      username: string;
      encrypted: boolean;
    };
  };
  transaction?: {
    id: string;
    isolation: "read-committed" | "serializable";
  };
}

await context.scope<DatabaseContext>(
  async () => {
    const ctx = context.get<DatabaseContext>();

    // All typed and safe
    const host = ctx.data.connection.host; // string
    const isolation = ctx.data.transaction?.isolation; // "read-committed" | "serializable" | undefined
    const encrypted = ctx.data.connection.credentials.encrypted; // boolean
  },
  {
    initial: {
      connection: {
        host: "localhost",
        port: 5432,
        credentials: {
          username: "app",
          encrypted: true,
        },
      },
    },
  },
);
```

### Concurrent Isolation

```typescript
interface WorkerContext {
  workerId: string;
  task: string;
}

// These run concurrently but are completely isolated
const results = await Promise.all([
  context.scope<WorkerContext>(
    async () => {
      const ctx = context.get<WorkerContext>();
      return ctx.data.workerId; // "worker-A"
    },
    { initial: { workerId: "worker-A", task: "process" } },
  ),

  context.scope<WorkerContext>(
    async () => {
      const ctx = context.get<WorkerContext>();
      return ctx.data.workerId; // "worker-B"
    },
    { initial: { workerId: "worker-B", task: "process" } },
  ),
]);
```

## Why Context?

Context is designed to be a **pure primitive** - it has no opinions about what you store or how you use it. This makes it perfect for:

- **Building other primitives** that need thread-local storage
- **Framework integration** without vendor lock-in
- **Library development** where you need context but don't want to impose structure
- **Type-safe applications** that need compile-time guarantees

### Not Just for Phyxius

While Context is part of the Phyxius ecosystem, it's designed to work standalone. You can use it in any Node.js application that needs thread-local storage with TypeScript support.

## Integration with Other Libraries

Context works great as a foundation for other libraries:

```typescript
// Observability library can layer on top
export function observe<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return context.scope(async () => {
    const ctx = context.get();
    // Add observability data to existing context
    ctx.data.observing = name;
    ctx.data.startTime = Date.now();

    const result = await fn();

    ctx.data.duration = Date.now() - ctx.data.startTime;
    // Export observability data

    return result;
  });
}

// Correlation library can layer on top
export function withCorrelation<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return context.scope(async () => {
    const ctx = context.get();
    ctx.data.correlationId = id;
    return fn();
  });
}
```

## License

MIT © [Rodrigo Sasaki](https://github.com/rodrigopsasaki)

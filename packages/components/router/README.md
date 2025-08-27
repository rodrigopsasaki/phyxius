# @phyxiusjs/router

A progressive, type-safe HTTP router for the Phyxius ecosystem with automatic route specificity ordering and comprehensive middleware support.

## Features

- **Three-tier API design** - Choose your abstraction level: contract-first, builder pattern, or direct control
- **Automatic route specificity** - No more route order bugs like Express - routes are automatically sorted by specificity
- **Type-safe contracts** - Full TypeScript inference from request to response
- **Middleware composition** - Proper async middleware with error handling
- **Adapter pattern** - Integrate with ts-rest, OpenAPI, or any contract system without lock-in
- **Phyxius integration** - Uses Result types and Handler patterns consistently

## Installation

```bash
pnpm add @phyxiusjs/router
```

## Quick Start

### Level 1: Contract-First API (Highest Level)

Define your API as a contract with full type safety:

```typescript
import { defineContract, createHandler, implementContract } from "@phyxiusjs/router";
import { ok } from "@phyxiusjs/fp";

// Define your contract
const apiContract = defineContract({
  getUser: {
    method: "GET" as const,
    path: "/users/:id",
    handler: createHandler("getUser", async (req) =>
      ok({
        status: 200,
        body: { id: req.params.id, name: "John" },
      }),
    ),
  },
  createUser: {
    method: "POST" as const,
    path: "/users",
    handler: createHandler("createUser", async (req) =>
      ok({
        status: 201,
        body: { id: "123", ...req.body },
      }),
    ),
  },
});

// Create the router
const router = createContractRouter(apiContract);

// Match routes
const match = router.match("GET", "/users/123");
if (match) {
  const result = await match.route.handler.handle(request);
  // result is fully typed!
}
```

### Level 2: Route Builder API (Express-like)

Build routes with a familiar Express-like API:

```typescript
import { route, createHandler } from "@phyxiusjs/router";
import { ok } from "@phyxiusjs/fp";

const authMiddleware = async (context, next) => {
  if (!context.request.headers.get("Authorization")) {
    context.response = { status: 401, body: "Unauthorized" };
    return;
  }
  await next();
};

const getUserRoute = route()
  .get("/users/:id")
  .use(authMiddleware)
  .handle(
    createHandler("getUser", async (req) =>
      ok({
        status: 200,
        body: { id: req.params.id },
      }),
    ),
  );
```

### Level 3: Direct Router API (Full Control)

Use the router directly for maximum control:

```typescript
import { Router, createHandler } from "@phyxiusjs/router";
import { ok } from "@phyxiusjs/fp";

const router = new Router();

const handler = createHandler("getUser", async (req) =>
  ok({
    status: 200,
    body: { id: req.params.id },
  }),
);

// Add route with optional middleware
router.addRoute("GET", "/users/:id", handler, [authMiddleware]);

// Match incoming requests
const match = router.match("GET", "/users/123");
if (match) {
  const result = await match.route.handler.handle({
    method: "GET",
    path: "/users/123",
    params: match.params,
    query: new URLSearchParams(),
    headers: new Headers(),
    body: undefined,
  });
}
```

## Route Specificity

Routes are automatically ordered by specificity, solving the common Express pitfall:

```typescript
router.addRoute("GET", "/users/:id", specificHandler);
router.addRoute("GET", "/users/profile", profileHandler);
router.addRoute("GET", "/users/*path", wildcardHandler);

// /users/profile will ALWAYS match profileHandler, regardless of order!
// Specificity: static > parameter > wildcard
```

## Middleware

Middleware follows the standard pattern with proper async support:

```typescript
const loggingMiddleware = async (context, next) => {
  console.log(`${context.request.method} ${context.request.path}`);
  const start = Date.now();

  await next(); // Call next middleware/handler

  const duration = Date.now() - start;
  console.log(`Completed in ${duration}ms`);
};

const corsMiddleware = (context, next) => {
  context.response.headers = new Headers({
    "Access-Control-Allow-Origin": "*",
  });
  return next();
};

// Use in route builder
route().get("/api/*path").use(loggingMiddleware).use(corsMiddleware).handle(handler);
```

## Adapters

Integrate with external contract libraries without creating dependencies:

### ts-rest Adapter

```typescript
import { tsRestAdapter, adaptContract } from "@phyxiusjs/router";

const tsRestContract = {
  getUser: {
    method: "GET",
    path: "/users/:id",
    summary: "Get user by ID",
  },
  createUser: {
    method: "POST",
    path: "/users",
    summary: "Create new user",
  },
};

// Convert to Phyxius router
const handlers = {
  get_users_id_0: getUserHandler,
  post_users_1: createUserHandler,
};

const router = adaptContract(tsRestAdapter, tsRestContract, handlers);
```

### OpenAPI Adapter

```typescript
import { openApiAdapter, adaptContract } from "@phyxiusjs/router";

const openApiSpec = {
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        summary: "Get user by ID",
      },
    },
  },
};

const router = adaptContract(openApiAdapter, openApiSpec, handlers);
```

### Custom Adapters

Create adapters for any contract format:

```typescript
import { createAdapter } from "@phyxiusjs/router";

const customAdapter = createAdapter({
  extractRoutes(contract) {
    // Extract routes from your contract format
    return contract.routes;
  },

  createContractRoute(route) {
    // Convert to Phyxius route
    return {
      method: route.method.toUpperCase(),
      path: route.path,
      handler: createPlaceholderHandler(),
    };
  },

  createExternalRoute(contractRoute) {
    // Convert back to external format
    return {
      method: contractRoute.method.toLowerCase(),
      path: contractRoute.path,
    };
  },
});
```

## Error Handling

All handlers return `Result<T, E>` types for explicit error handling:

```typescript
import { createHandler } from "@phyxiusjs/router";
import { ok, err } from "@phyxiusjs/fp";

const handler = createHandler("getUser", async (req) => {
  const user = await findUser(req.params.id);

  if (!user) {
    return err(new Error("User not found"));
  }

  return ok({
    status: 200,
    body: user,
  });
});

// Handle the result
const result = await handler.handle(request);
if (result._tag === "Ok") {
  // Success case
  console.log(result.value.body);
} else {
  // Error case
  console.error(result.error.message);
}
```

## Route Patterns

The router supports various route patterns:

```typescript
// Static routes
"/users";
"/api/v1/health";

// Parameter routes
"/users/:id";
"/posts/:postId/comments/:commentId";

// Wildcard routes (catch-all)
"/assets/*filepath";
"/api/*path";

// Special characters are properly escaped
"/api/v1.0/users+friends";
```

## Integration with Phyxius Ecosystem

The router integrates seamlessly with other Phyxius primitives:

```typescript
import { createHandler } from "@phyxiusjs/router";
import { Clock } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";

const handler = createHandler(
  "timedHandler",
  async (req) => {
    // Use Clock for timing
    const clock = new Clock();
    const start = clock.now();

    // Use Journal for logging
    const journal = new Journal();
    journal.info("Processing request", { path: req.path });

    const result = await processRequest(req);

    const duration = clock.now() - start;
    journal.info("Request completed", { duration });

    return ok({ status: 200, body: result });
  },
  {
    // Handler configuration
    timeout: 5000,
    circuitBreaker: {
      threshold: 5,
      timeout: 60000,
      resetTimeout: 30000,
    },
  },
);
```

## API Reference

### Types

```typescript
interface RouteRequest<TBody = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: RouteParams;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly body: TBody;
}

interface RouteResponse<TBody = unknown> {
  readonly status: number;
  readonly headers?: Headers;
  readonly body?: TBody;
}

interface RouteHandler<TReq = unknown, TRes = unknown> {
  readonly name: string;
  handle(request: RouteRequest<TReq>): Promise<Result<RouteResponse<TRes>, Error>>;
  readonly config?: {
    timeout?: number;
    circuitBreaker?: {
      threshold: number;
      timeout: number;
      resetTimeout: number;
    };
  };
}
```

### Router Methods

```typescript
class Router {
  addRoute<TReq, TRes>(
    method: HttpMethod,
    path: string,
    handler: RouteHandler<TReq, TRes>,
    middleware?: Middleware<TReq, TRes>[],
  ): Result<void, RouterError>;

  match(method: HttpMethod, path: string): RouteMatch | null;

  getAllowedMethods(path: string): HttpMethod[];

  getRoutes(): readonly Route[];
}
```

## Testing

The router is extensively tested with 85+ test cases covering:

- Route matching and specificity
- Parameter extraction
- Wildcard matching
- Middleware execution order
- Error handling
- Contract type safety
- Adapter conversions
- Edge cases

Run tests with:

```bash
pnpm test
```

## License

MIT

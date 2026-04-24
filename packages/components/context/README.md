# Context

Typed scoped data that flows through async operations without being threaded through every function call.

---

## What this really is

A thin typed facade over Node's `AsyncLocalStorage`. Three methods — `current`, `get`, `scope` — and a `PhyxiusContext<T>` shape for the stored data. Zero domain knowledge: no correlation IDs, no timestamps, no observability fields. The primitive just carries a typed object through async boundaries.

If you've manually threaded `requestId` through twelve function signatures to get it to a log line at the bottom of a call stack, this is what kills that. The `requestId` lives in the current scope; any code running under that scope can read it.

---

## Examples

### Example 1 — Request-scoped trace ID

```ts
import { context } from "@phyxiusjs/context";

interface RequestCtx {
  requestId: string;
  userId: string;
}

async function handleRequest(req, res) {
  await context.scope<RequestCtx>(
    async () => {
      // Anywhere inside, including deeply nested async code:
      await processPayment();
    },
    { initial: { requestId: req.headers["x-request-id"], userId: req.user.id } },
  );
}

async function processPayment() {
  const ctx = context.get<RequestCtx>();
  logger.info({ requestId: ctx.data.requestId }, "charging card");
  // no need to pass requestId in as an argument — it's in scope
}
```

### Example 2 — Concurrent scopes are isolated

```ts
// Each scope has its own store, even when they run concurrently.
const results = await Promise.all([
  context.scope(async () => context.get().data.worker, {
    initial: { worker: "A" },
  }),
  context.scope(async () => context.get().data.worker, {
    initial: { worker: "B" },
  }),
]);
// ["A", "B"] — no cross-contamination
```

### Example 3 — Inheritance for nested operations

```ts
// Parent sets trace context. Nested scope automatically sees it.
await context.scope(
  async () => {
    await context.scope(
      async () => {
        const ctx = context.get();
        console.log(ctx.data);
        // { service: "api", version: "1.0", op: "fetch-user" }
      },
      { initial: { op: "fetch-user" } },
    );
  },
  { initial: { service: "api", version: "1.0" } },
);
```

---

## Inheritance is shallow — and that's the mechanism

When `inherit: true` (the default), the child's `data` is a **shallow copy** of the parent's. Top-level keys are independent; nested references are shared. A child scope pushing to an inherited array mutates the parent's array too.

This is intentional. It's the mechanism that makes `@phyxiusjs/observe` compose across nested scopes into a single accumulated picture:

```ts
await context.scope(
  async () => {
    // The outer handler's scope
    fields.trace.push({ span: "root", op: "login" });

    await context.scope(async () => {
      // A nested operation
      fields.trace.push({ span: "child", op: "validate" });
    });

    // Parent sees both entries — exactly what "one event per unit of work"
    // needs. The root scope collects the complete story at the end.
    console.log(fields.trace.get()); // [root, child]
  },
  { initial: { trace: [] } },
);
```

If you want scope isolation instead of accumulation, pass `inherit: false`:

```ts
await context.scope(cb, { initial: {...}, inherit: false });
```

That gives the child its own `data` object with no parent visibility. Useful for true sub-computations that shouldn't affect the outer trace.

Deep cloning on inherit isn't the default because it's expensive and breaks reference equality for Maps, class instances, and — crucially — the accumulation pattern that makes `observe` useful in the first place.

---

## API

```ts
const context = {
  /** Current context, or `undefined` if no scope is active. */
  current<T>(): PhyxiusContext<T> | undefined;

  /** Current context; throws if no scope is active. */
  get<T>(): PhyxiusContext<T>;

  /** Run a callback inside a new scope. Returns the callback's result. */
  scope<T, R>(
    callback: () => R | Promise<R>,
    options?: ContextScopeOptions<T>,
  ): Promise<R>;
};

interface ContextScopeOptions<T> {
  initial?: T;       // seed data for the new scope
  inherit?: boolean; // default true — shallow-inherit from parent
}

interface PhyxiusContext<T> {
  readonly data: T;  // readonly at reassignment; mutation is allowed
}
```

`readonly data` prevents reassigning the whole object (`ctx.data = ...` is an error), but individual fields are mutable. That's intentional — `@phyxiusjs/observe` and other layered primitives mutate `ctx.data` in place to accumulate state during a scope.

---

## What Context does NOT do

- **No observability data on its own.** It doesn't store trace IDs, timestamps, or durations. Layer that via `@phyxiusjs/observe`.
- **No automatic journaling.** Scope enter/exit happens too frequently to emit events — the observability contract operates at the Handler/Process layer, not here.
- **No cross-process propagation.** AsyncLocalStorage is per-process. Cross-service trace propagation needs a transport adapter (e.g. an HTTP middleware that extracts `traceparent` and re-enters a scope).
- **No domain opinions.** The package is zero-dep and knows nothing beyond `AsyncLocalStorage`.

---

## Package sharing across versions

If two copies of `@phyxiusjs/context` end up in the same Node process (e.g., version mismatch in `node_modules`), they share a single `AsyncLocalStorage` instance via `Symbol.for("phyxius.context.runtime")`. Without this, context would silently fail to flow across the boundary between the two copies. You don't need to think about it — it just works — but the mechanism is there.

---

## Installation

```bash
npm install @phyxiusjs/context
```

---

## What you get

- **Data that flows through async without being threaded.** The canonical use case of AsyncLocalStorage, with a typed interface.
- **Concurrent isolation.** Two scopes running at the same time don't see each other.
- **Optional inheritance.** Nested scopes read parent data; default shallow copy keeps the common case fast.
- **Zero dependencies.** Just `node:async_hooks` and ~80 lines of code.

Context is the smallest primitive in Phyxius. Everything above it — observe, handle, anything a re-imagined Handler wires up — composes on this foundation.

# Effect

Async that can't leak. Resources that clean up. Concurrency you can reason about.

Every production outage you've debugged starts the same way: resources leak, operations hang, promises never resolve, timeouts don't work, cleanup never happens.

Effect fixes this. Structured concurrency, automatic cleanup, explicit errors.

Two implementations, one interface:

- System effects for production use, with real async operations and resource management.
- Controlled effects for tests, with deterministic timing and observable execution.

---

## Why promises are broken

### Resource leaks and incomplete cleanup

```js
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
      .then(response => response.text())
      .then(text => {
        clearTimeout(timeout); // Did this run?
        resolve(text);
      })
      .catch(error => {
        clearTimeout(timeout); // What about this?
        reject(error);
      });
  });
}
```

### Uncontrolled race conditions

```js
// Concurrent operations with no cleanup guarantee
Promise.race([
  fetchWithTimeout("https://api1.com"),
  fetchWithTimeout("https://api2.com"),
  fetchWithTimeout("https://api3.com"),
]);
// Two of these will "lose" the race. Did they clean up? Are they still running?
```

Promises are fire-and-forget missiles. Once launched, you can't reliably cancel them, manage their resources, or prevent them from doing work after you've moved on.

---

## The Problem

Async operations in most languages are fundamentally unsafe. They can leak resources, hang forever, continue running after cancellation, and provide no structured way to manage cleanup.

```ts
// No way to know what's still running
const operations = [doAsyncWork(), doMoreAsyncWork(), doEvenMoreAsyncWork()];

// If one fails, what happens to the others?
try {
  await Promise.all(operations);
} catch (error) {
  // Are the other operations still running?
  // How do we clean up their resources?
  // This is a memory leak waiting to happen.
}
```

---

## Effect helps you with this

### Example 1 — Automatic resource cleanup

```ts
import { acquireUseRelease, effect } from "@phyxiusjs/effect";
import { createSystemClock } from "@phyxiusjs/clock";

const clock = createSystemClock();

const withDatabase = acquireUseRelease(
  // Acquire: Create the resource
  effect(async () => {
    const conn = new DatabaseConnection();
    await conn.connect();
    return { _tag: "Ok", value: conn };
  }),

  // Use: Do work with the resource
  (conn) =>
    effect(async () => {
      const users = await conn.query("SELECT * FROM users");
      return { _tag: "Ok", value: users };
    }),

  // Release: Clean up (guaranteed to run)
  (conn, cause) =>
    effect(async () => {
      await conn.close();
      console.log(`Connection closed due to: ${cause}`);
      return { _tag: "Ok", value: undefined };
    }),
);

// Cleanup happens automatically, even on failure or interruption
const result = await withDatabase.unsafeRunPromise({ clock });
```

### Example 2 — Race with automatic cleanup of losers

```ts
import { race, effect, sleep } from "@phyxiusjs/effect";

const fastAPI = effect(async () => {
  const response = await fetch("https://fast-api.com");
  return { _tag: "Ok", value: await response.json() };
});

const slowAPI = effect(async () => {
  const response = await fetch("https://slow-api.com");
  return { _tag: "Ok", value: await response.json() };
});

// Race with automatic cleanup of losers
const winner = await race([
  fastAPI,
  slowAPI,
  sleep(5000), // Timeout after 5 seconds
]).unsafeRunPromise({ clock });

// All losing effects are interrupted and cleaned up
```

### Example 3 — Interruptible operations with graceful shutdown

```ts
const longRunning = effect(async (env) => {
  for (let i = 0; i < 1000; i++) {
    // Check for cancellation on each iteration
    if (env.cancel.isCanceled()) {
      console.log(`Stopped at step ${i}`);
      return { _tag: "Err", error: "Cancelled" };
    }

    // Simulate work
    await sleep(100).unsafeRunPromise({ clock });
    console.log(`Step ${i}`);
  }

  return { _tag: "Ok", value: "Completed all steps" };
});

// Fork the effect (run in background)
const fiberResult = await longRunning.fork().unsafeRunPromise({ clock });
const fiber = fiberResult.value;

// Wait a bit, then interrupt
await sleep(500).unsafeRunPromise({ clock });
await fiber.interrupt().unsafeRunPromise({ clock });

console.log("Operation was interrupted gracefully");
```

### Example 4 — Retry with exponential backoff

```ts
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
```

---

## Effect does NOT help you with this

### Example 1 — UI event handling

```ts
// Not Effect's job - use framework primitives:
button.addEventListener("click", handleClick);
```

### Example 2 — Simple synchronous computations

```ts
// Not Effect's job - use regular functions:
function add(a: number, b: number): number {
  return a + b;
}
```

### Example 3 — Long-term persistence

```ts
// Not Effect's job - use databases/file systems:
await database.save(userData);
```

---

## Why not just use async/await?

Traditional async/await gives you sequential execution but no resource safety:

- **No cancellation**: Once started, promises run to completion.
- **No cleanup guarantees**: Resources can leak if operations are abandoned.
- **No structured concurrency**: Concurrent operations have no parent-child relationship.
- **Exception-based errors**: Failures can bypass cleanup code.

Effects use structured concurrency where child operations are always cleaned up when parents complete, fail, or are cancelled.

---

## What this is not

Effect is not a Promise replacement, not a web framework, not a database client. It does not replace fetch, axios, or specific async libraries.

Effect is focused on structured concurrency and resource management. It provides the foundation for building reliable async systems that other libraries can integrate with.

If you want HTTP clients, use libraries built on Effect. If you want UI reactivity, use framework adapters. If you want your async operations to be cancellable and resource-safe, use Effect.

---

## Installation

```bash
npm install @phyxiusjs/effect @phyxiusjs/clock
```

---

## What you get

- Async that can't leak: structured concurrency guarantees cleanup of all child operations.
- Resources that clean up: RAII pattern ensures release functions always run.
- Concurrency you can reason about: explicit cancellation, timeouts, and error handling.

Effect does not fix async. It gives you structured concurrency and resource management to make async operations safe and predictable. Everything else builds on that foundation.

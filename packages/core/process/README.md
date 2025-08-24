# Process

Units that restart on failure. Systems that heal themselves. Concurrency without chaos.

Every system failure you've debugged starts with the same pattern: one component fails, takes down its neighbor, which takes down its neighbor, until the whole system is dead. Cascading failures, resource leaks, deadlocks, race conditions.

Process fixes this. Isolated units, supervised execution, let it crash and restart.

Two implementations, one interface:

- In-memory processes for single-node actor systems with message passing.
- Distributed processes for multi-node systems with location transparency.

---

## Why shared state is broken

### Cascading failures and resource leaks

```js
// This is broken. One failure kills everything.
class UserService {
  private connections = new Map();
  private cache = new Map();

  async handleRequest(req: Request) {
    // If this throws, the whole service dies
    const user = await this.database.getUser(req.userId);

    // Shared state, race conditions waiting to happen
    this.cache.set(req.userId, user);

    // If this fails, the connection leaks
    const connection = await this.createConnection(user);
    this.connections.set(req.userId, connection);

    return user;
  }
}

// One bad request can kill the entire service
const service = new UserService();
```

### Race conditions in concurrent access

```js
// Multiple threads/promises accessing shared state
class Counter {
  private value = 0;

  async increment() {
    const current = this.value; // Race condition here
    await someAsyncWork();
    this.value = current + 1; // Lost updates
  }
}

// Two concurrent increments might only increase counter by 1
counter.increment();
counter.increment();
```

Object-oriented programming gives you shared mutable state, which gives you race conditions, which give you bugs that only happen in production under load.

---

## The Problem

Traditional concurrency models share state between threads or async operations, leading to race conditions, deadlocks, and system-wide failures when one component crashes.

```ts
// No isolation - everything shares the same fate
class OrderSystem {
  private orders = new Map();
  private payments = new Map();
  private inventory = new Map();

  async processOrder(order: Order) {
    // Any failure here brings down the entire system
    await this.validateInventory(order);
    await this.processPayment(order);
    await this.updateInventory(order);
    await this.sendConfirmation(order);

    // If sendConfirmation fails, what happens to inventory?
    // What about the payment? No way to roll back cleanly.
  }
}
```

---

## Process helps you with this

### Example 1 — Isolated state with message passing

```ts
import { createRootSupervisor } from "@phyxiusjs/process";
import { createSystemClock } from "@phyxiusjs/clock";

const clock = createSystemClock();
const supervisor = createRootSupervisor({ clock });

// Counter process with isolated state
const counter = supervisor.spawn(
  {
    name: "counter",
    init: () => ({ count: 0 }),
    handle: (state, message) => {
      switch (message.type) {
        case "increment":
          return { count: state.count + 1 };
        case "get":
          message.reply(state.count);
          return state;
        default:
          return state;
      }
    },
  },
  {},
);

// Send messages - never blocks, never races
counter.send({ type: "increment" });
counter.send({ type: "increment" });

const count = await counter.ask((reply) => ({ type: "get", reply }));
console.log(count); // Always 2, never race condition
```

### Example 2 — Crash and restart with clean state

```ts
const flakyWorker = supervisor.spawn(
  {
    name: "flaky-worker",
    init: () => ({ processed: 0 }),
    handle: (state, message) => {
      if (message.type === "work") {
        // Randomly crash 10% of the time
        if (Math.random() < 0.1) {
          throw new Error("Random failure!");
        }

        console.log(`Processed item ${state.processed + 1}`);
        return { processed: state.processed + 1 };
      }
      return state;
    },
  },
  {},
);

// Send work - even if it crashes, it restarts with fresh state
for (let i = 0; i < 100; i++) {
  flakyWorker.send({ type: "work", item: i });
}
```

### Example 3 — Request-reply with timeouts

```ts
const database = supervisor.spawn(
  {
    name: "database",
    init: () => ({
      users: new Map([
        ["alice", { name: "Alice", email: "alice@example.com" }],
        ["bob", { name: "Bob", email: "bob@example.com" }],
      ]),
    }),
    handle: (state, message) => {
      switch (message.type) {
        case "get-user":
          const user = state.users.get(message.userId);
          message.reply(user || null);
          return state;
        case "create-user":
          state.users.set(message.user.id, message.user);
          message.reply({ success: true });
          return state;
        default:
          return state;
      }
    },
  },
  {},
);

// Request with automatic timeout
try {
  const user = await database.ask(
    (reply) => ({ type: "get-user", userId: "alice", reply }),
    1000, // Timeout after 1 second
  );
  console.log("Found user:", user);
} catch (error) {
  console.log("Request timed out or failed");
}
```

### Example 4 — Hierarchical supervision

```ts
const taskManager = supervisor.spawn(
  {
    name: "task-manager",
    init: () => ({ workers: new Map(), nextId: 0 }),
    handle: (state, message, tools) => {
      switch (message.type) {
        case "spawn-worker":
          const workerId = state.nextId++;

          // Spawn child worker process
          const worker = tools.spawn(
            {
              name: `worker-${workerId}`,
              init: () => ({ tasksCompleted: 0 }),
              handle: (workerState, workerMessage) => {
                if (workerMessage.type === "task") {
                  console.log(`Worker ${workerId} processing task`);
                  return { tasksCompleted: workerState.tasksCompleted + 1 };
                }
                return workerState;
              },
            },
            {},
          );

          state.workers.set(workerId, worker);
          message.reply(workerId);
          return { ...state, nextId: workerId + 1 };

        case "distribute-task":
          // Send task to all workers
          for (const worker of state.workers.values()) {
            worker.send({ type: "task", data: message.data });
          }
          return state;

        default:
          return state;
      }
    },
  },
  {},
);

// Create worker pool dynamically
await taskManager.ask((reply) => ({ type: "spawn-worker", reply }));
await taskManager.ask((reply) => ({ type: "spawn-worker", reply }));
await taskManager.ask((reply) => ({ type: "spawn-worker", reply }));

// Distribute work across pool
taskManager.send({ type: "distribute-task", data: "some work" });
```

---

## Process does NOT help you with this

### Example 1 — CPU-intensive computations

```ts
// Not Process's job - use worker threads:
const { Worker } = require("worker_threads");
const worker = new Worker("./cpu-intensive-task.js");
```

### Example 2 — Database transactions

```ts
// Not Process's job - use database transactions:
await db.transaction(async (trx) => {
  await trx("orders").insert(order);
  await trx("inventory").decrement("count", order.quantity);
});
```

### Example 3 — UI event handling

```ts
// Not Process's job - use framework primitives:
button.addEventListener("click", handleClick);
```

---

## Why not just use classes and async/await?

Traditional object-oriented concurrent programming has fundamental problems:

- **Shared state**: Multiple operations can modify the same data simultaneously.
- **Race conditions**: The order of operations becomes unpredictable under load.
- **Cascading failures**: One component's failure brings down the entire system.
- **Resource leaks**: Failed operations can leave resources in inconsistent states.

Processes use isolated state and message passing to eliminate these problems entirely.

---

## What this is not

Process is not a web framework, not a database, not a thread pool. It does not replace Express, Fastify, or HTTP servers. It does not handle network protocols or persistence.

Process is focused on safe concurrent programming with isolated state and supervision. It provides the actor model for building resilient systems that other libraries can integrate with.

If you want HTTP APIs, use a web framework built on Process. If you want database access, use libraries that work with Process. If you want concurrency without chaos, use Process.

---

## Installation

```bash
npm install @phyxiusjs/process @phyxiusjs/clock
```

---

## What you get

- Units that restart on failure: isolated processes with automatic recovery.
- Systems that heal themselves: supervision strategies control restart behavior.
- Concurrency without chaos: message passing eliminates race conditions and shared state bugs.

Process does not fix concurrency. It gives you the actor model and supervision trees to make concurrent systems safe and resilient. Everything else builds on that foundation.

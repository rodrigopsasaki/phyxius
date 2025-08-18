# Process

**Units that restart on failure. Systems that heal themselves. Concurrency without chaos.**

Every system failure you've debugged starts with the same pattern: one component fails, takes down its neighbor, which takes down its neighbor, until the whole system is dead. Cascading failures, resource leaks, deadlocks, race conditions.

Process fixes this. Isolated units, supervised execution, let it crash and restart.

## The Problem

```typescript
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

Object-oriented programming gives you shared mutable state, which gives you race conditions, which give you bugs that only happen in production under load.

## The Solution

```typescript
import { createRootSupervisor } from "@phyxius/process";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();
const supervisor = createRootSupervisor({ clock });

// Isolated process with its own state
const userProcess = supervisor.spawn(
  {
    name: "user-service",

    // Initialize state (runs once on start)
    init: () => ({
      connections: new Map(),
      cache: new Map(),
    }),

    // Handle messages (one at a time, no race conditions)
    handle: async (state, message) => {
      if (message.type === "get-user") {
        const user = await database.getUser(message.userId);
        state.cache.set(message.userId, user);
        return state;
      }

      return state;
    },
  },
  {},
);

// Send message - never blocks, never fails
userProcess.send({ type: "get-user", userId: "alice" });
```

Processes are isolated units with their own state. Messages are handled one at a time. If a process crashes, it restarts with fresh state. No shared state, no race conditions, no cascading failures.

## Start Simple: Basic Process

```typescript
import { createRootSupervisor } from "@phyxius/process";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();
const supervisor = createRootSupervisor({ clock });

// Counter process that manages its own state
const counter = supervisor.spawn(
  {
    name: "counter",
    init: () => ({ count: 0 }),
    handle: (state, message) => {
      switch (message.type) {
        case "increment":
          return { count: state.count + 1 };
        case "decrement":
          return { count: state.count - 1 };
        case "reset":
          return { count: 0 };
        default:
          return state;
      }
    },
  },
  {},
);

// Send messages
counter.send({ type: "increment" });
counter.send({ type: "increment" });
counter.send({ type: "decrement" });

console.log(counter.status()); // "running"
```

Each process handles one message at a time. No locks, no mutexes, no race conditions. The process state is isolated and safe.

## Add Responses: Request-Reply Pattern

```typescript
type CounterMessage = { type: "increment" } | { type: "get"; reply: (count: number) => void };

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

// Send async request with response
const count = await counter.ask((reply) => ({ type: "get", reply }));
console.log(`Current count: ${count}`);
```

The `ask` pattern provides synchronous-style request-response over async message passing. Timeouts prevent hanging forever.

## Add Timing: Scheduled Messages

```typescript
const heartbeat = supervisor.spawn(
  {
    name: "heartbeat",
    init: () => ({ lastPing: Date.now() }),
    handle: (state, message, tools) => {
      switch (message.type) {
        case "start":
          // Schedule a ping to ourselves in 1 second
          tools.schedule(1000, { type: "ping" });
          return state;

        case "ping":
          const now = Date.now();
          console.log(`Heartbeat: ${now - state.lastPing}ms since last ping`);

          // Schedule next ping
          tools.schedule(1000, { type: "ping" });
          return { lastPing: now };

        default:
          return state;
      }
    },
  },
  {},
);

// Start the heartbeat
heartbeat.send({ type: "start" });
```

Schedule messages to yourself for periodic behavior, timeouts, delayed operations. All timing is deterministic and testable.

## Add Resilience: Crash and Restart

```typescript
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

// Send work - even if it crashes, it restarts
for (let i = 0; i < 100; i++) {
  flakyWorker.send({ type: "work", item: i });
}
```

When a process crashes, it restarts with fresh state. Work continues. The error doesn't propagate or bring down other processes.

## Add Observability: Complete Telemetry

```typescript
const observable = supervisor.spawn(
  {
    name: "observable-worker",
    init: () => ({ tasks: 0 }),
    handle: async (state, message, tools) => {
      tools.emit?.({
        type: "worker:task:start",
        taskId: message.id,
        timestamp: tools.clock.now().wallMs,
      });

      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));

      tools.emit?.({
        type: "worker:task:complete",
        taskId: message.id,
        timestamp: tools.clock.now().wallMs,
      });

      return { tasks: state.tasks + 1 };
    },
  },
  {},
);

// Create supervisor with telemetry
const supervisor = createRootSupervisor({
  clock,
  emit: (event) => {
    console.log("Process event:", event);
  },
});
```

Every operation emits structured events. Process lifecycle, message handling, failures, restarts - complete visibility into system behavior.

## Add Supervision: Restart Policies

```typescript
// Create supervisor with restart policies
const resilientWorker = supervisor.spawn(
  {
    name: "resilient-worker",
    init: () => ({ failures: 0 }),
    handle: (state, message) => {
      if (message.type === "risky-work") {
        // Fail 50% of the time initially, then succeed
        if (state.failures < 3 && Math.random() < 0.5) {
          throw new Error(`Failure ${state.failures + 1}`);
        }

        return { failures: state.failures };
      }

      return state;
    },
    supervision: {
      type: "one-for-one",
      backoff: {
        initial: 100, // Start with 100ms
        max: 5000, // Cap at 5 seconds
        factor: 2, // Double each time
        jitter: 10, // ±10% randomization
      },
      maxRestarts: {
        count: 5, // Max 5 restarts
        within: 10000, // Within 10 seconds
      },
    },
  },
  {},
);

// Send risky work - supervisor handles failures automatically
resilientWorker.send({ type: "risky-work" });
```

Supervision strategies control restart behavior. Exponential backoff prevents thundering herds. Restart limits prevent infinite failure loops.

## Advanced: Process Hierarchy

```typescript
// Parent process that spawns and manages children
const taskManager = supervisor.spawn(
  {
    name: "task-manager",
    init: () => ({ workers: new Map(), nextWorkerId: 0 }),
    handle: (state, message, tools) => {
      switch (message.type) {
        case "spawn-worker":
          const workerId = state.nextWorkerId++;

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
          return { ...state, nextWorkerId: workerId + 1 };

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

// Create worker pool
taskManager.send({ type: "spawn-worker" });
taskManager.send({ type: "spawn-worker" });
taskManager.send({ type: "spawn-worker" });

// Distribute work
taskManager.send({ type: "distribute-task", data: "some work" });
```

Processes can spawn child processes. Build hierarchies, worker pools, pipeline architectures. Each process manages its children.

## Advanced: Stateful Services

```typescript
// Database connection pool as a process
const dbPool = supervisor.spawn(
  {
    name: "db-pool",
    init: async () => ({
      connections: [],
      maxConnections: 10,
      inUse: new Set(),
    }),
    handle: async (state, message, tools) => {
      switch (message.type) {
        case "acquire":
          // Find available connection
          const available = state.connections.find((conn) => !state.inUse.has(conn.id));

          if (available) {
            state.inUse.add(available.id);
            message.reply(available);
            return state;
          }

          // Create new connection if under limit
          if (state.connections.length < state.maxConnections) {
            const newConn = { id: crypto.randomUUID(), ready: true };
            state.connections.push(newConn);
            state.inUse.add(newConn.id);
            message.reply(newConn);
            return state;
          }

          // Pool exhausted
          message.reply(null);
          return state;

        case "release":
          state.inUse.delete(message.connectionId);
          return state;

        default:
          return state;
      }
    },
  },
  {},
);

// Use the pool
const connection = await dbPool.ask((reply) => ({
  type: "acquire",
  reply,
}));

if (connection) {
  // Use connection
  console.log(`Using connection ${connection.id}`);

  // Release when done
  dbPool.send({
    type: "release",
    connectionId: connection.id,
  });
}
```

Processes are perfect for stateful services. Connection pools, caches, session managers, rate limiters - any service that needs to maintain state safely.

## Advanced: Event Sourcing Integration

```typescript
import { Journal } from "@phyxius/journal";

// Process with full event sourcing
const bankAccount = supervisor.spawn(
  {
    name: "bank-account",
    init: (ctx) => ({
      balance: 0,
      accountId: ctx.accountId,
      journal: new Journal({ clock }),
    }),
    handle: (state, message, tools) => {
      switch (message.type) {
        case "deposit":
          const depositEvent = {
            type: "deposit" as const,
            amount: message.amount,
            timestamp: tools.clock.now().wallMs,
          };

          // Append to event log
          state.journal.append(depositEvent);

          // Update state
          const newBalance = state.balance + message.amount;

          tools.emit?.({
            type: "account:deposit",
            accountId: state.accountId,
            amount: message.amount,
            newBalance,
          });

          message.reply?.({ success: true, balance: newBalance });

          return { ...state, balance: newBalance };

        case "withdraw":
          if (state.balance < message.amount) {
            message.reply?.({ success: false, error: "Insufficient funds" });
            return state;
          }

          const withdrawEvent = {
            type: "withdraw" as const,
            amount: message.amount,
            timestamp: tools.clock.now().wallMs,
          };

          state.journal.append(withdrawEvent);

          const finalBalance = state.balance - message.amount;

          message.reply?.({ success: true, balance: finalBalance });

          return { ...state, balance: finalBalance };

        case "get-balance":
          message.reply(state.balance);
          return state;

        default:
          return state;
      }
    },
  },
  { accountId: "acc-123" },
);

// Use the account
const depositResult = await bankAccount.ask((reply) => ({
  type: "deposit",
  amount: 100,
  reply,
}));

const balance = await bankAccount.ask((reply) => ({
  type: "get-balance",
  reply,
}));

console.log(`Deposit result:`, depositResult);
console.log(`Balance:`, balance);
```

Combine Process with Journal for event-sourced systems. Every state change is an event. Process restarts can replay events to rebuild state.

## The Full Power: Distributed System Simulation

```typescript
// Distributed cache with gossip protocol
const createCacheNode = (nodeId: string, peers: string[]) => {
  return supervisor.spawn(
    {
      name: `cache-node-${nodeId}`,
      init: () => ({
        nodeId,
        data: new Map(),
        version: 0,
        peers: new Map(), // peer -> ProcessRef
        lastGossip: 0,
      }),
      handle: async (state, message, tools) => {
        switch (message.type) {
          case "connect-peer":
            state.peers.set(message.peerId, message.peerRef);
            return state;

          case "set":
            // Update local data
            state.data.set(message.key, {
              value: message.value,
              version: ++state.version,
              nodeId: state.nodeId,
            });

            // Gossip to peers
            for (const peer of state.peers.values()) {
              peer.send({
                type: "gossip",
                key: message.key,
                value: message.value,
                version: state.version,
                nodeId: state.nodeId,
              });
            }

            message.reply?.({ success: true });
            return state;

          case "get":
            const entry = state.data.get(message.key);
            message.reply(entry ? entry.value : null);
            return state;

          case "gossip":
            const existing = state.data.get(message.key);

            // Accept if we don't have it, or remote version is newer
            if (!existing || message.version > existing.version) {
              state.data.set(message.key, {
                value: message.value,
                version: message.version,
                nodeId: message.nodeId,
              });

              tools.emit?.({
                type: "cache:gossip:accepted",
                nodeId: state.nodeId,
                key: message.key,
                fromNode: message.nodeId,
                version: message.version,
              });
            }

            return state;

          case "periodic-gossip":
            // Periodically gossip all data to all peers
            const now = tools.clock.now().wallMs;
            if (now - state.lastGossip > 5000) {
              // Every 5 seconds
              for (const [key, entry] of state.data) {
                for (const peer of state.peers.values()) {
                  peer.send({
                    type: "gossip",
                    key,
                    value: entry.value,
                    version: entry.version,
                    nodeId: entry.nodeId,
                  });
                }
              }

              // Schedule next gossip
              tools.schedule(5000, { type: "periodic-gossip" });
              return { ...state, lastGossip: now };
            }

            return state;

          default:
            return state;
        }
      },
    },
    {},
  );
};

// Create 3-node distributed cache
const node1 = createCacheNode("node1", ["node2", "node3"]);
const node2 = createCacheNode("node2", ["node1", "node3"]);
const node3 = createCacheNode("node3", ["node1", "node2"]);

// Connect the peers
node1.send({ type: "connect-peer", peerId: "node2", peerRef: node2 });
node1.send({ type: "connect-peer", peerId: "node3", peerRef: node3 });
node2.send({ type: "connect-peer", peerId: "node1", peerRef: node1 });
node2.send({ type: "connect-peer", peerId: "node3", peerRef: node3 });
node3.send({ type: "connect-peer", peerId: "node1", peerRef: node1 });
node3.send({ type: "connect-peer", peerId: "node2", peerRef: node2 });

// Start periodic gossip
node1.send({ type: "periodic-gossip" });
node2.send({ type: "periodic-gossip" });
node3.send({ type: "periodic-gossip" });

// Write to different nodes
await node1.ask((reply) => ({ type: "set", key: "user:alice", value: { name: "Alice" }, reply }));
await node2.ask((reply) => ({ type: "set", key: "user:bob", value: { name: "Bob" }, reply }));
await node3.ask((reply) => ({ type: "set", key: "user:charlie", value: { name: "Charlie" }, reply }));

// Wait for gossip to propagate
await new Promise((resolve) => setTimeout(resolve, 1000));

// Read from any node - should have all data
const aliceFromNode2 = await node2.ask((reply) => ({ type: "get", key: "user:alice", reply }));
const bobFromNode3 = await node3.ask((reply) => ({ type: "get", key: "user:bob", reply }));
const charlieFromNode1 = await node1.ask((reply) => ({ type: "get", key: "user:charlie", reply }));

console.log("Distributed cache results:");
console.log("Alice from node2:", aliceFromNode2);
console.log("Bob from node3:", bobFromNode3);
console.log("Charlie from node1:", charlieFromNode1);
```

This is the full power of Process. Distributed systems with gossip protocols, peer-to-peer networks, consensus algorithms, replication strategies. Each node is an isolated process. Communication is through message passing. Failures are isolated and recoverable.

## Interface

```typescript
interface ProcessSpec<TMsg, TState, TCtx = unknown> {
  name: string;
  init(ctx: TCtx): Promise<TState> | TState;
  handle(state: TState, msg: TMsg, tools: Tools<TState, TMsg, TCtx>): Promise<TState> | TState;
  onStop?(state: TState, reason: StopReason, ctx: TCtx): Promise<void> | void;
  maxInbox?: number;
  mailboxPolicy?: "reject" | "drop-oldest";
  supervision?: SupervisionStrategy;
}

interface ProcessRef<TMsg> {
  id: ProcessId;
  send(msg: TMsg): boolean;
  stop(reason?: StopReason): Promise<void>;
  ask<TResp>(build: (reply: (r: TResp) => void) => TMsg, timeout?: number): Promise<TResp>;
  status(): ProcessStatus;
}

interface Tools<TState, TMsg, TCtx> {
  clock: Clock;
  ctx: TCtx;
  emit?: EmitFn;
  spawn<TM, TS, TC>(spec: ProcessSpec<TM, TS, TC>, ctx: TC): ProcessRef<TM>;
  ask<T>(desc: string, f: (res: (value: T) => void, rej: (e: unknown) => void) => void, timeout?: number): Promise<T>;
  schedule(after: number, msg: TMsg): void;
}
```

## Installation

```bash
npm install @phyxius/process @phyxius/clock
```

## What You Get

**Units that restart on failure.** Processes crash and restart automatically. Errors don't propagate. Systems heal themselves.

**Systems that heal themselves.** Supervision strategies control restart behavior. Exponential backoff, restart limits, graceful degradation.

**Concurrency without chaos.** No shared state, no race conditions, no deadlocks. Message passing eliminates data races.

**Scalability without complexity.** From single processes to distributed systems. Same patterns, same guarantees.

Process solves concurrency. Everything else builds on that foundation.

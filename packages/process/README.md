# Process

**Actor-like units with supervision for fault-tolerant distributed systems**

## What is Process?

Process provides actor-model concurrency with supervision strategies. Each Process is an independent unit that handles messages asynchronously, maintains its own state, and can be supervised by other processes for fault tolerance. When processes fail, supervisors can restart, stop, or escalate based on configured strategies.

Think of Process as a "resilient worker" that handles tasks independently, communicates through messages, and automatically recovers from failures according to your supervision policies.

## Why does Process exist?

Building fault-tolerant distributed systems is challenging. Traditional approaches often result in cascading failures, resource leaks, and systems that become unstable under load. The actor model with supervision provides a battle-tested approach to building resilient systems.

**The Problem:**

```typescript
// Fragile: no fault tolerance, shared state, cascading failures
class OrderProcessor {
  private orders: Order[] = [];
  private isProcessing = false;

  async processOrder(order: Order) {
    if (this.isProcessing) {
      throw new Error("Already processing"); // Blocks other orders
    }

    this.isProcessing = true;

    try {
      // If this fails, the entire processor becomes unusable
      await this.validateOrder(order);
      await this.updateInventory(order);
      await this.chargeCustomer(order);

      this.orders.push(order);
    } catch (error) {
      // What do we do now? How do we recover?
      // How do we handle the next order?
      // How do we prevent this error from affecting other orders?
      this.isProcessing = false;
      throw error;
    }

    this.isProcessing = false;
  }

  // Shared state, no isolation, no recovery strategy
}

// Multiple processors compete for resources
const processor1 = new OrderProcessor();
const processor2 = new OrderProcessor();

// If one fails, others might be affected
// No coordination, no supervision, no automatic recovery
```

**The Solution:**

```typescript
// Resilient: isolated processes, supervision, automatic recovery
const supervisor = createSupervisor();

// Each process handles messages independently
const orderProcessor = await supervisor.spawn({
  async handle(message) {
    switch (message.type) {
      case "process_order":
        return await this.processOrder(message.order);
      case "get_status":
        return this.getProcessingStatus();
    }
  }
});

// If process fails, supervisor automatically restarts it
// Other processes continue unaffected
// Messages are queued until process recovers

await orderProcessor.send({
  type: "process_order",
  order: { id: "order123", items: [...] }
});

// System stays responsive even when individual processes fail
```

## Why is Process good?

### 1. **Fault Isolation**

Failures in one process don't affect others. Each process has its own memory space and failure domain.

### 2. **Automatic Recovery**

Supervisors monitor processes and restart them according to configurable strategies.

### 3. **Message-Based Communication**

Processes communicate through messages, eliminating shared state and race conditions.

### 4. **Scalable Architecture**

Add more processes to handle increased load without complex coordination.

### 5. **Observable System**

All process lifecycle events are emitted for monitoring and debugging.

## Usage Examples

### Basic Process Creation

```typescript
import { createProcess, createSupervisor } from "@phyxius/process";

// Create a simple process
const echoProcess = createProcess({
  async handle(message) {
    console.log("Received:", message);
    return `Echo: ${message.text}`;
  },
});

await echoProcess.start();
const response = await echoProcess.send({ text: "Hello, World!" });
console.log(response); // "Echo: Hello, World!"
```

### Counter Process with State

```typescript
interface CounterMessage {
  type: "increment" | "decrement" | "get" | "reset";
  amount?: number;
}

const counterBehavior = {
  // Initialize process state
  async init() {
    this.count = 0;
  },

  async handle(message: CounterMessage) {
    switch (message.type) {
      case "increment":
        this.count += message.amount || 1;
        return this.count;

      case "decrement":
        this.count -= message.amount || 1;
        return this.count;

      case "get":
        return this.count;

      case "reset":
        this.count = 0;
        return this.count;

      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  },
};

const counter = createProcess(counterBehavior);
await counter.start();

await counter.send({ type: "increment", amount: 5 }); // Returns 5
await counter.send({ type: "increment" }); // Returns 6
await counter.send({ type: "decrement", amount: 2 }); // Returns 4
const current = await counter.send({ type: "get" }); // Returns 4
```

### Order Processing System

```typescript
interface Order {
  id: string;
  userId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  total: number;
}

interface OrderMessage {
  type: "process_order" | "cancel_order" | "get_status";
  order?: Order;
  orderId?: string;
}

class OrderProcessorBehavior {
  private processedOrders = new Map<string, Order>();
  private failedOrders = new Map<string, { order: Order; error: string }>();

  async init() {
    console.log("Order processor initialized");
  }

  async handle(message: OrderMessage) {
    switch (message.type) {
      case "process_order":
        return await this.processOrder(message.order!);

      case "cancel_order":
        return await this.cancelOrder(message.orderId!);

      case "get_status":
        return {
          processed: this.processedOrders.size,
          failed: this.failedOrders.size,
          processedOrders: Array.from(this.processedOrders.keys()),
          failedOrders: Array.from(this.failedOrders.keys()),
        };
    }
  }

  private async processOrder(order: Order) {
    console.log(`Processing order ${order.id}`);

    try {
      // Validate order
      await this.validateOrder(order);

      // Update inventory
      await this.updateInventory(order);

      // Charge customer
      await this.chargeCustomer(order);

      // Record successful processing
      this.processedOrders.set(order.id, order);

      console.log(`Order ${order.id} processed successfully`);
      return { success: true, orderId: order.id };
    } catch (error) {
      // Record failure
      this.failedOrders.set(order.id, { order, error: error.message });

      console.error(`Order ${order.id} failed:`, error.message);
      throw error; // Process will fail and be restarted by supervisor
    }
  }

  private async validateOrder(order: Order) {
    // Simulate validation
    if (order.total <= 0) {
      throw new Error("Invalid order total");
    }

    if (!order.items.length) {
      throw new Error("Order has no items");
    }

    // Random failure for demonstration
    if (Math.random() < 0.1) {
      throw new Error("Validation service unavailable");
    }
  }

  private async updateInventory(order: Order) {
    // Simulate inventory update
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Random failure for demonstration
    if (Math.random() < 0.05) {
      throw new Error("Inventory service unavailable");
    }
  }

  private async chargeCustomer(order: Order) {
    // Simulate payment processing
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Random failure for demonstration
    if (Math.random() < 0.05) {
      throw new Error("Payment service unavailable");
    }
  }

  private async cancelOrder(orderId: string) {
    if (this.processedOrders.has(orderId)) {
      this.processedOrders.delete(orderId);
      return { success: true, message: `Order ${orderId} cancelled` };
    }

    return { success: false, message: `Order ${orderId} not found` };
  }

  async terminate() {
    console.log("Order processor shutting down");
    console.log(`Processed ${this.processedOrders.size} orders`);
    console.log(`Failed ${this.failedOrders.size} orders`);
  }
}

// Create supervised order processor
const supervisor = createSupervisor();
const orderProcessor = await supervisor.spawn(new OrderProcessorBehavior());

// Process multiple orders concurrently
const orders: Order[] = [
  { id: "order1", userId: "user1", items: [{ productId: "p1", quantity: 2, price: 10 }], total: 20 },
  { id: "order2", userId: "user2", items: [{ productId: "p2", quantity: 1, price: 50 }], total: 50 },
  { id: "order3", userId: "user3", items: [{ productId: "p3", quantity: 3, price: 15 }], total: 45 },
];

// Send orders for processing (non-blocking)
const promises = orders.map((order) =>
  orderProcessor.send({ type: "process_order", order }).catch((error) => ({ error: error.message, order })),
);

const results = await Promise.all(promises);
console.log("Processing results:", results);

// Get final status
const status = await orderProcessor.send({ type: "get_status" });
console.log("Final status:", status);
```

### Chat Room System

```typescript
interface ChatMessage {
  type: "join" | "leave" | "message" | "get_users" | "get_messages";
  userId?: string;
  username?: string;
  text?: string;
}

class ChatRoomBehavior {
  private users = new Map<string, { username: string; joinedAt: number }>();
  private messages: Array<{ userId: string; username: string; text: string; timestamp: number }> = [];
  private maxMessages = 100;

  async init() {
    console.log("Chat room started");
  }

  async handle(message: ChatMessage) {
    switch (message.type) {
      case "join":
        return await this.handleJoin(message.userId!, message.username!);

      case "leave":
        return await this.handleLeave(message.userId!);

      case "message":
        return await this.handleMessage(message.userId!, message.text!);

      case "get_users":
        return Array.from(this.users.values());

      case "get_messages":
        return this.messages.slice(-50); // Last 50 messages
    }
  }

  private async handleJoin(userId: string, username: string) {
    this.users.set(userId, { username, joinedAt: Date.now() });

    const joinMessage = {
      userId: "system",
      username: "System",
      text: `${username} joined the chat`,
      timestamp: Date.now(),
    };

    this.addMessage(joinMessage);

    return {
      success: true,
      message: `Welcome ${username}!`,
      userCount: this.users.size,
    };
  }

  private async handleLeave(userId: string) {
    const user = this.users.get(userId);
    if (!user) {
      return { success: false, message: "User not found" };
    }

    this.users.delete(userId);

    const leaveMessage = {
      userId: "system",
      username: "System",
      text: `${user.username} left the chat`,
      timestamp: Date.now(),
    };

    this.addMessage(leaveMessage);

    return {
      success: true,
      message: `${user.username} left the chat`,
      userCount: this.users.size,
    };
  }

  private async handleMessage(userId: string, text: string) {
    const user = this.users.get(userId);
    if (!user) {
      return { success: false, message: "User not in chat room" };
    }

    const chatMessage = {
      userId,
      username: user.username,
      text,
      timestamp: Date.now(),
    };

    this.addMessage(chatMessage);

    return {
      success: true,
      message: "Message sent",
      messageCount: this.messages.length,
    };
  }

  private addMessage(message: any) {
    this.messages.push(message);

    // Keep only recent messages
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  async terminate() {
    console.log("Chat room shutting down");
    console.log(`${this.users.size} users were online`);
    console.log(`${this.messages.length} messages in history`);
  }
}

// Create chat room
const chatRoom = await supervisor.spawn(new ChatRoomBehavior());

// Users join the chat
await chatRoom.send({ type: "join", userId: "user1", username: "Alice" });
await chatRoom.send({ type: "join", userId: "user2", username: "Bob" });
await chatRoom.send({ type: "join", userId: "user3", username: "Charlie" });

// Send messages
await chatRoom.send({ type: "message", userId: "user1", text: "Hello everyone!" });
await chatRoom.send({ type: "message", userId: "user2", text: "Hi Alice! How are you?" });
await chatRoom.send({ type: "message", userId: "user3", text: "Great to see you all here!" });

// Get current state
const users = await chatRoom.send({ type: "get_users" });
const messages = await chatRoom.send({ type: "get_messages" });

console.log("Users online:", users);
console.log("Recent messages:", messages);
```

### Worker Pool for Background Tasks

```typescript
interface TaskMessage {
  type: "execute_task" | "get_stats";
  task?: {
    id: string;
    type: string;
    payload: any;
  };
}

class WorkerBehavior {
  private tasksExecuted = 0;
  private tasksSuccess = 0;
  private tasksFailed = 0;
  private currentTask: string | null = null;

  async init() {
    console.log(`Worker ${this.workerId} initialized`);
  }

  constructor(private workerId: string) {}

  async handle(message: TaskMessage) {
    switch (message.type) {
      case "execute_task":
        return await this.executeTask(message.task!);

      case "get_stats":
        return {
          workerId: this.workerId,
          tasksExecuted: this.tasksExecuted,
          tasksSuccess: this.tasksSuccess,
          tasksFailed: this.tasksFailed,
          currentTask: this.currentTask,
        };
    }
  }

  private async executeTask(task: any) {
    this.currentTask = task.id;
    this.tasksExecuted++;

    console.log(`Worker ${this.workerId} executing task ${task.id} (${task.type})`);

    try {
      const result = await this.processTask(task);
      this.tasksSuccess++;
      this.currentTask = null;

      console.log(`Worker ${this.workerId} completed task ${task.id}`);
      return { success: true, result, workerId: this.workerId };
    } catch (error) {
      this.tasksFailed++;
      this.currentTask = null;

      console.error(`Worker ${this.workerId} failed task ${task.id}:`, error.message);
      throw error;
    }
  }

  private async processTask(task: any) {
    // Simulate different types of work
    switch (task.type) {
      case "image_resize":
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
        return { resizedImages: task.payload.images.length, format: "jpg" };

      case "email_send":
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
        if (Math.random() < 0.1) throw new Error("SMTP server unavailable");
        return { sent: true, recipient: task.payload.recipient };

      case "data_analysis":
        await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 500));
        if (Math.random() < 0.05) throw new Error("Analysis failed");
        return { analyzed: task.payload.records, insights: Math.floor(Math.random() * 10) };

      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }
  }

  async terminate() {
    console.log(`Worker ${this.workerId} shutting down`);
    console.log(`Executed ${this.tasksExecuted} tasks (${this.tasksSuccess} success, ${this.tasksFailed} failed)`);
  }
}

// Create worker pool
const workerPool = {
  workers: [] as any[],

  async init(size: number) {
    const supervisor = createSupervisor();

    for (let i = 0; i < size; i++) {
      const worker = await supervisor.spawn(new WorkerBehavior(`worker-${i + 1}`));
      this.workers.push(worker);
    }

    console.log(`Worker pool initialized with ${size} workers`);
  },

  async executeTask(task: any) {
    // Simple round-robin task distribution
    const worker = this.workers[Math.floor(Math.random() * this.workers.length)];
    return await worker.send({ type: "execute_task", task });
  },

  async getStats() {
    const stats = await Promise.all(this.workers.map((worker) => worker.send({ type: "get_stats" })));

    return {
      totalWorkers: this.workers.length,
      workers: stats,
      totalTasks: stats.reduce((sum, s) => sum + s.tasksExecuted, 0),
      totalSuccess: stats.reduce((sum, s) => sum + s.tasksSuccess, 0),
      totalFailed: stats.reduce((sum, s) => sum + s.tasksFailed, 0),
    };
  },
};

// Initialize worker pool
await workerPool.init(3);

// Submit tasks
const tasks = [
  { id: "task1", type: "image_resize", payload: { images: ["img1.jpg", "img2.png"] } },
  { id: "task2", type: "email_send", payload: { recipient: "user@example.com" } },
  { id: "task3", type: "data_analysis", payload: { records: 1000 } },
  { id: "task4", type: "image_resize", payload: { images: ["img3.gif"] } },
  { id: "task5", type: "email_send", payload: { recipient: "admin@example.com" } },
];

// Execute tasks concurrently
const results = await Promise.allSettled(tasks.map((task) => workerPool.executeTask(task)));

console.log("Task results:", results);

// Get worker pool statistics
const poolStats = await workerPool.getStats();
console.log("Worker pool stats:", poolStats);
```

### Supervision Strategies

```typescript
// Different supervision strategies for different failure scenarios
const supervisor = createSupervisor({
  emit: (event) => console.log("Supervisor event:", event),
});

// Critical service: always restart on failure
const databaseService = await supervisor.spawn({
  async handle(message) {
    if (message.type === "query") {
      // Simulate occasional database failures
      if (Math.random() < 0.1) {
        throw new Error("Database connection lost");
      }
      return { result: "data" };
    }
  },
});

// Apply restart strategy (default)
supervisor.supervise(databaseService, "restart");

// Batch job: stop on failure (don't restart automatically)
const batchJob = await supervisor.spawn({
  async handle(message) {
    if (message.type === "process_batch") {
      // Simulate batch processing that might fail
      if (Math.random() < 0.2) {
        throw new Error("Batch processing failed");
      }
      return { processed: 100 };
    }
  },
});

// Apply stop strategy - don't restart failed batch jobs
supervisor.supervise(batchJob, "stop");

// External API client: escalate failures to parent supervisor
const apiClient = await supervisor.spawn({
  async handle(message) {
    if (message.type === "api_call") {
      // Simulate API failures
      if (Math.random() < 0.15) {
        throw new Error("External API unavailable");
      }
      return { data: "api response" };
    }
  },
});

// Escalate API failures - let parent supervisor decide what to do
supervisor.supervise(apiClient, "escalate");

// Test the supervision behavior
try {
  // These calls might trigger supervision actions
  await databaseService.send({ type: "query" }); // May restart on failure
  await batchJob.send({ type: "process_batch" }); // Will stop on failure
  await apiClient.send({ type: "api_call" }); // Will escalate on failure
} catch (error) {
  console.log("Some operations failed, but supervisor handled recovery");
}

// Check supervisor status
const children = supervisor.getChildren();
console.log(`Supervisor managing ${children.length} processes`);
```

## API Reference

### Creating Processes

```typescript
// Create a process with behavior
const process = createProcess(behavior, options?);

// Create a supervisor for managing processes
const supervisor = createSupervisor(options?);
```

### Process Methods

```typescript
// Start the process
await process.start();

// Send a message
const result = await process.send(message);

// Stop the process
await process.stop();

// Get process information
const info = process.getInfo();

// Check current state
const state = process.state; // "starting" | "running" | "stopping" | "stopped" | "failed"
```

### Supervisor Methods

```typescript
// Spawn a new child process
const child = await supervisor.spawn(behavior);

// Apply supervision strategy
supervisor.supervise(process, strategy); // "restart" | "stop" | "escalate"

// Get all children
const children = supervisor.getChildren();

// Stop supervisor and all children
await supervisor.stop();
```

### Process Behavior Interface

```typescript
interface ProcessBehavior<T = any> {
  // Optional initialization
  init?(): Promise<void>;

  // Required message handler
  handle(message: T): Promise<any>;

  // Optional cleanup
  terminate?(): Promise<void>;
}
```

### Process Information

```typescript
interface ProcessInfo {
  id: ProcessId;
  state: ProcessState;
  startedAt: number;
  restartCount: number;
  lastError?: Error;
}
```

## Testing Patterns

### Testing Process Behavior

```typescript
describe("CounterProcess", () => {
  it("should increment counter", async () => {
    const counter = createProcess(counterBehavior);
    await counter.start();

    const result = await counter.send({ type: "increment", amount: 5 });
    expect(result).toBe(5);

    const current = await counter.send({ type: "get" });
    expect(current).toBe(5);
  });
});
```

### Testing Supervision

```typescript
describe("ProcessSupervision", () => {
  it("should restart failed processes", async () => {
    const supervisor = createSupervisor();

    let attempts = 0;
    const process = await supervisor.spawn({
      handle: async (message) => {
        attempts++;
        if (attempts === 1) {
          throw new Error("First attempt fails");
        }
        return "success";
      },
    });

    // First call will fail and trigger restart
    await expect(process.send({ type: "test" })).rejects.toThrow();

    // Wait for restart, then try again
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await process.send({ type: "test" });
    expect(result).toBe("success");
  });
});
```

### Testing Message Handling

```typescript
describe("MessageHandling", () => {
  it("should handle messages in order", async () => {
    const messages: string[] = [];

    const process = createProcess({
      handle: async (message) => {
        messages.push(message.text);
        return `processed: ${message.text}`;
      },
    });

    await process.start();

    await Promise.all([
      process.send({ text: "first" }),
      process.send({ text: "second" }),
      process.send({ text: "third" }),
    ]);

    expect(messages).toEqual(["first", "second", "third"]);
  });
});
```

---

Process provides the actor model with supervision for building fault-tolerant distributed systems. By isolating failures, providing automatic recovery, and enabling message-based communication, it creates resilient architectures that can handle failures gracefully and scale effectively. Combined with other Phyxius primitives, it forms the backbone of robust, observable distributed systems.

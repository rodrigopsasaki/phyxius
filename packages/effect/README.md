# Effect

**Structured concurrency with context propagation for reliable async operations**

## What is Effect?

Effect provides structured concurrency - a way to manage async operations that ensures resources are properly cleaned up, contexts are propagated correctly, and concurrent operations are coordinated safely. It's like having a "supervisor" for all your async code that prevents resource leaks and ensures proper cleanup.

Think of Effect as a "smart Promise" that carries context, can be cancelled cleanly, and ensures that no async operation is left hanging when its parent operation completes or fails.

## Why does Effect exist?

Async programming in JavaScript is powerful but dangerous. Promise-based code often suffers from resource leaks, lost contexts, and cascading failures. When operations fail or need to be cancelled, cleanup becomes a nightmare.

**The Problem:**

```typescript
// Dangerous: resource leaks, lost context, no cancellation
class DataProcessor {
  async processData(userId: string) {
    // No way to pass userId through the operation chain
    const data = await this.fetchData();

    // If this fails, cleanup is manual and error-prone
    const processed = await this.transformData(data);

    // Multiple async operations - no coordination
    const [result1, result2] = await Promise.all([this.saveToDatabase(processed), this.sendNotification(processed)]);

    // What if we need to cancel? How do we clean up resources?
    // How do we know which operation failed?
    // How do we pass context through the chain?
  }

  // Context is lost - no way to know which user this is for
  private async transformData(data: any) {
    // Need userId here but it's not available!
    return this.applyUserSpecificTransforms(data, "???");
  }
}
```

**The Solution:**

```typescript
// Safe: structured concurrency, context propagation, clean cancellation
class DataProcessor {
  async processData(userId: string) {
    return runEffect(async (context) => {
      // Context is available everywhere in the operation tree
      context.set("userId", userId);
      context.set("operation", "data_processing");

      const data = await this.fetchData(context);
      const processed = await this.transformData(data, context);

      // Concurrent operations with proper coordination
      const [result1, result2] = await Promise.all([
        this.saveToDatabase(processed, context),
        this.sendNotification(processed, context),
      ]);

      return { result1, result2 };
    });

    // If this Effect is cancelled or fails, all child operations
    // are automatically cancelled and cleaned up
  }

  private async transformData(data: any, context: Context) {
    const userId = context.get("userId");
    // Context is available! Operations are traceable!
    return this.applyUserSpecificTransforms(data, userId);
  }
}
```

## Why is Effect good?

### 1. **Structured Concurrency**

Parent operations automatically manage child operations - no resource leaks or orphaned promises.

### 2. **Context Propagation**

Values like user IDs, request IDs, and configuration flow through operation chains automatically.

### 3. **Clean Cancellation**

Cancel operations and all their children with proper cleanup guaranteed.

### 4. **Error Boundaries**

Errors are contained and handled at the right level in the operation hierarchy.

### 5. **Observability**

Every operation can be traced and monitored through the context chain.

## Usage Examples

### Basic Context Propagation

```typescript
import { runEffect } from "@phyxius/effect";

// Simple context usage
const result = await runEffect(async (context) => {
  context.set("requestId", "req-123");
  context.set("userId", "user-456");

  return await performOperation(context);
});

async function performOperation(context) {
  const requestId = context.get("requestId");
  const userId = context.get("userId");

  console.log(`Processing ${requestId} for ${userId}`);

  // Context flows to nested operations
  return await nestedOperation(context);
}

async function nestedOperation(context) {
  // Still has access to parent context
  const requestId = context.get("requestId");
  console.log(`Nested operation for ${requestId}`);

  return "completed";
}
```

### Request Processing with Tracing

```typescript
interface RequestContext {
  requestId: string;
  userId: string;
  startTime: number;
  correlationId: string;
}

class RequestProcessor {
  async handleRequest(req: Request): Promise<Response> {
    return runEffect(async (context) => {
      const requestContext: RequestContext = {
        requestId: generateId(),
        userId: req.headers["user-id"],
        startTime: Date.now(),
        correlationId: req.headers["correlation-id"] || generateId(),
      };

      // Set context for the entire request tree
      context.set("request", requestContext);
      context.set("logger", this.createLogger(requestContext));

      try {
        // All operations will have access to this context
        const data = await this.fetchUserData(context);
        const processed = await this.processData(data, context);
        const response = await this.formatResponse(processed, context);

        this.logSuccess(context);
        return response;
      } catch (error) {
        this.logError(context, error);
        throw error;
      }
    });
  }

  private async fetchUserData(context) {
    const { userId, requestId } = context.get("request");
    const logger = context.get("logger");

    logger.info(`Fetching data for user ${userId}`, { requestId });

    // Simulate async operation
    await new Promise((resolve) => setTimeout(resolve, 100));

    return { userId, data: "user-data" };
  }

  private async processData(data: any, context) {
    const { requestId } = context.get("request");
    const logger = context.get("logger");

    logger.info("Processing data", { requestId, dataSize: JSON.stringify(data).length });

    // Context flows through all operations
    return await this.applyTransformations(data, context);
  }

  private async applyTransformations(data: any, context) {
    const { correlationId } = context.get("request");

    // Can access parent context at any depth
    return {
      ...data,
      correlationId,
      processed: true,
      timestamp: Date.now(),
    };
  }

  private createLogger(requestContext: RequestContext) {
    return {
      info: (message: string, metadata = {}) => {
        console.log(
          JSON.stringify({
            level: "info",
            message,
            requestId: requestContext.requestId,
            correlationId: requestContext.correlationId,
            ...metadata,
          }),
        );
      },
      error: (message: string, error: any, metadata = {}) => {
        console.error(
          JSON.stringify({
            level: "error",
            message,
            error: error.message,
            requestId: requestContext.requestId,
            correlationId: requestContext.correlationId,
            ...metadata,
          }),
        );
      },
    };
  }

  private logSuccess(context) {
    const { requestId, startTime } = context.get("request");
    const duration = Date.now() - startTime;
    const logger = context.get("logger");

    logger.info("Request completed successfully", {
      requestId,
      duration,
    });
  }

  private logError(context, error) {
    const { requestId, startTime } = context.get("request");
    const duration = Date.now() - startTime;
    const logger = context.get("logger");

    logger.error("Request failed", error, {
      requestId,
      duration,
    });
  }
}

// Usage
const processor = new RequestProcessor();
const response = await processor.handleRequest({
  headers: {
    "user-id": "user123",
    "correlation-id": "corr-456",
  },
});
```

### Database Transaction Management

```typescript
interface TransactionContext {
  transactionId: string;
  connection: DatabaseConnection;
  operations: string[];
}

class DatabaseService {
  async withTransaction<T>(operation: (context) => Promise<T>): Promise<T> {
    return runEffect(async (context) => {
      const connection = await this.getConnection();
      const transactionId = generateId();

      const txContext: TransactionContext = {
        transactionId,
        connection,
        operations: [],
      };

      context.set("transaction", txContext);

      try {
        await connection.begin();
        console.log(`Transaction ${transactionId} started`);

        const result = await operation(context);

        await connection.commit();
        console.log(`Transaction ${transactionId} committed`, {
          operations: txContext.operations,
        });

        return result;
      } catch (error) {
        await connection.rollback();
        console.log(`Transaction ${transactionId} rolled back`, {
          operations: txContext.operations,
          error: error.message,
        });
        throw error;
      } finally {
        await connection.close();
      }
    });
  }

  async createUser(userData: any, context) {
    const transaction = context.get("transaction");
    transaction.operations.push("create_user");

    const query = "INSERT INTO users (name, email) VALUES (?, ?)";
    const result = await transaction.connection.execute(query, [userData.name, userData.email]);

    console.log(`User created in transaction ${transaction.transactionId}`, {
      userId: result.insertId,
    });

    return result.insertId;
  }

  async createProfile(userId: number, profileData: any, context) {
    const transaction = context.get("transaction");
    transaction.operations.push("create_profile");

    const query = "INSERT INTO profiles (user_id, bio, avatar) VALUES (?, ?, ?)";
    await transaction.connection.execute(query, [userId, profileData.bio, profileData.avatar]);

    console.log(`Profile created in transaction ${transaction.transactionId}`, {
      userId,
    });
  }

  async sendWelcomeEmail(userId: number, context) {
    const transaction = context.get("transaction");
    transaction.operations.push("send_welcome_email");

    // This could fail and cause the entire transaction to rollback
    await this.emailService.send({
      to: await this.getUserEmail(userId, context),
      template: "welcome",
      data: { userId },
    });

    console.log(`Welcome email sent in transaction ${transaction.transactionId}`, {
      userId,
    });
  }
}

// Usage: All-or-nothing user creation
const dbService = new DatabaseService();

try {
  const result = await dbService.withTransaction(async (context) => {
    const userId = await dbService.createUser(
      {
        name: "John Doe",
        email: "john@example.com",
      },
      context,
    );

    await dbService.createProfile(
      userId,
      {
        bio: "Software developer",
        avatar: "avatar.jpg",
      },
      context,
    );

    await dbService.sendWelcomeEmail(userId, context);

    return { userId, success: true };
  });

  console.log("User creation completed:", result);
} catch (error) {
  console.log("User creation failed, everything rolled back:", error.message);
}
```

### Concurrent Operations with Coordination

```typescript
class DataAggregator {
  async aggregateUserData(userId: string) {
    return runEffect(async (context) => {
      context.set("userId", userId);
      context.set("operation", "user_data_aggregation");
      context.set("startTime", Date.now());

      // Fetch data from multiple sources concurrently
      // All operations share the same context
      const [profile, orders, preferences, activity] = await Promise.all([
        this.fetchUserProfile(context),
        this.fetchUserOrders(context),
        this.fetchUserPreferences(context),
        this.fetchUserActivity(context),
      ]);

      // Process the aggregated data
      return await this.buildUserSummary(
        {
          profile,
          orders,
          preferences,
          activity,
        },
        context,
      );
    });
  }

  private async fetchUserProfile(context) {
    const userId = context.get("userId");
    const operation = context.get("operation");

    console.log(`Fetching profile for ${userId} in ${operation}`);

    // Simulate async operation
    await new Promise((resolve) => setTimeout(resolve, 50));

    return {
      id: userId,
      name: "John Doe",
      email: "john@example.com",
    };
  }

  private async fetchUserOrders(context) {
    const userId = context.get("userId");

    console.log(`Fetching orders for ${userId}`);

    await new Promise((resolve) => setTimeout(resolve, 100));

    return [
      { id: "order1", amount: 99.99 },
      { id: "order2", amount: 149.99 },
    ];
  }

  private async fetchUserPreferences(context) {
    const userId = context.get("userId");

    console.log(`Fetching preferences for ${userId}`);

    await new Promise((resolve) => setTimeout(resolve, 75));

    return {
      theme: "dark",
      notifications: true,
      language: "en",
    };
  }

  private async fetchUserActivity(context) {
    const userId = context.get("userId");

    console.log(`Fetching activity for ${userId}`);

    await new Promise((resolve) => setTimeout(resolve, 25));

    return {
      lastLogin: Date.now() - 86400000,
      sessionsThisWeek: 5,
      totalSessions: 127,
    };
  }

  private async buildUserSummary(data: any, context) {
    const userId = context.get("userId");
    const startTime = context.get("startTime");
    const duration = Date.now() - startTime;

    console.log(`Building summary for ${userId} (took ${duration}ms)`);

    return {
      userId,
      summary: {
        name: data.profile.name,
        email: data.profile.email,
        totalOrders: data.orders.length,
        totalSpent: data.orders.reduce((sum, order) => sum + order.amount, 0),
        preferences: data.preferences,
        recentActivity: data.activity.lastLogin,
        engagement: data.activity.sessionsThisWeek > 3 ? "high" : "low",
      },
      metadata: {
        generatedAt: Date.now(),
        processingTime: duration,
      },
    };
  }
}

// Usage
const aggregator = new DataAggregator();
const userSummary = await aggregator.aggregateUserData("user123");
console.log("User summary:", userSummary);
```

### Resource Management with Cleanup

```typescript
class FileProcessor {
  async processFiles(filePaths: string[]) {
    return runEffect(async (context) => {
      context.set("operation", "file_processing");
      context.set("totalFiles", filePaths.length);

      const resources: any[] = [];
      context.set("resources", resources);

      try {
        // Process files with automatic resource cleanup
        const results = await Promise.all(filePaths.map((path) => this.processFile(path, context)));

        return {
          processed: results.length,
          results,
        };
      } finally {
        // Cleanup happens automatically when Effect completes
        await this.cleanupResources(context);
      }
    });
  }

  private async processFile(filePath: string, context) {
    const resources = context.get("resources");

    console.log(`Processing file: ${filePath}`);

    // Open file handle
    const fileHandle = await this.openFile(filePath);
    resources.push({ type: "file", handle: fileHandle, path: filePath });

    // Create temp directory
    const tempDir = await this.createTempDir();
    resources.push({ type: "tempDir", path: tempDir });

    // Process the file
    const data = await this.readFile(fileHandle);
    const processed = await this.transformData(data, context);
    const outputPath = await this.writeProcessedFile(processed, tempDir);

    return {
      inputPath: filePath,
      outputPath,
      size: data.length,
    };
  }

  private async cleanupResources(context) {
    const resources = context.get("resources") || [];

    console.log(`Cleaning up ${resources.length} resources`);

    // Cleanup in reverse order
    for (const resource of resources.reverse()) {
      try {
        switch (resource.type) {
          case "file":
            await resource.handle.close();
            console.log(`Closed file: ${resource.path}`);
            break;

          case "tempDir":
            await this.removeDirectory(resource.path);
            console.log(`Removed temp directory: ${resource.path}`);
            break;
        }
      } catch (error) {
        console.error(`Failed to cleanup ${resource.type}:`, error.message);
      }
    }
  }

  // Stub implementations
  private async openFile(path: string) {
    return { path, close: async () => {} };
  }

  private async createTempDir() {
    return `/tmp/process-${Date.now()}`;
  }

  private async readFile(handle: any) {
    return `file content from ${handle.path}`;
  }

  private async transformData(data: string, context) {
    const operation = context.get("operation");
    return `${data} - processed by ${operation}`;
  }

  private async writeProcessedFile(data: string, tempDir: string) {
    const outputPath = `${tempDir}/output.txt`;
    // Write file...
    return outputPath;
  }

  private async removeDirectory(path: string) {
    // Remove directory...
  }
}

// Usage
const processor = new FileProcessor();

try {
  const result = await processor.processFiles(["/path/to/file1.txt", "/path/to/file2.txt", "/path/to/file3.txt"]);

  console.log("Processing completed:", result);
  // All resources are automatically cleaned up
} catch (error) {
  console.error("Processing failed:", error.message);
  // Resources are still cleaned up even on failure
}
```

### HTTP Request Context

```typescript
class APIClient {
  async makeRequest(url: string, options: any = {}) {
    return runEffect(async (context) => {
      const requestId = generateId();
      const startTime = Date.now();

      context.set("requestId", requestId);
      context.set("url", url);
      context.set("startTime", startTime);
      context.set("retryCount", 0);

      return await this.executeRequest(context, options);
    });
  }

  private async executeRequest(context, options) {
    const requestId = context.get("requestId");
    const url = context.get("url");
    const retryCount = context.get("retryCount");

    console.log(`Request ${requestId}: ${url} (attempt ${retryCount + 1})`);

    try {
      // Add request headers with context
      const headers = {
        ...options.headers,
        "X-Request-ID": requestId,
        "X-Retry-Count": retryCount.toString(),
      };

      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      await this.logSuccess(context, response);
      return data;
    } catch (error) {
      return await this.handleError(context, error, options);
    }
  }

  private async handleError(context, error, options) {
    const requestId = context.get("requestId");
    const retryCount = context.get("retryCount");
    const maxRetries = options.maxRetries || 3;

    console.error(`Request ${requestId} failed:`, error.message);

    if (retryCount < maxRetries && this.isRetriableError(error)) {
      console.log(`Request ${requestId}: retrying (${retryCount + 1}/${maxRetries})`);

      context.set("retryCount", retryCount + 1);

      // Exponential backoff
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      return await this.executeRequest(context, options);
    }

    await this.logFailure(context, error);
    throw error;
  }

  private async logSuccess(context, response) {
    const requestId = context.get("requestId");
    const url = context.get("url");
    const startTime = context.get("startTime");
    const retryCount = context.get("retryCount");
    const duration = Date.now() - startTime;

    console.log(`Request ${requestId} succeeded`, {
      url,
      status: response.status,
      duration,
      retries: retryCount,
    });
  }

  private async logFailure(context, error) {
    const requestId = context.get("requestId");
    const url = context.get("url");
    const startTime = context.get("startTime");
    const retryCount = context.get("retryCount");
    const duration = Date.now() - startTime;

    console.error(`Request ${requestId} failed permanently`, {
      url,
      error: error.message,
      duration,
      retries: retryCount,
    });
  }

  private isRetriableError(error) {
    // Retry on network errors and 5xx responses
    return error.message.includes("fetch") || error.message.includes("HTTP 5");
  }
}

// Usage
const client = new APIClient();

const userData = await client.makeRequest("https://api.example.com/users/123", {
  method: "GET",
  maxRetries: 2,
});

console.log("User data:", userData);
```

## API Reference

### Running Effects

```typescript
// Run an Effect with automatic context management
const result = await runEffect(async (context) => {
  // Your async operation with context
  return someValue;
});
```

### Context Methods

```typescript
// Set a value in the context
context.set(key: string, value: any): void;

// Get a value from the context
context.get(key: string): any;

// Check if a key exists
context.has(key: string): boolean;

// Get all context keys
context.keys(): string[];
```

### Context Interface

```typescript
interface Context {
  set(key: string, value: any): void;
  get<T = any>(key: string): T;
  has(key: string): boolean;
  keys(): string[];
}
```

## Testing Patterns

### Testing Context Propagation

```typescript
describe("ContextPropagation", () => {
  it("should propagate context through operation chain", async () => {
    const result = await runEffect(async (context) => {
      context.set("userId", "test-user");

      return await operationThatUsesContext(context);
    });

    expect(result.userId).toBe("test-user");
  });
});
```

### Testing Resource Cleanup

```typescript
describe("ResourceCleanup", () => {
  it("should clean up resources on success", async () => {
    const resources: any[] = [];

    await runEffect(async (context) => {
      context.set("resources", resources);

      // Create resources
      resources.push("resource1");
      resources.push("resource2");

      return "success";
    });

    // Test that cleanup happened
    // (In real code, you'd verify resources were properly closed)
  });
});
```

### Testing Error Handling

```typescript
describe("ErrorHandling", () => {
  it("should handle errors with context", async () => {
    await expect(
      runEffect(async (context) => {
        context.set("operation", "test");

        throw new Error("Test error");
      }),
    ).rejects.toThrow("Test error");

    // Verify error was logged with proper context
  });
});
```

---

Effect provides structured concurrency and context propagation for reliable async programming. By ensuring that contexts flow through operation chains and resources are properly managed, it eliminates many common pitfalls in async JavaScript while providing the observability needed for debugging complex systems.

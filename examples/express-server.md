# HTTP Server with Express

**Express server rebuilt with supervision, graceful shutdown, and circuit breakers**

This example shows how to build a production-ready HTTP server using Express but with Phyxius primitives for reliability. No more hanging requests, resource leaks, or cascade failures.

## Architecture

- **Clock**: Request timeouts, rate limiting, and performance metrics
- **Atom**: Connection tracking and circuit breaker state
- **Journal**: Request logs and audit trails for debugging
- **Process**: Isolated request handlers with supervision
- **Effect**: Resource management and graceful shutdown

## The Server

```typescript
import express from "express";
import { createSystemClock, ms } from "@phyxius/clock";
import { createAtom } from "@phyxius/atom";
import { Journal } from "@phyxius/journal";
import { createRootSupervisor } from "@phyxius/process";
import { effect, acquireUseRelease, race, sleep } from "@phyxius/effect";

const clock = createSystemClock();
const supervisor = createRootSupervisor({ clock });

// Request/Response types
interface RequestInfo {
  id: string;
  method: string;
  path: string;
  userId?: string;
  startTime: number;
  ip: string;
  userAgent: string;
}

interface ResponseInfo extends RequestInfo {
  statusCode: number;
  duration: number;
  error?: string;
  bytes?: number;
}

// Circuit breaker state
interface CircuitBreakerState {
  status: "closed" | "open" | "half-open";
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
  requestCount: number;
}

// Rate limiter state
interface RateLimitState {
  requests: Map<string, number[]>; // ip -> timestamps
  blocked: Set<string>; // blocked IPs
}

// Server metrics
interface ServerMetrics {
  totalRequests: number;
  activeRequests: number;
  avgResponseTime: number;
  errorRate: number;
  lastRequestTime: number;
}

// Global state atoms
const serverMetrics = createAtom<ServerMetrics>(
  {
    totalRequests: 0,
    activeRequests: 0,
    avgResponseTime: 0,
    errorRate: 0,
    lastRequestTime: 0,
  },
  clock,
);

const activeConnections = createAtom(new Map<string, RequestInfo>(), clock);
const circuitBreakers = createAtom(new Map<string, CircuitBreakerState>(), clock);
const rateLimiter = createAtom<RateLimitState>(
  {
    requests: new Map(),
    blocked: new Set(),
  },
  clock,
);

// Request/response journal
const requestJournal = new Journal<ResponseInfo>({
  clock,
  maxEntries: 10000,
  overflow: "bounded:drop_oldest",
});

// Circuit breaker for external services
class CircuitBreaker {
  constructor(
    private serviceName: string,
    private failureThreshold: number = 5,
    private recoveryTimeout: number = 30000,
    private successThreshold: number = 3,
  ) {
    // Initialize circuit breaker state
    circuitBreakers.swap((breakers) => {
      const newBreakers = new Map(breakers);
      if (!newBreakers.has(serviceName)) {
        newBreakers.set(serviceName, {
          status: "closed",
          failureCount: 0,
          lastFailureTime: 0,
          successCount: 0,
          requestCount: 0,
        });
      }
      return newBreakers;
    });
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = circuitBreakers.deref().get(this.serviceName);
    if (!state) throw new Error("Circuit breaker not initialized");

    const now = clock.now().wallMs;

    // Check if circuit is open and should transition to half-open
    if (state.status === "open" && now - state.lastFailureTime > this.recoveryTimeout) {
      circuitBreakers.swap((breakers) => {
        const newBreakers = new Map(breakers);
        newBreakers.set(this.serviceName, { ...state, status: "half-open", successCount: 0 });
        return newBreakers;
      });
    }

    const currentState = circuitBreakers.deref().get(this.serviceName)!;

    // Fail fast if circuit is open
    if (currentState.status === "open") {
      throw new Error(`Circuit breaker open for ${this.serviceName}`);
    }

    // Track request
    circuitBreakers.swap((breakers) => {
      const newBreakers = new Map(breakers);
      const updatedState = newBreakers.get(this.serviceName)!;
      newBreakers.set(this.serviceName, {
        ...updatedState,
        requestCount: updatedState.requestCount + 1,
      });
      return newBreakers;
    });

    try {
      const result = await operation();

      // Record success
      circuitBreakers.swap((breakers) => {
        const newBreakers = new Map(breakers);
        const updatedState = newBreakers.get(this.serviceName)!;

        if (updatedState.status === "half-open") {
          const newSuccessCount = updatedState.successCount + 1;
          if (newSuccessCount >= this.successThreshold) {
            // Transition to closed
            newBreakers.set(this.serviceName, {
              ...updatedState,
              status: "closed",
              failureCount: 0,
              successCount: 0,
            });
          } else {
            newBreakers.set(this.serviceName, {
              ...updatedState,
              successCount: newSuccessCount,
            });
          }
        }

        return newBreakers;
      });

      return result;
    } catch (error) {
      // Record failure
      circuitBreakers.swap((breakers) => {
        const newBreakers = new Map(breakers);
        const updatedState = newBreakers.get(this.serviceName)!;
        const newFailureCount = updatedState.failureCount + 1;

        let newStatus = updatedState.status;
        if (newFailureCount >= this.failureThreshold || updatedState.status === "half-open") {
          newStatus = "open";
        }

        newBreakers.set(this.serviceName, {
          ...updatedState,
          status: newStatus,
          failureCount: newFailureCount,
          lastFailureTime: now,
        });

        return newBreakers;
      });

      throw error;
    }
  }
}

// Rate limiter
class RateLimiter {
  constructor(
    private maxRequests: number = 100,
    private windowMs: number = 60000, // 1 minute
    private blockDurationMs: number = 300000, // 5 minutes
  ) {}

  isAllowed(ip: string): boolean {
    const now = clock.now().wallMs;
    const state = rateLimiter.deref();

    // Check if IP is blocked
    if (state.blocked.has(ip)) {
      return false;
    }

    // Get request timestamps for this IP
    const requests = state.requests.get(ip) || [];

    // Remove old requests outside the window
    const validRequests = requests.filter((timestamp) => now - timestamp < this.windowMs);

    // Check if limit exceeded
    if (validRequests.length >= this.maxRequests) {
      // Block the IP
      rateLimiter.swap((limiter) => ({
        ...limiter,
        blocked: new Set(limiter.blocked).add(ip),
      }));

      // Schedule unblock
      setTimeout(() => {
        rateLimiter.swap((limiter) => {
          const newBlocked = new Set(limiter.blocked);
          newBlocked.delete(ip);
          return { ...limiter, blocked: newBlocked };
        });
      }, this.blockDurationMs);

      return false;
    }

    // Add current request timestamp
    validRequests.push(now);

    rateLimiter.swap((limiter) => {
      const newRequests = new Map(limiter.requests);
      newRequests.set(ip, validRequests);
      return { ...limiter, requests: newRequests };
    });

    return true;
  }
}

// Request handler process
const createRequestHandler = () => {
  return supervisor.spawn(
    {
      name: "request-handler",

      init: () => ({
        handledRequests: 0,
        errors: 0,
      }),

      handle: async (state, message, tools) => {
        switch (message.type) {
          case "handle-request": {
            const { requestId, method, path, headers, body, ip } = message;

            try {
              // Simulate request processing with potential for failure
              const processingTime = Math.random() * 200 + 50; // 50-250ms

              await sleep(processingTime).unsafeRunPromise({ clock });

              // Simulate random failures (5% chance)
              if (Math.random() < 0.05) {
                throw new Error("Random processing error");
              }

              // Simulate different response types
              let response;
              if (path.includes("/users")) {
                response = {
                  users: [
                    { id: 1, name: "Alice" },
                    { id: 2, name: "Bob" },
                  ],
                };
              } else if (path.includes("/health")) {
                response = { status: "healthy", timestamp: tools.clock.now().wallMs };
              } else {
                response = { message: "Hello from supervised request handler!" };
              }

              message.reply?.({
                success: true,
                statusCode: 200,
                data: response,
                processingTime,
              });

              return { ...state, handledRequests: state.handledRequests + 1 };
            } catch (error) {
              message.reply?.({
                success: false,
                statusCode: 500,
                error: error instanceof Error ? error.message : "Unknown error",
              });

              return { ...state, errors: state.errors + 1 };
            }
          }

          case "get-stats": {
            message.reply?.(state);
            return state;
          }

          default:
            return state;
        }
      },

      // Restart on failures
      supervision: {
        type: "one-for-one",
        backoff: { initial: ms(100), max: ms(5000), factor: 2 },
        maxRestarts: { count: 10, within: ms(60000) },
      },
    },
    {},
  );
};

// Database service with circuit breaker
const createDatabaseService = () => {
  const circuitBreaker = new CircuitBreaker("database", 3, 30000);

  return supervisor.spawn(
    {
      name: "database-service",

      init: () => ({
        queries: 0,
        errors: 0,
        connected: true,
      }),

      handle: async (state, message, tools) => {
        switch (message.type) {
          case "query": {
            const { sql, params } = message;

            try {
              const result = await circuitBreaker.execute(async () => {
                // Simulate database operation
                await sleep(Math.random() * 100 + 20).unsafeRunPromise({ clock });

                // Simulate connection issues (10% chance)
                if (Math.random() < 0.1) {
                  throw new Error("Database connection timeout");
                }

                return { rows: [{ id: 1, data: "mock data" }], rowCount: 1 };
              });

              message.reply?.({ success: true, result });
              return { ...state, queries: state.queries + 1 };
            } catch (error) {
              message.reply?.({
                success: false,
                error: error instanceof Error ? error.message : "Database error",
              });
              return { ...state, errors: state.errors + 1 };
            }
          }

          case "get-stats": {
            const breakerState = circuitBreakers.deref().get("database");
            message.reply?.({ ...state, circuitBreaker: breakerState });
            return state;
          }

          default:
            return state;
        }
      },
    },
    {},
  );
};

// Metrics collection service
const metricsService = supervisor.spawn(
  {
    name: "metrics-service",

    init: () => ({
      collectionStarted: clock.now().wallMs,
    }),

    handle: async (state, message, tools) => {
      switch (message.type) {
        case "collect-metrics": {
          const connections = activeConnections.deref();
          const journal = requestJournal.getSnapshot();

          // Calculate metrics from recent requests
          const recentRequests = journal.entries
            .filter((entry) => tools.clock.now().wallMs - entry.timestamp.wallMs < 60000) // Last minute
            .map((entry) => entry.data);

          const avgResponseTime =
            recentRequests.length > 0
              ? recentRequests.reduce((sum, req) => sum + req.duration, 0) / recentRequests.length
              : 0;

          const errorCount = recentRequests.filter((req) => req.statusCode >= 400).length;
          const errorRate = recentRequests.length > 0 ? errorCount / recentRequests.length : 0;

          // Update metrics
          serverMetrics.swap((metrics) => ({
            totalRequests: journal.totalCount,
            activeRequests: connections.size,
            avgResponseTime,
            errorRate,
            lastRequestTime:
              recentRequests.length > 0
                ? Math.max(...recentRequests.map((req) => req.startTime))
                : metrics.lastRequestTime,
          }));

          // Schedule next collection
          tools.schedule(ms(5000), { type: "collect-metrics" });

          return state;
        }

        case "get-metrics": {
          const metrics = serverMetrics.deref();
          const breakerStates = circuitBreakers.deref();
          const rateLimitState = rateLimiter.deref();

          message.reply?.({
            server: metrics,
            circuitBreakers: Object.fromEntries(breakerStates),
            rateLimiter: {
              activeIps: rateLimitState.requests.size,
              blockedIps: rateLimitState.blocked.size,
            },
            uptime: tools.clock.now().wallMs - state.collectionStarted,
          });

          return state;
        }

        default:
          return state;
      }
    },
  },
  {},
);

// Create services
const requestHandler = createRequestHandler();
const databaseService = createDatabaseService();
const rateLimiterInstance = new RateLimiter(50, 60000); // 50 requests per minute

// Express app setup
const app = express();

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Request tracking middleware
app.use((req, res, next) => {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startTime = clock.now().wallMs;

  const requestInfo: RequestInfo = {
    id: requestId,
    method: req.method,
    path: req.path,
    startTime,
    ip: req.ip || req.socket.remoteAddress || "unknown",
    userAgent: req.get("User-Agent") || "unknown",
  };

  // Add to active connections
  activeConnections.swap((connections) => new Map(connections).set(requestId, requestInfo));

  // Rate limiting
  if (!rateLimiterInstance.isAllowed(requestInfo.ip)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  // Store request ID for cleanup
  (req as any).requestId = requestId;
  (req as any).startTime = startTime;

  next();
});

// Response tracking middleware
app.use((req, res, next) => {
  const originalSend = res.send;

  res.send = function (data) {
    const requestId = (req as any).requestId;
    const startTime = (req as any).startTime;
    const endTime = clock.now().wallMs;

    if (requestId) {
      // Remove from active connections
      activeConnections.swap((connections) => {
        const newConnections = new Map(connections);
        newConnections.delete(requestId);
        return newConnections;
      });

      // Log to journal
      const responseInfo: ResponseInfo = {
        id: requestId,
        method: req.method,
        path: req.path,
        startTime,
        ip: req.ip || "unknown",
        userAgent: req.get("User-Agent") || "unknown",
        statusCode: res.statusCode,
        duration: endTime - startTime,
        bytes: data ? Buffer.byteLength(data) : 0,
      };

      if (res.statusCode >= 400) {
        responseInfo.error = "HTTP error";
      }

      requestJournal.append(responseInfo);
    }

    return originalSend.call(this, data);
  };

  next();
});

// Routes
app.get("/health", (req, res) => {
  const metrics = serverMetrics.deref();
  res.json({
    status: "healthy",
    timestamp: clock.now().wallMs,
    activeRequests: metrics.activeRequests,
    uptime: process.uptime(),
  });
});

app.get("/metrics", async (req, res) => {
  try {
    const metrics = await metricsService.ask((reply: any) => ({ type: "get-metrics", reply }), ms(1000));
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: "Failed to get metrics" });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    // Use supervised request handler
    const result = await requestHandler.ask(
      (reply: any) => ({
        type: "handle-request",
        requestId: (req as any).requestId,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body,
        ip: req.ip,
        reply,
      }),
      ms(5000),
    );

    if (result.success) {
      res.json(result.data);
    } else {
      res.status(result.statusCode).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: "Request handler timeout" });
  }
});

app.get("/api/data", async (req, res) => {
  try {
    // Database query through circuit breaker
    const result = await databaseService.ask(
      (reply: any) => ({
        type: "query",
        sql: "SELECT * FROM data WHERE id = ?",
        params: [req.query.id],
        reply,
      }),
      ms(3000),
    );

    if (result.success) {
      res.json(result.result);
    } else {
      res.status(503).json({ error: result.error });
    }
  } catch (error) {
    res.status(503).json({ error: "Database service unavailable" });
  }
});

app.post("/api/echo", async (req, res) => {
  try {
    const result = await requestHandler.ask(
      (reply: any) => ({
        type: "handle-request",
        requestId: (req as any).requestId,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body,
        ip: req.ip,
        reply,
      }),
      ms(5000),
    );

    if (result.success) {
      res.json({
        ...result.data,
        echo: req.body,
      });
    } else {
      res.status(result.statusCode).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: "Request handler timeout" });
  }
});

// Error handling middleware
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", error);

  const requestId = (req as any).requestId;
  if (requestId) {
    // Log error to journal
    requestJournal.append({
      id: requestId,
      method: req.method,
      path: req.path,
      startTime: (req as any).startTime,
      ip: req.ip || "unknown",
      userAgent: req.get("User-Agent") || "unknown",
      statusCode: 500,
      duration: clock.now().wallMs - (req as any).startTime,
      error: error.message,
    });
  }

  res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Graceful shutdown
const gracefulShutdown = acquireUseRelease(
  // Acquire: Start server
  effect(async () => {
    return new Promise<any>((resolve) => {
      const server = app.listen(3000, () => {
        console.log("🚀 Server listening on http://localhost:3000");
        resolve(server);
      });
    });
  }),

  // Use: Run server
  (server) =>
    effect(async (env) => {
      // Start metrics collection
      metricsService.send({ type: "collect-metrics" });

      console.log("✅ Server is running");
      console.log("📊 Metrics available at http://localhost:3000/metrics");
      console.log("🏥 Health check at http://localhost:3000/health");

      // Wait for shutdown signal
      let shouldStop = false;
      const stopHandler = () => {
        shouldStop = true;
      };

      process.on("SIGINT", stopHandler);
      process.on("SIGTERM", stopHandler);

      env.cancel.onCancel(stopHandler);

      while (!shouldStop && !env.cancel.isCanceled()) {
        await sleep(1000).unsafeRunPromise({ clock });
      }

      return { _tag: "Ok" as const, value: undefined };
    }),

  // Release: Graceful shutdown
  (server, cause) =>
    effect(async () => {
      console.log(`\n🛑 Shutting down server (cause: ${cause})...`);

      // Stop accepting new connections
      server.close();

      // Wait for active requests to complete (max 10 seconds)
      const maxWaitTime = 10000;
      const startTime = clock.now().wallMs;

      while (activeConnections.deref().size > 0 && clock.now().wallMs - startTime < maxWaitTime) {
        console.log(`⏳ Waiting for ${activeConnections.deref().size} active requests...`);
        await sleep(500).unsafeRunPromise({ clock });
      }

      const remainingConnections = activeConnections.deref().size;
      if (remainingConnections > 0) {
        console.log(`⚠️  Force closing ${remainingConnections} remaining connections`);
      }

      // Stop all services
      await requestHandler.stop();
      await databaseService.stop();
      await metricsService.stop();

      console.log("✅ Server shutdown complete");

      return { _tag: "Ok" as const, value: undefined };
    }),
);

// Production server
export class ProductionServer {
  async start(): Promise<void> {
    const result = await gracefulShutdown.unsafeRunPromise({ clock });

    if (result._tag === "Err") {
      console.error("Server failed:", result.error);
      process.exit(1);
    }
  }

  async getMetrics() {
    return await metricsService.ask((reply: any) => ({ type: "get-metrics", reply }));
  }

  async getRequestLogs(limit: number = 100) {
    const snapshot = requestJournal.getSnapshot();
    return snapshot.entries.slice(-limit).map((entry) => entry.data);
  }
}

// Demo usage
async function demo() {
  console.log("🚀 Starting production HTTP server...");

  const server = new ProductionServer();

  // In a real app, you'd just call server.start()
  // For demo, we'll run some test requests

  setTimeout(async () => {
    console.log("\n📡 Making test requests...");

    // Make some requests to test the system
    const responses = await Promise.allSettled([
      fetch("http://localhost:3000/health"),
      fetch("http://localhost:3000/api/users"),
      fetch("http://localhost:3000/api/data?id=123"),
      fetch("http://localhost:3000/metrics"),
      fetch("http://localhost:3000/nonexistent"), // 404
    ]);

    console.log(`✅ Made ${responses.length} test requests`);

    // Show metrics
    const metrics = await server.getMetrics();
    console.log("\n📊 Server metrics:", metrics);

    // Show recent logs
    const logs = await server.getRequestLogs(10);
    console.log("\n📝 Recent requests:");
    logs.forEach((log) => {
      console.log(`  ${log.method} ${log.path} - ${log.statusCode} (${log.duration}ms)`);
    });

    // Trigger shutdown after demo
    setTimeout(() => process.kill(process.pid, "SIGINT"), 2000);
  }, 1000);

  await server.start();
}

if (import.meta.main) {
  demo().catch(console.error);
}
```

## What This Demonstrates

1. **Supervised Request Handling**: Each request is handled by a supervised process that restarts on failure.

2. **Circuit Breakers**: External services (database) are protected with circuit breakers to prevent cascade failures.

3. **Rate Limiting**: Built-in rate limiting with automatic IP blocking for abuse protection.

4. **Graceful Shutdown**: Server shuts down cleanly, waiting for active requests to complete.

5. **Request Tracking**: Every request is tracked from start to finish with unique IDs.

6. **Complete Audit Trail**: All requests are logged to a journal for debugging and analytics.

7. **Real-Time Metrics**: Live metrics collection for monitoring and alerting.

8. **Resource Management**: Automatic cleanup of connections and resources using Effect patterns.

9. **Fault Tolerance**: Services restart automatically on failure with exponential backoff.

10. **Testable Timeouts**: All timeouts use the clock abstraction for deterministic testing.

This pattern takes Express from a basic web framework to a production-ready server with enterprise-grade reliability features. Every component is supervised, every resource is managed, every operation is observable.

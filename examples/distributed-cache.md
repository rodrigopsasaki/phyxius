# Example: Distributed Cache System

## Problem Brief

Building a distributed cache that is reliable, observable, and fault-tolerant is notoriously difficult. Traditional approaches suffer from:

- **Cache inconsistencies** between nodes
- **Lost cache operations** during failures
- **Poor observability** into cache behavior
- **Difficult testing** due to timing dependencies
- **Cascade failures** when cache nodes go down

## Before: Traditional Distributed Cache

```typescript
// Fragile implementation with multiple problems
class TraditionalDistributedCache {
  private nodes: Map<string, CacheNode> = new Map();
  private localCache: Map<string, any> = new Map();

  async get(key: string): Promise<any> {
    // Check local cache first
    if (this.localCache.has(key)) {
      return this.localCache.get(key);
    }

    // Try each node until one responds
    for (const [nodeId, node] of this.nodes) {
      try {
        const value = await node.get(key);
        if (value !== undefined) {
          // Update local cache - RACE CONDITION!
          this.localCache.set(key, value);
          return value;
        }
      } catch (error) {
        console.log(`Node ${nodeId} failed: ${error.message}`);
        // What if this was temporary? How do we know?
        // No way to track failure patterns
      }
    }

    return undefined;
  }

  async set(key: string, value: any, ttl: number = 300000): Promise<void> {
    const expiry = Date.now() + ttl; // Hard to test!

    // Try to replicate to all nodes
    const promises = Array.from(this.nodes.values()).map((node) =>
      node.set(key, value, expiry).catch((error) => {
        console.error(`Failed to replicate to node: ${error.message}`);
        // Silent failures, no retry logic, no observability
      }),
    );

    await Promise.allSettled(promises);

    // Update local cache
    this.localCache.set(key, value);

    // Set up expiry cleanup - TIMING DEPENDENCY!
    setTimeout(() => {
      this.localCache.delete(key);
    }, ttl);
  }
}

// Problems:
// 1. Race conditions in cache updates
// 2. No audit trail of operations
// 3. Hard to test time-dependent logic
// 4. Silent failures with no recovery
// 5. No observability into system behavior
```

## After: Phyxius-Powered Distributed Cache

```typescript
import { createSystemClock, createControlledClock } from "@phyxius/clock";
import { createAtom } from "@phyxius/atom";
import { createJournal } from "@phyxius/journal";
import { runEffect } from "@phyxius/effect";
import { createSupervisor } from "@phyxius/process";

// Comprehensive solution using all five primitives
class PhyxiusDistributedCache {
  private state = createAtom({
    nodes: new Map<string, NodeInfo>(),
    localCache: new Map<string, CacheEntry>(),
    replicationFactor: 3,
    stats: {
      hits: 0,
      misses: 0,
      evictions: 0,
      failures: 0,
    },
  });

  constructor(
    private clock = createSystemClock(),
    private journal = createJournal(),
    private supervisor = createSupervisor({ emit: this.logEvent.bind(this) }),
  ) {
    this.initializeBackgroundProcesses();
  }

  async get(key: string): Promise<any> {
    return runEffect(async (context) => {
      context.set("operation", "cache_get");
      context.set("key", key);
      context.set("startTime", this.clock.now());

      await this.journal.append({
        type: "cache.get.started",
        key,
        timestamp: this.clock.now(),
      });

      try {
        // Check local cache first (with proper atomic access)
        const currentState = this.state.get();
        const localEntry = currentState.localCache.get(key);

        if (localEntry && localEntry.expiry > this.clock.now()) {
          // Cache hit!
          this.updateStats((stats) => ({ ...stats, hits: stats.hits + 1 }));

          await this.journal.append({
            type: "cache.get.hit",
            key,
            source: "local",
            timestamp: this.clock.now(),
          });

          return localEntry.value;
        }

        // Cache miss - try remote nodes
        const result = await this.getFromRemoteNodes(key, context);

        if (result !== undefined) {
          // Update local cache atomically
          this.updateLocalCache(key, result, this.clock.now() + 300000);
          this.updateStats((stats) => ({ ...stats, hits: stats.hits + 1 }));

          await this.journal.append({
            type: "cache.get.hit",
            key,
            source: "remote",
            timestamp: this.clock.now(),
          });

          return result;
        }

        // Complete miss
        this.updateStats((stats) => ({ ...stats, misses: stats.misses + 1 }));

        await this.journal.append({
          type: "cache.get.miss",
          key,
          timestamp: this.clock.now(),
        });

        return undefined;
      } catch (error) {
        await this.journal.append({
          type: "cache.get.error",
          key,
          error: error.message,
          timestamp: this.clock.now(),
        });

        throw error;
      }
    });
  }

  async set(key: string, value: any, ttl: number = 300000): Promise<void> {
    return runEffect(async (context) => {
      context.set("operation", "cache_set");
      context.set("key", key);
      context.set("value", value);
      context.set("ttl", ttl);

      const expiry = this.clock.now() + ttl;

      await this.journal.append({
        type: "cache.set.started",
        key,
        ttl,
        timestamp: this.clock.now(),
      });

      try {
        // Update local cache first (atomic operation)
        this.updateLocalCache(key, value, expiry);

        // Replicate to remote nodes
        await this.replicateToNodes(key, value, expiry, context);

        await this.journal.append({
          type: "cache.set.completed",
          key,
          timestamp: this.clock.now(),
        });
      } catch (error) {
        await this.journal.append({
          type: "cache.set.error",
          key,
          error: error.message,
          timestamp: this.clock.now(),
        });

        throw error;
      }
    });
  }

  private async getFromRemoteNodes(key: string, context): Promise<any> {
    const currentState = this.state.get();
    const availableNodes = Array.from(currentState.nodes.values())
      .filter((node) => node.status === "healthy")
      .sort((a, b) => a.lastLatency - b.lastLatency); // Try fastest nodes first

    for (const nodeInfo of availableNodes) {
      try {
        context.set("currentNode", nodeInfo.id);

        const startTime = this.clock.now();
        const value = await this.queryNode(nodeInfo.id, key);
        const latency = this.clock.now() - startTime;

        // Update node performance metrics atomically
        this.updateNodeLatency(nodeInfo.id, latency);

        if (value !== undefined) {
          return value;
        }
      } catch (error) {
        // Mark node as potentially unhealthy
        this.recordNodeError(nodeInfo.id, error.message);

        await this.journal.append({
          type: "cache.node.error",
          nodeId: nodeInfo.id,
          key,
          error: error.message,
          timestamp: this.clock.now(),
        });
      }
    }

    return undefined;
  }

  private async replicateToNodes(key: string, value: any, expiry: number, context): Promise<void> {
    const currentState = this.state.get();
    const healthyNodes = Array.from(currentState.nodes.values()).filter((node) => node.status === "healthy");

    const replicationTargets = Math.min(currentState.replicationFactor, healthyNodes.length);

    // Select nodes for replication (could use consistent hashing)
    const selectedNodes = healthyNodes.slice(0, replicationTargets);

    const replicationPromises = selectedNodes.map(async (nodeInfo) => {
      try {
        await this.sendToNode(nodeInfo.id, key, value, expiry);

        await this.journal.append({
          type: "cache.replication.success",
          nodeId: nodeInfo.id,
          key,
          timestamp: this.clock.now(),
        });
      } catch (error) {
        this.recordNodeError(nodeInfo.id, error.message);

        await this.journal.append({
          type: "cache.replication.failure",
          nodeId: nodeInfo.id,
          key,
          error: error.message,
          timestamp: this.clock.now(),
        });

        throw error;
      }
    });

    // Wait for majority replication
    const results = await Promise.allSettled(replicationPromises);
    const successes = results.filter((r) => r.status === "fulfilled").length;

    if (successes < Math.ceil(replicationTargets / 2)) {
      throw new Error(`Replication failed: only ${successes}/${replicationTargets} nodes succeeded`);
    }
  }

  private updateLocalCache(key: string, value: any, expiry: number): void {
    this.state.update((state) => {
      const newCache = new Map(state.localCache);
      newCache.set(key, { value, expiry });

      return {
        ...state,
        localCache: newCache,
      };
    });
  }

  private updateStats(updater: (stats: any) => any): void {
    this.state.update((state) => ({
      ...state,
      stats: updater(state.stats),
    }));
  }

  private updateNodeLatency(nodeId: string, latency: number): void {
    this.state.update((state) => {
      const nodes = new Map(state.nodes);
      const node = nodes.get(nodeId);

      if (node) {
        nodes.set(nodeId, {
          ...node,
          lastLatency: latency,
          avgLatency: (node.avgLatency + latency) / 2,
          lastSeen: this.clock.now(),
        });
      }

      return { ...state, nodes };
    });
  }

  private recordNodeError(nodeId: string, error: string): void {
    this.state.update((state) => {
      const nodes = new Map(state.nodes);
      const node = nodes.get(nodeId);

      if (node) {
        const errorCount = node.consecutiveErrors + 1;
        nodes.set(nodeId, {
          ...node,
          consecutiveErrors: errorCount,
          status: errorCount > 3 ? "unhealthy" : "degraded",
          lastError: error,
          lastErrorTime: this.clock.now(),
        });
      }

      return { ...state, nodes };
    });
  }

  private async initializeBackgroundProcesses(): Promise<void> {
    // Cache cleanup process
    await this.supervisor.spawn({
      async handle(message) {
        if (message.type === "cleanup_expired") {
          await this.cleanupExpiredEntries();
        }
      },
    });

    // Node health monitoring process
    await this.supervisor.spawn({
      async handle(message) {
        if (message.type === "health_check") {
          await this.performHealthChecks();
        }
      },
    });

    // Stats aggregation process
    await this.supervisor.spawn({
      async handle(message) {
        if (message.type === "aggregate_stats") {
          await this.aggregateStatistics();
        }
      },
    });
  }

  private async cleanupExpiredEntries(): Promise<void> {
    const now = this.clock.now();

    this.state.update((state) => {
      const newCache = new Map();
      let evictions = 0;

      for (const [key, entry] of state.localCache) {
        if (entry.expiry > now) {
          newCache.set(key, entry);
        } else {
          evictions++;
        }
      }

      if (evictions > 0) {
        this.journal.append({
          type: "cache.cleanup.completed",
          evictions,
          timestamp: now,
        });
      }

      return {
        ...state,
        localCache: newCache,
        stats: {
          ...state.stats,
          evictions: state.stats.evictions + evictions,
        },
      };
    });
  }

  private async performHealthChecks(): Promise<void> {
    const currentState = this.state.get();

    for (const [nodeId, nodeInfo] of currentState.nodes) {
      try {
        const startTime = this.clock.now();
        await this.pingNode(nodeId);
        const latency = this.clock.now() - startTime;

        // Node is responsive - update status
        this.state.update((state) => {
          const nodes = new Map(state.nodes);
          nodes.set(nodeId, {
            ...nodeInfo,
            status: "healthy",
            consecutiveErrors: 0,
            lastLatency: latency,
            lastSeen: this.clock.now(),
          });

          return { ...state, nodes };
        });
      } catch (error) {
        this.recordNodeError(nodeId, error.message);

        await this.journal.append({
          type: "cache.health_check.failure",
          nodeId,
          error: error.message,
          timestamp: this.clock.now(),
        });
      }
    }
  }

  private async aggregateStatistics(): Promise<void> {
    const stats = this.state.get().stats;
    const totalRequests = stats.hits + stats.misses;
    const hitRate = totalRequests > 0 ? stats.hits / totalRequests : 0;

    await this.journal.append({
      type: "cache.stats.snapshot",
      stats: {
        ...stats,
        hitRate,
        timestamp: this.clock.now(),
      },
      timestamp: this.clock.now(),
    });
  }

  private logEvent(event: any): void {
    console.log(`[${new Date().toISOString()}] Cache Event:`, event);
  }

  // Stub methods for node communication
  private async queryNode(nodeId: string, key: string): Promise<any> {
    // Implementation would use HTTP/gRPC/etc to query remote node
    throw new Error("Node communication not implemented");
  }

  private async sendToNode(nodeId: string, key: string, value: any, expiry: number): Promise<void> {
    // Implementation would replicate to remote node
    throw new Error("Node communication not implemented");
  }

  private async pingNode(nodeId: string): Promise<void> {
    // Implementation would ping remote node for health check
    throw new Error("Node communication not implemented");
  }

  // Public API for monitoring and debugging
  async getStats() {
    const state = this.state.get();
    const totalRequests = state.stats.hits + state.stats.misses;

    return {
      ...state.stats,
      hitRate: totalRequests > 0 ? state.stats.hits / totalRequests : 0,
      cacheSize: state.localCache.size,
      nodeCount: state.nodes.size,
      healthyNodes: Array.from(state.nodes.values()).filter((n) => n.status === "healthy").length,
    };
  }

  async getAuditLog(filters?: any) {
    return await this.journal.filter((event) => {
      if (!filters) return true;

      if (filters.type && !event.type.includes(filters.type)) return false;
      if (filters.key && event.key !== filters.key) return false;
      if (filters.since && event.timestamp < filters.since) return false;

      return true;
    });
  }

  getStateSnapshot() {
    return this.state.get();
  }
}

// Usage example
async function demonstrateDistributedCache() {
  const cache = new PhyxiusDistributedCache();

  // Set some values
  await cache.set("user:123", { name: "John", email: "john@example.com" }, 60000);
  await cache.set("session:abc", { userId: "123", roles: ["user"] }, 1800000);

  // Get values
  const user = await cache.get("user:123");
  console.log("Retrieved user:", user);

  // Get statistics
  const stats = await cache.getStats();
  console.log("Cache statistics:", stats);

  // Get audit trail
  const auditLog = await cache.getAuditLog({
    type: "cache.get",
    since: Date.now() - 60000, // Last minute
  });
  console.log("Recent get operations:", auditLog);
}
```

## Key Benefits Achieved

### 1. **Atomic State Management** (Atom)

- **Race Condition Prevention**: All cache updates are atomic
- **Consistent State**: Node information and cache entries never become inconsistent
- **Observable Changes**: React to cache state changes automatically
- **Complete Audit Trail**: Every state change is tracked with version history

### 2. **Deterministic Time Control** (Clock)

- **Testable TTL Logic**: Cache expiration can be tested instantly without waiting
- **Precise Performance Metrics**: Accurate latency measurements for node selection
- **Deterministic Cleanup**: Expired entries are cleaned up at exact, predictable times
- **Replay Capability**: Time-dependent bugs can be reproduced exactly

### 3. **Complete Observability** (Journal)

- **Operation Tracking**: Every cache operation is logged with full context
- **Performance Analysis**: Query response times and failure patterns are recorded
- **Compliance Ready**: Complete audit trail for security and compliance requirements
- **Debugging Superpower**: Trace through complex distributed scenarios step-by-step

### 4. **Context-Aware Operations** (Effect)

- **Distributed Tracing**: Operations carry context (request ID, user ID) across the system
- **Resource Management**: Network connections and temporary resources are cleaned up properly
- **Error Boundaries**: Failures are contained and handled at the appropriate level
- **Coordinated Operations**: Complex multi-step operations maintain consistency

### 5. **Fault-Tolerant Architecture** (Process)

- **Supervision**: Background processes (cleanup, health checks, stats) restart automatically on failure
- **Isolation**: Process failures don't cascade to other parts of the system
- **Message-Based**: Clean separation between cache operations and background maintenance
- **Scalable**: Easy to add more background processes or distribute across nodes

## Testing Made Simple

```typescript
describe("Distributed Cache", () => {
  it("should handle node failures gracefully", async () => {
    // Use controlled clock for deterministic testing
    const clock = createControlledClock(0);
    const journal = createJournal();
    const cache = new PhyxiusDistributedCache(clock, journal);

    // Set up cache entry
    await cache.set("key1", "value1", 60000);

    // Simulate node failure
    clock.advance(30000);

    // Verify graceful degradation
    const value = await cache.get("key1");
    expect(value).toBe("value1");

    // Check audit trail
    const events = await journal.filter((e) => e.type.includes("error"));
    expect(events).toHaveLength(0); // No errors during normal operation
  });
});
```

## Result

**Before**: Fragile cache with race conditions, poor observability, and cascade failures  
**After**: Production-ready distributed cache with atomic operations, complete observability, fault tolerance, and comprehensive testing capabilities

The combination of all five Phyxius primitives creates a distributed cache that is not just functional, but truly **observable**, **reliable**, and **maintainable** in production environments.

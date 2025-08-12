# Distributed Cache

**Fault-tolerant caching with gossip protocol and automatic failover**

This example shows how to build a distributed cache that automatically handles node failures, data replication, and consistent hashing. When nodes go down, the system routes around the damage and heals itself.

## Architecture

- **Clock**: Coordinated timing for TTL, heartbeats, and failure detection
- **Atom**: Atomic state for cache data and node membership
- **Journal**: Event log for membership changes and debugging
- **Process**: One process per cache node with supervision
- **Effect**: Resource management for network connections and cleanup

## The System

```typescript
import { createSystemClock, ms } from "@phyxius/clock";
import { createAtom } from "@phyxius/atom";
import { Journal } from "@phyxius/journal";
import { createRootSupervisor } from "@phyxius/process";
import { effect, race, sleep } from "@phyxius/effect";

const clock = createSystemClock();
const supervisor = createRootSupervisor({ clock });

// Cache entry with metadata
interface CacheEntry {
  key: string;
  value: any;
  ttl: number; // timestamp when entry expires
  version: number; // for conflict resolution
  nodeId: string; // which node owns this entry
  replicas: Set<string>; // which nodes have replicas
}

// Node membership and health
interface NodeInfo {
  nodeId: string;
  address: string;
  port: number;
  zone: string; // availability zone for replica placement
  lastHeartbeat: number;
  status: "joining" | "active" | "leaving" | "failed";
  load: number; // 0-1, for load balancing
}

// Membership events for debugging and monitoring
type MembershipEvent =
  | { type: "node.joined"; nodeId: string; address: string; zone: string }
  | { type: "node.left"; nodeId: string; reason: "graceful" | "failed" }
  | { type: "node.failed"; nodeId: string; detectedBy: string }
  | { type: "replica.created"; key: string; fromNode: string; toNode: string }
  | { type: "replica.deleted"; key: string; fromNode: string }
  | { type: "cache.miss"; key: string; requestedFrom: string }
  | { type: "cache.hit"; key: string; servedBy: string }
  | { type: "gossip.sent"; fromNode: string; toNode: string; entries: number }
  | { type: "gossip.received"; fromNode: string; toNode: string; entries: number };

// Global membership state
const clusterMembership = createAtom(new Map<string, NodeInfo>(), clock);
const membershipEvents = new Journal<MembershipEvent>({ clock });

// Consistent hashing for key distribution
class ConsistentHash {
  private ring = new Map<number, string>(); // hash -> nodeId
  private virtualNodes = 150; // virtual nodes per physical node

  constructor(private nodes: string[] = []) {
    this.rebuild();
  }

  addNode(nodeId: string): void {
    this.nodes.push(nodeId);
    this.rebuild();
  }

  removeNode(nodeId: string): void {
    this.nodes = this.nodes.filter((id) => id !== nodeId);
    this.rebuild();
  }

  private rebuild(): void {
    this.ring.clear();

    for (const nodeId of this.nodes) {
      for (let i = 0; i < this.virtualNodes; i++) {
        const hash = this.hash(`${nodeId}:${i}`);
        this.ring.set(hash, nodeId);
      }
    }
  }

  getNode(key: string): string | null {
    if (this.ring.size === 0) return null;

    const keyHash = this.hash(key);
    const sortedHashes = Array.from(this.ring.keys()).sort((a, b) => a - b);

    // Find first hash >= keyHash, or wrap around to first
    let targetHash = sortedHashes.find((hash) => hash >= keyHash);
    if (!targetHash) {
      targetHash = sortedHashes[0];
    }

    return this.ring.get(targetHash) || null;
  }

  getReplicaNodes(key: string, count: number): string[] {
    if (this.ring.size === 0) return [];

    const keyHash = this.hash(key);
    const sortedHashes = Array.from(this.ring.keys()).sort((a, b) => a - b);
    const nodes = new Set<string>();

    let startIndex = sortedHashes.findIndex((hash) => hash >= keyHash);
    if (startIndex === -1) startIndex = 0;

    // Walk the ring to find unique nodes
    for (let i = 0; i < sortedHashes.length && nodes.size < count; i++) {
      const index = (startIndex + i) % sortedHashes.length;
      const hash = sortedHashes[index];
      const nodeId = this.ring.get(hash);
      if (nodeId) nodes.add(nodeId);
    }

    return Array.from(nodes);
  }

  private hash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }
}

// Cache node process
const createCacheNode = (nodeId: string, address: string, port: number, zone: string) => {
  return supervisor.spawn(
    {
      name: `cache-node-${nodeId}`,

      init: () => ({
        nodeId,
        address,
        port,
        zone,
        data: new Map<string, CacheEntry>(),
        consistentHash: new ConsistentHash(),
        gossipPeers: new Set<string>(),
        lastGossip: 0,
        version: 0,
      }),

      handle: async (state, message, tools) => {
        switch (message.type) {
          case "join-cluster": {
            // Announce ourselves to the cluster
            membershipEvents.append({
              type: "node.joined",
              nodeId: state.nodeId,
              address: state.address,
              zone: state.zone,
            });

            // Update cluster membership
            clusterMembership.swap((membership) => {
              const newMembership = new Map(membership);
              newMembership.set(state.nodeId, {
                nodeId: state.nodeId,
                address: state.address,
                port: state.port,
                zone: state.zone,
                lastHeartbeat: tools.clock.now().wallMs,
                status: "active",
                load: 0,
              });
              return newMembership;
            });

            // Update local consistent hash
            const membership = clusterMembership.deref();
            const activeNodes = Array.from(membership.keys());
            state.consistentHash = new ConsistentHash(activeNodes);

            // Start heartbeat
            tools.schedule(ms(5000), { type: "heartbeat" });

            // Start gossip
            tools.schedule(ms(1000), { type: "gossip" });

            message.reply?.({ success: true });
            return state;
          }

          case "heartbeat": {
            // Update our heartbeat timestamp
            clusterMembership.swap((membership) => {
              const newMembership = new Map(membership);
              const nodeInfo = newMembership.get(state.nodeId);
              if (nodeInfo) {
                newMembership.set(state.nodeId, {
                  ...nodeInfo,
                  lastHeartbeat: tools.clock.now().wallMs,
                  load: state.data.size / 1000, // Simple load metric
                });
              }
              return newMembership;
            });

            // Check for failed nodes
            const now = tools.clock.now().wallMs;
            const membership = clusterMembership.deref();
            const failureThreshold = 15000; // 15 seconds

            for (const [nodeId, nodeInfo] of membership) {
              if (
                nodeId !== state.nodeId &&
                nodeInfo.status === "active" &&
                now - nodeInfo.lastHeartbeat > failureThreshold
              ) {
                // Mark node as failed
                membershipEvents.append({
                  type: "node.failed",
                  nodeId,
                  detectedBy: state.nodeId,
                });

                clusterMembership.swap((m) => {
                  const newM = new Map(m);
                  const failedNode = newM.get(nodeId);
                  if (failedNode) {
                    newM.set(nodeId, { ...failedNode, status: "failed" });
                  }
                  return newM;
                });

                // Update consistent hash
                const activeNodes = Array.from(membership.keys()).filter((id) => {
                  const node = membership.get(id);
                  return node && node.status === "active" && id !== nodeId;
                });
                state.consistentHash = new ConsistentHash(activeNodes);

                // Take over failed node's data
                const failedNodeData = Array.from(state.data.values()).filter((entry) => entry.nodeId === nodeId);

                for (const entry of failedNodeData) {
                  // Re-assign ownership to appropriate node
                  const newOwner = state.consistentHash.getNode(entry.key);
                  if (newOwner === state.nodeId) {
                    state.data.set(entry.key, {
                      ...entry,
                      nodeId: state.nodeId,
                      version: entry.version + 1,
                    });
                  }
                }
              }
            }

            // Schedule next heartbeat
            tools.schedule(ms(5000), { type: "heartbeat" });
            return state;
          }

          case "set": {
            const { key, value, ttl = 3600000 } = message; // Default 1 hour TTL

            // Determine if we should own this key
            const owner = state.consistentHash.getNode(key);
            const now = tools.clock.now().wallMs;

            const entry: CacheEntry = {
              key,
              value,
              ttl: now + ttl,
              version: state.version++,
              nodeId: state.nodeId,
              replicas: new Set(),
            };

            state.data.set(key, entry);

            // Create replicas on other nodes
            const replicaNodes = state.consistentHash
              .getReplicaNodes(key, 3)
              .filter((nodeId) => nodeId !== state.nodeId)
              .slice(0, 2); // 2 replicas

            for (const replicaNodeId of replicaNodes) {
              // Send replica to other node (in real implementation, this would be network call)
              membershipEvents.append({
                type: "replica.created",
                key,
                fromNode: state.nodeId,
                toNode: replicaNodeId,
              });
              entry.replicas.add(replicaNodeId);
            }

            message.reply?.({ success: true, owner: state.nodeId });
            return state;
          }

          case "get": {
            const { key } = message;
            const now = tools.clock.now().wallMs;
            const entry = state.data.get(key);

            if (!entry || entry.ttl < now) {
              // Cache miss
              membershipEvents.append({
                type: "cache.miss",
                key,
                requestedFrom: state.nodeId,
              });

              if (entry && entry.ttl < now) {
                // Clean up expired entry
                state.data.delete(key);
              }

              message.reply?.(null);
              return state;
            }

            // Cache hit
            membershipEvents.append({
              type: "cache.hit",
              key,
              servedBy: state.nodeId,
            });

            message.reply?.(entry.value);
            return state;
          }

          case "gossip": {
            const membership = clusterMembership.deref();
            const activePeers = Array.from(membership.keys()).filter(
              (nodeId) => nodeId !== state.nodeId && membership.get(nodeId)?.status === "active",
            );

            if (activePeers.length === 0) {
              // Schedule next gossip
              tools.schedule(ms(2000), { type: "gossip" });
              return state;
            }

            // Pick random peer to gossip with
            const peer = activePeers[Math.floor(Math.random() * activePeers.length)];

            // Prepare gossip data (sample of our entries)
            const entries = Array.from(state.data.values()).slice(0, 10);

            membershipEvents.append({
              type: "gossip.sent",
              fromNode: state.nodeId,
              toNode: peer,
              entries: entries.length,
            });

            // In real implementation, this would be a network call
            // For demo, we'll just log it
            console.log(`Node ${state.nodeId} gossiping ${entries.length} entries to ${peer}`);

            // Schedule next gossip
            tools.schedule(ms(2000 + Math.random() * 1000), { type: "gossip" });

            return { ...state, lastGossip: tools.clock.now().wallMs };
          }

          case "cleanup-expired": {
            const now = tools.clock.now().wallMs;
            let cleaned = 0;

            for (const [key, entry] of state.data) {
              if (entry.ttl < now) {
                state.data.delete(key);
                cleaned++;
              }
            }

            if (cleaned > 0) {
              console.log(`Node ${state.nodeId} cleaned up ${cleaned} expired entries`);
            }

            // Schedule next cleanup
            tools.schedule(ms(30000), { type: "cleanup-expired" });

            return state;
          }

          case "get-stats": {
            const membership = clusterMembership.deref();
            const nodeInfo = membership.get(state.nodeId);

            message.reply?.({
              nodeId: state.nodeId,
              entriesCount: state.data.size,
              status: nodeInfo?.status,
              load: nodeInfo?.load,
              uptime: tools.clock.now().wallMs - (nodeInfo?.lastHeartbeat || 0),
              zone: state.zone,
            });

            return state;
          }

          default:
            return state;
        }
      },

      // Cleanup on stop
      onStop: async (state, reason, tools) => {
        membershipEvents.append({
          type: "node.left",
          nodeId: state.nodeId,
          reason: reason === "normal" ? "graceful" : "failed",
        });

        clusterMembership.swap((membership) => {
          const newMembership = new Map(membership);
          newMembership.delete(state.nodeId);
          return newMembership;
        });
      },

      // Restart on failures
      supervision: {
        type: "one-for-one",
        backoff: { initial: ms(1000), max: ms(10000), factor: 2 },
        maxRestarts: { count: 3, within: ms(60000) },
      },
    },
    {},
  );
};

// Cache cluster manager
const clusterManager = supervisor.spawn(
  {
    name: "cluster-manager",

    init: () => ({
      nodes: new Map<string, any>(),
      nextNodeId: 0,
    }),

    handle: async (state, message, tools) => {
      switch (message.type) {
        case "add-node": {
          const { address, port, zone } = message;
          const nodeId = `node-${state.nextNodeId++}`;

          // Create and start cache node
          const node = createCacheNode(nodeId, address, port, zone);
          state.nodes.set(nodeId, node);

          // Join the cluster
          await node.ask((reply: any) => ({ type: "join-cluster", reply }));

          // Start cleanup tasks
          node.send({ type: "cleanup-expired" });

          message.reply?.({ nodeId, success: true });
          return { ...state, nextNodeId: state.nextNodeId };
        }

        case "remove-node": {
          const { nodeId } = message;
          const node = state.nodes.get(nodeId);

          if (node) {
            await node.stop("normal");
            state.nodes.delete(nodeId);
            message.reply?.({ success: true });
          } else {
            message.reply?.({ success: false, error: "Node not found" });
          }

          return state;
        }

        case "get-cluster-status": {
          const membership = clusterMembership.deref();
          const stats = await Promise.all(
            Array.from(state.nodes.entries()).map(async ([nodeId, node]) => {
              try {
                return await node.ask((reply: any) => ({ type: "get-stats", reply }), ms(1000));
              } catch {
                return { nodeId, status: "unreachable" };
              }
            }),
          );

          message.reply?.({
            totalNodes: state.nodes.size,
            activeNodes: Array.from(membership.values()).filter((n) => n.status === "active").length,
            nodes: stats,
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

// Cache client that handles routing and failover
export class DistributedCacheClient {
  private consistentHash = new ConsistentHash();

  constructor() {
    // Watch membership changes to update routing
    clusterMembership.watch(() => {
      const membership = clusterMembership.deref();
      const activeNodes = Array.from(membership.entries())
        .filter(([_, info]) => info.status === "active")
        .map(([nodeId, _]) => nodeId);

      this.consistentHash = new ConsistentHash(activeNodes);
    });
  }

  async set(key: string, value: any, ttl?: number): Promise<boolean> {
    const targetNode = this.consistentHash.getNode(key);
    if (!targetNode) {
      throw new Error("No active nodes available");
    }

    const membership = clusterMembership.deref();
    const nodeInfo = membership.get(targetNode);
    if (!nodeInfo || nodeInfo.status !== "active") {
      throw new Error("Target node is not active");
    }

    // In real implementation, this would be an HTTP/TCP call
    // For demo, we'll get the node process and call it directly
    const nodes = await clusterManager.ask((reply: any) => ({ type: "get-cluster-status", reply }));
    const node = nodes.nodes.find((n: any) => n.nodeId === targetNode);

    if (!node) {
      throw new Error("Node not found");
    }

    // Simulate network call with effect and timeout
    return await effect(async (env) => {
      await sleep(Math.random() * 10).unsafeRunPromise({ clock }); // Network latency

      // Here you would make actual network call
      // For demo, we'll return success
      return { _tag: "Ok" as const, value: true };
    })
      .timeout(5000)
      .unsafeRunPromise({ clock })
      .then((result) => {
        if (result._tag === "Err") {
          throw new Error("Set operation failed or timed out");
        }
        return result.value;
      });
  }

  async get(key: string): Promise<any> {
    const primaryNode = this.consistentHash.getNode(key);
    const replicaNodes = this.consistentHash.getReplicaNodes(key, 3);

    // Try primary first, then replicas
    const candidateNodes = [primaryNode, ...replicaNodes].filter(Boolean);

    for (const nodeId of candidateNodes) {
      const membership = clusterMembership.deref();
      const nodeInfo = membership.get(nodeId);

      if (!nodeInfo || nodeInfo.status !== "active") {
        continue;
      }

      try {
        // Simulate network call with timeout
        const result = await effect(async (env) => {
          await sleep(Math.random() * 5).unsafeRunPromise({ clock });

          // Here you would make actual network call
          // For demo, we'll simulate cache hit/miss
          if (Math.random() > 0.1) {
            // 90% hit rate
            return { _tag: "Ok" as const, value: `cached-value-for-${key}` };
          } else {
            return { _tag: "Ok" as const, value: null };
          }
        })
          .timeout(2000)
          .unsafeRunPromise({ clock });

        if (result._tag === "Ok" && result.value !== null) {
          return result.value;
        }
      } catch {
        // Try next node
        continue;
      }
    }

    return null; // Cache miss
  }

  async getClusterStatus() {
    return await clusterManager.ask((reply: any) => ({ type: "get-cluster-status", reply }));
  }
}

// Monitoring and alerting service
const monitoringService = supervisor.spawn(
  {
    name: "monitoring",

    init: () => ({
      lastClusterCheck: 0,
      alerts: [] as Array<{ type: string; message: string; timestamp: number }>,
    }),

    handle: async (state, message, tools) => {
      switch (message.type) {
        case "check-cluster-health": {
          const membership = clusterMembership.deref();
          const activeNodes = Array.from(membership.values()).filter((n) => n.status === "active").length;
          const totalNodes = membership.size;

          if (activeNodes < totalNodes * 0.5) {
            const alert = {
              type: "cluster-unhealthy",
              message: `Only ${activeNodes}/${totalNodes} nodes active`,
              timestamp: tools.clock.now().wallMs,
            };

            state.alerts.push(alert);
            console.warn(`🚨 ALERT: ${alert.message}`);
          }

          // Check for split-brain scenarios
          const zones = new Set(Array.from(membership.values()).map((n) => n.zone));
          if (zones.size > 1 && activeNodes < 3) {
            const alert = {
              type: "split-brain-risk",
              message: `Multi-zone cluster with only ${activeNodes} nodes`,
              timestamp: tools.clock.now().wallMs,
            };

            state.alerts.push(alert);
            console.warn(`🚨 ALERT: ${alert.message}`);
          }

          // Schedule next health check
          tools.schedule(ms(10000), { type: "check-cluster-health" });

          return { ...state, lastClusterCheck: tools.clock.now().wallMs };
        }

        case "get-alerts": {
          const recentAlerts = state.alerts.filter(
            (alert) => tools.clock.now().wallMs - alert.timestamp < 3600000, // Last hour
          );

          message.reply?.(recentAlerts);
          return state;
        }

        default:
          return state;
      }
    },
  },
  {},
);

// Demo usage
async function demo() {
  console.log("🚀 Starting distributed cache cluster...");

  // Create 5-node cluster across 2 zones
  const nodeConfigs = [
    { address: "10.0.1.1", port: 7001, zone: "us-east-1a" },
    { address: "10.0.1.2", port: 7002, zone: "us-east-1a" },
    { address: "10.0.1.3", port: 7003, zone: "us-east-1a" },
    { address: "10.0.2.1", port: 7004, zone: "us-east-1b" },
    { address: "10.0.2.2", port: 7005, zone: "us-east-1b" },
  ];

  const nodeIds = [];
  for (const config of nodeConfigs) {
    const result = await clusterManager.ask((reply: any) => ({
      type: "add-node",
      ...config,
      reply,
    }));

    if (result.success) {
      nodeIds.push(result.nodeId);
      console.log(`✅ Node ${result.nodeId} joined cluster`);
    }
  }

  // Start monitoring
  monitoringService.send({ type: "check-cluster-health" });

  // Wait for cluster to stabilize
  await sleep(2000).unsafeRunPromise({ clock });

  // Create cache client
  const cache = new DistributedCacheClient();

  // Demo cache operations
  console.log("\n📝 Testing cache operations...");

  // Set some values
  await cache.set("user:1001", { name: "Alice", email: "alice@example.com" });
  await cache.set("user:1002", { name: "Bob", email: "bob@example.com" });
  await cache.set("session:abc123", { userId: 1001, expires: Date.now() + 3600000 });

  // Get values
  const user1 = await cache.get("user:1001");
  const user2 = await cache.get("user:1002");
  const session = await cache.get("session:abc123");

  console.log("Retrieved user1:", user1);
  console.log("Retrieved user2:", user2);
  console.log("Retrieved session:", session);

  // Check cluster status
  const status = await cache.getClusterStatus();
  console.log("\n📊 Cluster status:", status);

  // Simulate node failure
  console.log("\n💥 Simulating node failure...");
  await clusterManager.ask((reply: any) => ({
    type: "remove-node",
    nodeId: nodeIds[0],
    reply,
  }));

  // Wait for failure detection
  await sleep(3000).unsafeRunPromise({ clock });

  // Check if cache still works
  const userAfterFailure = await cache.get("user:1001");
  console.log("Retrieved user1 after node failure:", userAfterFailure);

  // Check alerts
  const alerts = await monitoringService.ask((reply: any) => ({ type: "get-alerts", reply }));
  console.log("\n🚨 System alerts:", alerts);

  // Final cluster status
  const finalStatus = await cache.getClusterStatus();
  console.log("\n📊 Final cluster status:", finalStatus);

  console.log("\n✅ Distributed cache demo completed");
}

if (import.meta.main) {
  demo().catch(console.error);
}
```

## What This Demonstrates

1. **Consistent Hashing**: Keys are distributed across nodes using virtual nodes for even distribution.

2. **Automatic Failover**: When nodes fail, the system detects it via heartbeats and redistributes data.

3. **Data Replication**: Each key is replicated to multiple nodes for fault tolerance.

4. **Gossip Protocol**: Nodes exchange information about data and membership changes.

5. **Load Balancing**: Client routes requests to appropriate nodes based on the hash ring.

6. **Health Monitoring**: Continuous monitoring with alerting for cluster health issues.

7. **Zone Awareness**: Replicas are placed across availability zones to survive zone failures.

8. **TTL and Cleanup**: Automatic expiration and cleanup of stale data.

9. **Supervision**: Failed processes restart automatically with exponential backoff.

This pattern scales to hundreds of nodes with proper network protocols. The primitives make complex distributed systems behaviors testable and debuggable.

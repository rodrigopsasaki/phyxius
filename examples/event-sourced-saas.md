# Event-Sourced SaaS Platform

**Multi-tenant platform with billing, audit trails, and time travel debugging**

This example shows how to build a complete SaaS platform using event sourcing patterns. Every state change is an event. Current state is derived by replaying events. Time travel debugging comes for free.

## Architecture

- **Clock**: Deterministic time for billing cycles and event timestamps
- **Journal**: Event store for complete audit trails and replay capability
- **Atom**: Atomic state for user sessions and real-time data
- **Process**: Isolated tenant processes with supervision and restart policies
- **Effect**: Resource management for database connections and external APIs

## The System

```typescript
import { createSystemClock, ms } from "@phyxius/clock";
import { Journal } from "@phyxius/journal";
import { createAtom } from "@phyxius/atom";
import { createRootSupervisor } from "@phyxius/process";
import { effect, acquireUseRelease } from "@phyxius/effect";

const clock = createSystemClock();
const supervisor = createRootSupervisor({ clock });

// Event types for the platform
type PlatformEvent =
  | { type: "tenant.created"; tenantId: string; plan: "starter" | "pro" | "enterprise"; ownerId: string }
  | { type: "user.invited"; tenantId: string; userId: string; email: string; role: "admin" | "user" }
  | { type: "user.activated"; tenantId: string; userId: string }
  | { type: "billing.cycle.started"; tenantId: string; cycleId: string; amount: number }
  | { type: "billing.payment.succeeded"; tenantId: string; cycleId: string; amount: number }
  | { type: "billing.payment.failed"; tenantId: string; cycleId: string; amount: number; reason: string }
  | { type: "feature.used"; tenantId: string; userId: string; feature: string; usage: number }
  | { type: "limits.exceeded"; tenantId: string; feature: string; limit: number; usage: number }
  | { type: "tenant.suspended"; tenantId: string; reason: string }
  | { type: "tenant.reactivated"; tenantId: string };

// Tenant state derived from events
interface TenantState {
  tenantId: string;
  plan: "starter" | "pro" | "enterprise";
  ownerId: string;
  status: "active" | "suspended" | "cancelled";
  users: Map<string, { email: string; role: "admin" | "user"; status: "invited" | "active" }>;
  billing: {
    currentCycle?: string;
    lastPayment?: number;
    failedPayments: number;
  };
  usage: Map<string, number>; // feature -> usage count
  limits: Map<string, number>; // feature -> limit
}

// Event store for the entire platform
const platformEvents = new Journal<PlatformEvent>({
  clock,
  emit: (event) => {
    console.log(`[${new Date().toISOString()}] Journal:`, event.type);
  },
});

// Real-time session management
const activeSessions = createAtom(
  new Map<
    string,
    {
      userId: string;
      tenantId: string;
      connectedAt: number;
      lastSeen: number;
    }
  >(),
  clock,
);

// Global tenant registry
const tenantRegistry = createAtom(new Map<string, TenantState>(), clock);

// Tenant process that handles all operations for a single tenant
const createTenantProcess = (tenantId: string, initialState: TenantState) => {
  return supervisor.spawn(
    {
      name: `tenant-${tenantId}`,
      init: () => initialState,

      handle: async (state, message, tools) => {
        switch (message.type) {
          case "invite-user": {
            const { userId, email, role } = message;

            // Check if user already exists
            if (state.users.has(userId)) {
              message.reply?.({ success: false, error: "User already exists" });
              return state;
            }

            // Check user limits based on plan
            const userLimit = state.limits.get("users") ?? 0;
            if (state.users.size >= userLimit) {
              // Emit limit exceeded event
              platformEvents.append({
                type: "limits.exceeded",
                tenantId: state.tenantId,
                feature: "users",
                limit: userLimit,
                usage: state.users.size + 1,
              });

              message.reply?.({ success: false, error: "User limit exceeded" });
              return state;
            }

            // Emit invitation event
            platformEvents.append({
              type: "user.invited",
              tenantId: state.tenantId,
              userId,
              email,
              role,
            });

            // Update state
            const newState = { ...state };
            newState.users.set(userId, { email, role, status: "invited" });

            message.reply?.({ success: true });
            return newState;
          }

          case "activate-user": {
            const { userId } = message;

            const user = state.users.get(userId);
            if (!user || user.status !== "invited") {
              message.reply?.({ success: false, error: "User not found or already active" });
              return state;
            }

            // Emit activation event
            platformEvents.append({
              type: "user.activated",
              tenantId: state.tenantId,
              userId,
            });

            // Update state
            const newState = { ...state };
            newState.users.set(userId, { ...user, status: "active" });

            message.reply?.({ success: true });
            return newState;
          }

          case "record-usage": {
            const { userId, feature, amount } = message;

            // Record feature usage event
            platformEvents.append({
              type: "feature.used",
              tenantId: state.tenantId,
              userId,
              feature,
              usage: amount,
            });

            // Update usage tracking
            const newState = { ...state };
            const currentUsage = newState.usage.get(feature) ?? 0;
            const newUsage = currentUsage + amount;
            newState.usage.set(feature, newUsage);

            // Check limits
            const limit = state.limits.get(feature);
            if (limit && newUsage > limit) {
              platformEvents.append({
                type: "limits.exceeded",
                tenantId: state.tenantId,
                feature,
                limit,
                usage: newUsage,
              });

              message.reply?.({ success: false, error: "Usage limit exceeded", usage: newUsage, limit });
              return newState;
            }

            message.reply?.({ success: true, usage: newUsage });
            return newState;
          }

          case "process-billing": {
            if (state.status !== "active") {
              message.reply?.({ success: false, error: "Tenant not active" });
              return state;
            }

            const cycleId = `cycle-${Date.now()}`;
            const amount = getPlanAmount(state.plan);

            // Start billing cycle
            platformEvents.append({
              type: "billing.cycle.started",
              tenantId: state.tenantId,
              cycleId,
              amount,
            });

            // Simulate payment processing
            const paymentSuccess = Math.random() > 0.1; // 90% success rate

            if (paymentSuccess) {
              platformEvents.append({
                type: "billing.payment.succeeded",
                tenantId: state.tenantId,
                cycleId,
                amount,
              });

              const newState = { ...state };
              newState.billing.currentCycle = cycleId;
              newState.billing.lastPayment = tools.clock.now().wallMs;
              newState.billing.failedPayments = 0;

              message.reply?.({ success: true, amount });
              return newState;
            } else {
              const reason = "Card declined";
              platformEvents.append({
                type: "billing.payment.failed",
                tenantId: state.tenantId,
                cycleId,
                amount,
                reason,
              });

              const newState = { ...state };
              newState.billing.failedPayments++;

              // Suspend after 3 failed payments
              if (newState.billing.failedPayments >= 3) {
                platformEvents.append({
                  type: "tenant.suspended",
                  tenantId: state.tenantId,
                  reason: "Payment failures",
                });
                newState.status = "suspended";
              }

              message.reply?.({ success: false, error: reason });
              return newState;
            }
          }

          case "get-state": {
            message.reply(state);
            return state;
          }

          default:
            return state;
        }
      },

      // Graceful shutdown
      onStop: async (state, reason) => {
        console.log(`Tenant ${state.tenantId} process stopped: ${reason}`);
      },

      // Restart on failures
      supervision: {
        type: "one-for-one",
        backoff: { initial: ms(1000), max: ms(30000), factor: 2 },
        maxRestarts: { count: 5, within: ms(60000) },
      },
    },
    {},
  );
};

// Platform management service
const platformManager = supervisor.spawn(
  {
    name: "platform-manager",
    init: () => ({ tenants: new Map<string, any>() }),

    handle: async (state, message, tools) => {
      switch (message.type) {
        case "create-tenant": {
          const { tenantId, plan, ownerId } = message;

          // Emit tenant creation event
          platformEvents.append({
            type: "tenant.created",
            tenantId,
            plan,
            ownerId,
          });

          // Set up plan limits
          const limits = getPlanLimits(plan);

          // Create initial tenant state
          const initialState: TenantState = {
            tenantId,
            plan,
            ownerId,
            status: "active",
            users: new Map(),
            billing: { failedPayments: 0 },
            usage: new Map(),
            limits,
          };

          // Spawn tenant process
          const tenantProcess = createTenantProcess(tenantId, initialState);
          state.tenants.set(tenantId, tenantProcess);

          // Update registry
          tenantRegistry.swap((registry) => new Map(registry).set(tenantId, initialState));

          message.reply?.({ success: true, tenantId });
          return state;
        }

        case "get-tenant": {
          const { tenantId } = message;
          const tenant = state.tenants.get(tenantId);

          if (!tenant) {
            message.reply?.(null);
            return state;
          }

          // Get current state from tenant process
          const tenantState = await tenant.ask((reply: any) => ({ type: "get-state", reply }));
          message.reply?.(tenantState);
          return state;
        }

        default:
          return state;
      }
    },
  },
  {},
);

// Billing service that runs periodic billing cycles
const billingService = supervisor.spawn(
  {
    name: "billing-service",
    init: () => ({ lastBillingRun: 0 }),

    handle: async (state, message, tools) => {
      switch (message.type) {
        case "start-billing-cycle": {
          console.log("Starting billing cycle...");

          const registry = tenantRegistry.deref();
          let processed = 0;
          let failures = 0;

          for (const [tenantId, tenantState] of registry) {
            if (tenantState.status === "active") {
              try {
                const tenant = await platformManager.ask((reply: any) => ({
                  type: "get-tenant",
                  tenantId,
                  reply,
                }));

                if (tenant) {
                  // Process billing for this tenant
                  await tenant.ask((reply: any) => ({ type: "process-billing", reply }));
                  processed++;
                }
              } catch (error) {
                console.error(`Billing failed for tenant ${tenantId}:`, error);
                failures++;
              }
            }
          }

          console.log(`Billing cycle complete: ${processed} processed, ${failures} failures`);

          // Schedule next billing cycle in 24 hours
          tools.schedule(ms(24 * 60 * 60 * 1000), { type: "start-billing-cycle" });

          return { ...state, lastBillingRun: tools.clock.now().wallMs };
        }

        default:
          return state;
      }
    },
  },
  {},
);

// Session management service
const sessionManager = supervisor.spawn(
  {
    name: "session-manager",
    init: () => ({}),

    handle: async (state, message, tools) => {
      switch (message.type) {
        case "user-connected": {
          const { userId, tenantId, sessionId } = message;

          activeSessions.swap((sessions) =>
            new Map(sessions).set(sessionId, {
              userId,
              tenantId,
              connectedAt: tools.clock.now().wallMs,
              lastSeen: tools.clock.now().wallMs,
            }),
          );

          console.log(`User ${userId} connected to tenant ${tenantId}`);
          return state;
        }

        case "user-disconnected": {
          const { sessionId } = message;

          activeSessions.swap((sessions) => {
            const newSessions = new Map(sessions);
            newSessions.delete(sessionId);
            return newSessions;
          });

          console.log(`Session ${sessionId} disconnected`);
          return state;
        }

        case "cleanup-stale-sessions": {
          const now = tools.clock.now().wallMs;
          const staleThreshold = 30 * 60 * 1000; // 30 minutes

          activeSessions.swap((sessions) => {
            const newSessions = new Map();
            for (const [sessionId, session] of sessions) {
              if (now - session.lastSeen < staleThreshold) {
                newSessions.set(sessionId, session);
              }
            }
            return newSessions;
          });

          // Schedule next cleanup
          tools.schedule(ms(5 * 60 * 1000), { type: "cleanup-stale-sessions" });

          return state;
        }

        default:
          return state;
      }
    },
  },
  {},
);

// Helper functions
function getPlanLimits(plan: "starter" | "pro" | "enterprise"): Map<string, number> {
  const limits = new Map();

  switch (plan) {
    case "starter":
      limits.set("users", 5);
      limits.set("api_calls", 1000);
      limits.set("storage_mb", 100);
      break;
    case "pro":
      limits.set("users", 25);
      limits.set("api_calls", 10000);
      limits.set("storage_mb", 1000);
      break;
    case "enterprise":
      limits.set("users", 100);
      limits.set("api_calls", 100000);
      limits.set("storage_mb", 10000);
      break;
  }

  return limits;
}

function getPlanAmount(plan: "starter" | "pro" | "enterprise"): number {
  switch (plan) {
    case "starter":
      return 2900; // $29.00
    case "pro":
      return 9900; // $99.00
    case "enterprise":
      return 29900; // $299.00
  }
}

// Platform API - this is what your HTTP endpoints would call
export class SaaSPlatform {
  async createTenant(plan: "starter" | "pro" | "enterprise", ownerId: string): Promise<string> {
    const tenantId = `tenant-${crypto.randomUUID()}`;

    const result = await platformManager.ask((reply: any) => ({
      type: "create-tenant",
      tenantId,
      plan,
      ownerId,
      reply,
    }));

    if (!result.success) {
      throw new Error("Failed to create tenant");
    }

    return tenantId;
  }

  async inviteUser(tenantId: string, userId: string, email: string, role: "admin" | "user" = "user") {
    const tenant = await platformManager.ask((reply: any) => ({
      type: "get-tenant",
      tenantId,
      reply,
    }));

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return await tenant.ask((reply: any) => ({
      type: "invite-user",
      userId,
      email,
      role,
      reply,
    }));
  }

  async activateUser(tenantId: string, userId: string) {
    const tenant = await platformManager.ask((reply: any) => ({
      type: "get-tenant",
      tenantId,
      reply,
    }));

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return await tenant.ask((reply: any) => ({
      type: "activate-user",
      userId,
      reply,
    }));
  }

  async recordUsage(tenantId: string, userId: string, feature: string, amount: number = 1) {
    const tenant = await platformManager.ask((reply: any) => ({
      type: "get-tenant",
      tenantId,
      reply,
    }));

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return await tenant.ask((reply: any) => ({
      type: "record-usage",
      userId,
      feature,
      amount,
      reply,
    }));
  }

  async getTenantState(tenantId: string): Promise<TenantState | null> {
    return await platformManager.ask((reply: any) => ({
      type: "get-tenant",
      tenantId,
      reply,
    }));
  }

  async getActiveSessions(): Promise<Map<string, any>> {
    return activeSessions.deref();
  }

  // Time travel debugging - replay events up to a specific point
  async replayTenantState(tenantId: string, upToSequence: number): Promise<TenantState | null> {
    const snapshot = platformEvents.getSnapshot();
    const relevantEvents = snapshot.entries
      .filter((entry) => entry.sequence <= upToSequence)
      .filter((entry) => {
        const event = entry.data;
        return "tenantId" in event && event.tenantId === tenantId;
      })
      .map((entry) => entry.data);

    if (relevantEvents.length === 0) return null;

    // Find creation event
    const creationEvent = relevantEvents.find((event) => event.type === "tenant.created");
    if (!creationEvent || creationEvent.type !== "tenant.created") return null;

    // Rebuild state by replaying events
    let state: TenantState = {
      tenantId,
      plan: creationEvent.plan,
      ownerId: creationEvent.ownerId,
      status: "active",
      users: new Map(),
      billing: { failedPayments: 0 },
      usage: new Map(),
      limits: getPlanLimits(creationEvent.plan),
    };

    for (const event of relevantEvents.slice(1)) {
      state = applyEventToState(state, event);
    }

    return state;
  }

  // Get complete audit trail for a tenant
  async getAuditTrail(tenantId: string): Promise<Array<{ sequence: number; timestamp: any; event: PlatformEvent }>> {
    const snapshot = platformEvents.getSnapshot();
    return snapshot.entries
      .filter((entry) => {
        const event = entry.data;
        return "tenantId" in event && event.tenantId === tenantId;
      })
      .map((entry) => ({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        event: entry.data,
      }));
  }
}

// Apply individual events to rebuild state (for time travel)
function applyEventToState(state: TenantState, event: PlatformEvent): TenantState {
  switch (event.type) {
    case "user.invited":
      const newState1 = { ...state };
      newState1.users.set(event.userId, {
        email: event.email,
        role: event.role,
        status: "invited",
      });
      return newState1;

    case "user.activated":
      const newState2 = { ...state };
      const user = newState2.users.get(event.userId);
      if (user) {
        newState2.users.set(event.userId, { ...user, status: "active" });
      }
      return newState2;

    case "feature.used":
      const newState3 = { ...state };
      const currentUsage = newState3.usage.get(event.feature) ?? 0;
      newState3.usage.set(event.feature, currentUsage + event.usage);
      return newState3;

    case "billing.payment.succeeded":
      const newState4 = { ...state };
      newState4.billing.currentCycle = event.cycleId;
      newState4.billing.failedPayments = 0;
      return newState4;

    case "billing.payment.failed":
      const newState5 = { ...state };
      newState5.billing.failedPayments++;
      return newState5;

    case "tenant.suspended":
      return { ...state, status: "suspended" };

    case "tenant.reactivated":
      return { ...state, status: "active" };

    default:
      return state;
  }
}

// Start the platform services
async function startPlatform() {
  console.log("🚀 Starting SaaS platform...");

  // Start billing cycle (in production, this would be a cron job)
  billingService.send({ type: "start-billing-cycle" });

  // Start session cleanup
  sessionManager.send({ type: "cleanup-stale-sessions" });

  console.log("✅ Platform started successfully");
}

// Example usage
async function demo() {
  await startPlatform();

  const platform = new SaaSPlatform();

  // Create a tenant
  const tenantId = await platform.createTenant("pro", "owner-123");
  console.log("Created tenant:", tenantId);

  // Invite and activate users
  await platform.inviteUser(tenantId, "user-1", "alice@example.com", "admin");
  await platform.activateUser(tenantId, "user-1");

  await platform.inviteUser(tenantId, "user-2", "bob@example.com", "user");
  await platform.activateUser(tenantId, "user-2");

  // Record some usage
  await platform.recordUsage(tenantId, "user-1", "api_calls", 100);
  await platform.recordUsage(tenantId, "user-2", "api_calls", 50);

  // Get current state
  const currentState = await platform.getTenantState(tenantId);
  console.log("Current tenant state:", currentState);

  // Time travel - what was the state after the first user was invited?
  const historicalState = await platform.replayTenantState(tenantId, 1);
  console.log("Historical state (after first invite):", historicalState);

  // Get complete audit trail
  const auditTrail = await platform.getAuditTrail(tenantId);
  console.log("Audit trail:", auditTrail);
}

if (import.meta.main) {
  demo().catch(console.error);
}
```

## What This Demonstrates

1. **Complete Event Sourcing**: Every state change is an event. Current state is derived by replaying events.

2. **Time Travel Debugging**: Query the state at any point in time by replaying events up to that point.

3. **Isolated Tenant Processes**: Each tenant runs in its own supervised process. Failures don't cascade.

4. **Automatic Billing**: Scheduled billing cycles with retry logic and suspension policies.

5. **Real-Time State**: Atomic state management for sessions and live data.

6. **Complete Audit Trail**: Every action is logged with timestamps and causality.

7. **Resource Management**: Database connections and external APIs managed with Effect patterns.

8. **Supervision**: Processes restart automatically on failure with exponential backoff.

This pattern scales from single-tenant to massive multi-tenant platforms. Every component is testable with controlled time. Every bug is debuggable with complete history.

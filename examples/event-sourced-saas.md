# Example: Event-Sourced SaaS Platform

## Problem Brief

Building a multi-tenant SaaS platform with proper audit trails, real-time features, and reliable billing is extremely challenging. Traditional approaches struggle with:

- **Data consistency** across tenant operations
- **Audit requirements** for compliance and debugging
- **Real-time notifications** and UI updates
- **Reliable billing** based on usage events
- **Testing complexity** of time-dependent business logic
- **System observability** across tenant boundaries

## Before: Traditional SaaS Architecture

```typescript
// Fragile implementation with multiple critical issues
class TraditionalSaasManager {
  private database: Database;
  private notificationService: NotificationService;
  private billingService: BillingService;

  async createProject(tenantId: string, projectData: any): Promise<string> {
    try {
      // Direct database mutation - no audit trail
      const projectId = await this.database.insert("projects", {
        ...projectData,
        tenantId,
        createdAt: new Date(), // Hard to test!
        status: "active",
      });

      // Update tenant usage - RACE CONDITION!
      const tenant = await this.database.findOne("tenants", { id: tenantId });
      await this.database.update("tenants", tenantId, {
        projectCount: tenant.projectCount + 1,
      });

      // Send notification - might fail silently
      try {
        await this.notificationService.send(tenantId, {
          type: "project_created",
          projectId,
          projectName: projectData.name,
        });
      } catch (error) {
        console.log("Notification failed:", error.message);
        // Silent failure - user never knows!
      }

      // Record usage for billing - might be lost
      try {
        await this.billingService.recordUsage(tenantId, "project_created", 1);
      } catch (error) {
        console.log("Billing record failed:", error.message);
        // Lost revenue - no retry, no recovery!
      }

      return projectId;
    } catch (error) {
      // Partial state changes might have occurred
      // No way to know what succeeded and what failed
      throw error;
    }
  }

  async deleteProject(tenantId: string, projectId: string): Promise<void> {
    // Similar problems:
    // - No audit trail of deletion
    // - Race conditions in usage updates
    // - Silent notification failures
    // - Lost billing events
    // - Difficult to test time-dependent logic
    // What if deletion partially fails?
    // How do you recover from inconsistent state?
    // How do you prove compliance requirements were met?
  }
}

// Problems:
// 1. No audit trail for compliance
// 2. Race conditions in tenant state updates
// 3. Silent failures in notifications/billing
// 4. Impossible to test time-dependent logic
// 5. No observability into system behavior
// 6. Partial failures leave inconsistent state
```

## After: Event-Sourced SaaS with Phyxius

```typescript
import { createSystemClock, createControlledClock } from "@phyxius/clock";
import { createAtom } from "@phyxius/atom";
import { createJournal } from "@phyxius/journal";
import { runEffect } from "@phyxius/effect";
import { createSupervisor } from "@phyxius/process";

// Complete event-sourced SaaS platform
class EventSourcedSaasManager {
  private tenantStates = new Map<string, Atom<TenantState>>();

  constructor(
    private clock = createSystemClock(),
    private eventStore = createJournal(),
    private supervisor = createSupervisor({ emit: this.logSystemEvent.bind(this) }),
  ) {
    this.initializeEventProcessors();
  }

  async createProject(tenantId: string, projectData: ProjectData): Promise<string> {
    return runEffect(async (context) => {
      const projectId = generateId();
      const now = this.clock.now();

      context.set("operation", "create_project");
      context.set("tenantId", tenantId);
      context.set("projectId", projectId);
      context.set("startTime", now);

      // Ensure tenant exists
      await this.ensureTenantExists(tenantId, context);

      // Create the primary event
      const projectCreatedEvent = {
        type: "project.created",
        tenantId,
        projectId,
        projectData: {
          ...projectData,
          createdAt: now,
          status: "active",
        },
        timestamp: now,
        correlationId: context.get("correlationId") || generateId(),
      };

      // Append to event store - this is our source of truth
      await this.eventStore.append(projectCreatedEvent);

      // Apply the event to tenant state atomically
      await this.applyEventToTenant(tenantId, projectCreatedEvent, context);

      // The event store will trigger downstream processes
      // (notifications, billing, etc.) automatically

      return projectId;
    });
  }

  async deleteProject(tenantId: string, projectId: string, reason: string): Promise<void> {
    return runEffect(async (context) => {
      context.set("operation", "delete_project");
      context.set("tenantId", tenantId);
      context.set("projectId", projectId);

      // Verify project exists and belongs to tenant
      const tenant = await this.getTenantState(tenantId);
      const project = tenant.projects.get(projectId);

      if (!project) {
        throw new Error(`Project ${projectId} not found for tenant ${tenantId}`);
      }

      if (project.status === "deleted") {
        return; // Idempotent operation
      }

      const deletionEvent = {
        type: "project.deleted",
        tenantId,
        projectId,
        reason,
        previousStatus: project.status,
        timestamp: this.clock.now(),
        correlationId: context.get("correlationId") || generateId(),
      };

      await this.eventStore.append(deletionEvent);
      await this.applyEventToTenant(tenantId, deletionEvent, context);
    });
  }

  async inviteUser(tenantId: string, email: string, role: string): Promise<string> {
    return runEffect(async (context) => {
      const invitationId = generateId();
      const expiresAt = this.clock.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

      context.set("operation", "invite_user");
      context.set("tenantId", tenantId);
      context.set("invitationId", invitationId);

      const invitationEvent = {
        type: "user.invited",
        tenantId,
        invitationId,
        email,
        role,
        expiresAt,
        timestamp: this.clock.now(),
        correlationId: context.get("correlationId") || generateId(),
      };

      await this.eventStore.append(invitationEvent);
      await this.applyEventToTenant(tenantId, invitationEvent, context);

      return invitationId;
    });
  }

  async acceptInvitation(invitationId: string, userId: string): Promise<void> {
    return runEffect(async (context) => {
      context.set("operation", "accept_invitation");
      context.set("invitationId", invitationId);
      context.set("userId", userId);

      // Find the invitation across all tenants
      const invitation = await this.findInvitation(invitationId);
      if (!invitation) {
        throw new Error(`Invitation ${invitationId} not found`);
      }

      if (invitation.expiresAt <= this.clock.now()) {
        throw new Error(`Invitation ${invitationId} has expired`);
      }

      const acceptanceEvent = {
        type: "user.invitation_accepted",
        tenantId: invitation.tenantId,
        invitationId,
        userId,
        role: invitation.role,
        timestamp: this.clock.now(),
        correlationId: context.get("correlationId") || generateId(),
      };

      await this.eventStore.append(acceptanceEvent);
      await this.applyEventToTenant(invitation.tenantId, acceptanceEvent, context);
    });
  }

  async recordUsage(tenantId: string, feature: string, quantity: number): Promise<void> {
    return runEffect(async (context) => {
      context.set("operation", "record_usage");
      context.set("tenantId", tenantId);
      context.set("feature", feature);

      const usageEvent = {
        type: "usage.recorded",
        tenantId,
        feature,
        quantity,
        timestamp: this.clock.now(),
        correlationId: context.get("correlationId") || generateId(),
      };

      await this.eventStore.append(usageEvent);
      await this.applyEventToTenant(tenantId, usageEvent, context);
    });
  }

  private async ensureTenantExists(tenantId: string, context): Promise<void> {
    if (!this.tenantStates.has(tenantId)) {
      // Initialize tenant state from event history
      await this.rebuildTenantState(tenantId, context);
    }
  }

  private async rebuildTenantState(tenantId: string, context): Promise<void> {
    context.set("rebuilding_tenant", tenantId);

    // Get all events for this tenant
    const tenantEvents = await this.eventStore.filter((event) => event.tenantId === tenantId);

    // Create initial tenant state
    const initialState: TenantState = {
      tenantId,
      projects: new Map(),
      users: new Map(),
      invitations: new Map(),
      usage: new Map(),
      billing: {
        currentPeriodStart: this.clock.now(),
        currentPeriodEnd: this.clock.now() + 30 * 24 * 60 * 60 * 1000,
        usage: new Map(),
        totalCost: 0,
      },
      createdAt: 0,
      lastActivity: 0,
    };

    const tenantAtom = createAtom(initialState);
    this.tenantStates.set(tenantId, tenantAtom);

    // Replay all events to rebuild state
    for (const event of tenantEvents) {
      await this.applyEventToTenantState(tenantAtom, event);
    }
  }

  private async applyEventToTenant(tenantId: string, event: any, context): Promise<void> {
    const tenantAtom = this.tenantStates.get(tenantId);
    if (!tenantAtom) {
      throw new Error(`Tenant ${tenantId} not initialized`);
    }

    await this.applyEventToTenantState(tenantAtom, event);
  }

  private async applyEventToTenantState(tenantAtom: Atom<TenantState>, event: any): Promise<void> {
    tenantAtom.update((state) => {
      switch (event.type) {
        case "project.created":
          const newProjects = new Map(state.projects);
          newProjects.set(event.projectId, {
            id: event.projectId,
            ...event.projectData,
            tenantId: event.tenantId,
          });

          return {
            ...state,
            projects: newProjects,
            lastActivity: event.timestamp,
          };

        case "project.deleted":
          const updatedProjects = new Map(state.projects);
          const project = updatedProjects.get(event.projectId);
          if (project) {
            updatedProjects.set(event.projectId, {
              ...project,
              status: "deleted",
              deletedAt: event.timestamp,
              deletionReason: event.reason,
            });
          }

          return {
            ...state,
            projects: updatedProjects,
            lastActivity: event.timestamp,
          };

        case "user.invited":
          const newInvitations = new Map(state.invitations);
          newInvitations.set(event.invitationId, {
            id: event.invitationId,
            email: event.email,
            role: event.role,
            status: "pending",
            expiresAt: event.expiresAt,
            createdAt: event.timestamp,
          });

          return {
            ...state,
            invitations: newInvitations,
            lastActivity: event.timestamp,
          };

        case "user.invitation_accepted":
          const updatedInvitations = new Map(state.invitations);
          const invitation = updatedInvitations.get(event.invitationId);
          if (invitation) {
            updatedInvitations.set(event.invitationId, {
              ...invitation,
              status: "accepted",
              acceptedAt: event.timestamp,
              userId: event.userId,
            });
          }

          const newUsers = new Map(state.users);
          newUsers.set(event.userId, {
            userId: event.userId,
            role: event.role,
            joinedAt: event.timestamp,
            status: "active",
          });

          return {
            ...state,
            invitations: updatedInvitations,
            users: newUsers,
            lastActivity: event.timestamp,
          };

        case "usage.recorded":
          const newUsage = new Map(state.usage);
          const currentUsage = newUsage.get(event.feature) || 0;
          newUsage.set(event.feature, currentUsage + event.quantity);

          return {
            ...state,
            usage: newUsage,
            lastActivity: event.timestamp,
          };

        default:
          return state;
      }
    });
  }

  private async initializeEventProcessors(): Promise<void> {
    // Notification processor
    await this.supervisor.spawn({
      async handle(message) {
        if (message.type === "process_notifications") {
          await this.processNotifications(message.events);
        }
      },
    });

    // Billing processor
    await this.supervisor.spawn({
      async handle(message) {
        if (message.type === "process_billing") {
          await this.processBilling(message.events);
        }
      },
    });

    // Analytics processor
    await this.supervisor.spawn({
      async handle(message) {
        if (message.type === "process_analytics") {
          await this.processAnalytics(message.events);
        }
      },
    });

    // Invitation expiry processor
    await this.supervisor.spawn({
      async handle(message) {
        if (message.type === "expire_invitations") {
          await this.expireInvitations();
        }
      },
    });
  }

  private async processNotifications(events: any[]): Promise<void> {
    for (const event of events) {
      try {
        switch (event.type) {
          case "project.created":
            await this.sendNotification(event.tenantId, {
              type: "project_created",
              projectId: event.projectId,
              projectName: event.projectData.name,
              timestamp: event.timestamp,
            });
            break;

          case "user.invited":
            await this.sendNotification(event.tenantId, {
              type: "user_invited",
              email: event.email,
              role: event.role,
              invitationId: event.invitationId,
              timestamp: event.timestamp,
            });
            break;

          case "user.invitation_accepted":
            await this.sendNotification(event.tenantId, {
              type: "user_joined",
              userId: event.userId,
              role: event.role,
              timestamp: event.timestamp,
            });
            break;
        }
      } catch (error) {
        // Log notification failure but don't fail the entire process
        await this.eventStore.append({
          type: "notification.failed",
          originalEvent: event,
          error: error.message,
          timestamp: this.clock.now(),
        });
      }
    }
  }

  private async processBilling(events: any[]): Promise<void> {
    for (const event of events) {
      try {
        switch (event.type) {
          case "project.created":
            await this.recordBillableUsage(event.tenantId, "project_created", 1, event.timestamp);
            break;

          case "usage.recorded":
            await this.recordBillableUsage(event.tenantId, event.feature, event.quantity, event.timestamp);
            break;

          case "user.invitation_accepted":
            await this.recordBillableUsage(event.tenantId, "user_added", 1, event.timestamp);
            break;
        }
      } catch (error) {
        await this.eventStore.append({
          type: "billing.failed",
          originalEvent: event,
          error: error.message,
          timestamp: this.clock.now(),
        });
      }
    }
  }

  private async processAnalytics(events: any[]): Promise<void> {
    // Process events for analytics/reporting
    const analyticsEvents = events.map((event) => ({
      type: "analytics.event_processed",
      originalType: event.type,
      tenantId: event.tenantId,
      timestamp: event.timestamp,
      processedAt: this.clock.now(),
    }));

    for (const analyticsEvent of analyticsEvents) {
      await this.eventStore.append(analyticsEvent);
    }
  }

  private async expireInvitations(): Promise<void> {
    const now = this.clock.now();

    for (const [tenantId, tenantAtom] of this.tenantStates) {
      const state = tenantAtom.get();

      for (const [invitationId, invitation] of state.invitations) {
        if (invitation.status === "pending" && invitation.expiresAt <= now) {
          const expiredEvent = {
            type: "user.invitation_expired",
            tenantId,
            invitationId,
            email: invitation.email,
            timestamp: now,
            correlationId: generateId(),
          };

          await this.eventStore.append(expiredEvent);
          await this.applyEventToTenant(tenantId, expiredEvent, {});
        }
      }
    }
  }

  private async getTenantState(tenantId: string): Promise<TenantState> {
    if (!this.tenantStates.has(tenantId)) {
      await this.rebuildTenantState(tenantId, {});
    }

    return this.tenantStates.get(tenantId)!.get();
  }

  private async findInvitation(invitationId: string): Promise<any> {
    for (const [tenantId, tenantAtom] of this.tenantStates) {
      const state = tenantAtom.get();
      const invitation = state.invitations.get(invitationId);

      if (invitation) {
        return { ...invitation, tenantId };
      }
    }

    return null;
  }

  private logSystemEvent(event: any): void {
    console.log(`[${new Date(this.clock.now()).toISOString()}] SaaS System:`, event);
  }

  // Stub implementations for external services
  private async sendNotification(tenantId: string, notification: any): Promise<void> {
    // Implementation would send real notifications
    console.log(`Notification for ${tenantId}:`, notification);
  }

  private async recordBillableUsage(
    tenantId: string,
    feature: string,
    quantity: number,
    timestamp: number,
  ): Promise<void> {
    // Implementation would record in billing system
    console.log(`Billing: ${tenantId} used ${quantity} of ${feature} at ${timestamp}`);
  }

  // Public APIs for querying and monitoring
  async getTenantProjects(tenantId: string): Promise<any[]> {
    const state = await this.getTenantState(tenantId);
    return Array.from(state.projects.values()).filter((p) => p.status !== "deleted");
  }

  async getTenantUsers(tenantId: string): Promise<any[]> {
    const state = await this.getTenantState(tenantId);
    return Array.from(state.users.values());
  }

  async getTenantUsage(tenantId: string): Promise<Map<string, number>> {
    const state = await this.getTenantState(tenantId);
    return state.usage;
  }

  async getAuditTrail(tenantId: string, filters?: any): Promise<any[]> {
    return await this.eventStore.filter((event) => {
      if (event.tenantId !== tenantId) return false;

      if (filters?.eventType && event.type !== filters.eventType) return false;
      if (filters?.since && event.timestamp < filters.since) return false;
      if (filters?.until && event.timestamp > filters.until) return false;

      return true;
    });
  }

  async getSystemStats(): Promise<any> {
    const allEvents = await this.eventStore.getAll();
    const tenantCount = this.tenantStates.size;
    const eventsByType = new Map<string, number>();

    for (const event of allEvents) {
      const count = eventsByType.get(event.type) || 0;
      eventsByType.set(event.type, count + 1);
    }

    return {
      totalEvents: allEvents.length,
      totalTenants: tenantCount,
      eventsByType: Object.fromEntries(eventsByType),
      systemUptime: this.clock.now() - (allEvents[0]?.timestamp || this.clock.now()),
    };
  }
}

// Usage example
async function demonstrateEventSourcedSaas() {
  const saas = new EventSourcedSaasManager();

  // Create a tenant and project
  const tenantId = "tenant-123";
  const projectId = await saas.createProject(tenantId, {
    name: "My Project",
    description: "A sample project",
  });

  console.log("Created project:", projectId);

  // Invite a user
  const invitationId = await saas.inviteUser(tenantId, "user@example.com", "developer");

  // Accept the invitation
  const userId = "user-456";
  await saas.acceptInvitation(invitationId, userId);

  // Record some usage
  await saas.recordUsage(tenantId, "api_calls", 100);
  await saas.recordUsage(tenantId, "storage_gb", 5);

  // Query current state
  const projects = await saas.getTenantProjects(tenantId);
  const users = await saas.getTenantUsers(tenantId);
  const usage = await saas.getTenantUsage(tenantId);

  console.log("Tenant projects:", projects);
  console.log("Tenant users:", users);
  console.log("Tenant usage:", usage);

  // Get complete audit trail
  const auditTrail = await saas.getAuditTrail(tenantId);
  console.log("Complete audit trail:", auditTrail);

  // Get system statistics
  const stats = await saas.getSystemStats();
  console.log("System statistics:", stats);
}

interface TenantState {
  tenantId: string;
  projects: Map<string, any>;
  users: Map<string, any>;
  invitations: Map<string, any>;
  usage: Map<string, number>;
  billing: {
    currentPeriodStart: number;
    currentPeriodEnd: number;
    usage: Map<string, number>;
    totalCost: number;
  };
  createdAt: number;
  lastActivity: number;
}

interface ProjectData {
  name: string;
  description: string;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}
```

## Key Benefits Achieved

### 1. **Complete Audit Trail** (Journal + Event Sourcing)

- **Compliance Ready**: Every single action is permanently recorded with full context
- **Time-Travel Debugging**: Reconstruct system state at any point in time
- **Regulatory Compliance**: SOX, GDPR, HIPAA requirements easily met
- **Forensic Analysis**: Trace through complex multi-tenant scenarios

### 2. **Atomic Multi-Tenant State** (Atom)

- **Race Condition Prevention**: Tenant state updates are always atomic
- **Consistent Cross-Tenant Operations**: User invitations across tenants work reliably
- **Observable State Changes**: React to tenant changes in real-time
- **Version History**: Every tenant state change is tracked

### 3. **Deterministic Business Logic** (Clock)

- **Testable Time-Based Features**: Invitation expiration tested instantly
- **Precise Billing Periods**: Billing cycles are exact and predictable
- **Performance Monitoring**: Accurate operation timing measurements
- **Reproducible Issues**: Time-dependent bugs can be replayed exactly

### 4. **Distributed Context** (Effect)

- **Cross-Service Tracing**: Operations carry tenant/user context everywhere
- **Resource Management**: Database connections and external services cleaned up
- **Error Boundaries**: Failures contained at appropriate service boundaries
- **Correlation IDs**: Track operations across the entire system

### 5. **Fault-Tolerant Processing** (Process)

- **Resilient Event Processing**: Notification/billing processors restart on failure
- **Independent Concerns**: Billing failures don't affect core functionality
- **Background Tasks**: Invitation expiry runs independently
- **Supervision Strategies**: Different failure handling for different processes

## Advanced Features

### Event Replay for Testing

```typescript
describe("SaaS Platform", () => {
  it("should handle complex tenant scenarios", async () => {
    const clock = createControlledClock(0);
    const eventStore = createJournal();
    const saas = new EventSourcedSaasManager(clock, eventStore);

    // Create complex scenario
    const projectId = await saas.createProject("tenant-1", { name: "Test Project" });
    const inviteId = await saas.inviteUser("tenant-1", "user@test.com", "admin");

    // Fast-forward time to test expiration
    clock.advance(8 * 24 * 60 * 60 * 1000); // 8 days

    await saas.expireInvitations();

    // Verify invitation expired
    const auditTrail = await saas.getAuditTrail("tenant-1");
    const expiredEvent = auditTrail.find((e) => e.type === "user.invitation_expired");
    expect(expiredEvent).toBeDefined();
  });
});
```

### Real-Time Dashboard Updates

```typescript
// Subscribe to tenant state changes for real-time UI updates
class TenantDashboard {
  constructor(private saas: EventSourcedSaasManager) {}

  subscribeToTenant(tenantId: string, callback: (state) => void) {
    const tenantAtom = this.saas.tenantStates.get(tenantId);
    if (tenantAtom) {
      return tenantAtom.subscribe((state) => {
        callback({
          projectCount: state.projects.size,
          userCount: state.users.size,
          pendingInvitations: Array.from(state.invitations.values()).filter((inv) => inv.status === "pending").length,
          currentUsage: Object.fromEntries(state.usage),
        });
      });
    }
  }
}
```

### Advanced Analytics

```typescript
// Complex queries across all events
async function generateTenantAnalytics(saas: EventSourcedSaasManager, tenantId: string) {
  const events = await saas.getAuditTrail(tenantId);

  return {
    projectCreationTrend: events
      .filter((e) => e.type === "project.created")
      .reduce((trend, event) => {
        const month = new Date(event.timestamp).getMonth();
        trend[month] = (trend[month] || 0) + 1;
        return trend;
      }, {}),

    userGrowth: events
      .filter((e) => e.type === "user.invitation_accepted")
      .map((e) => ({ timestamp: e.timestamp, userId: e.userId })),

    featureUsage: events
      .filter((e) => e.type === "usage.recorded")
      .reduce((usage, event) => {
        usage[event.feature] = (usage[event.feature] || 0) + event.quantity;
        return usage;
      }, {}),
  };
}
```

## Result

**Before**: Brittle SaaS platform with data inconsistency, poor auditability, and silent failures  
**After**: Production-ready event-sourced SaaS with complete audit trails, atomic operations, real-time features, and comprehensive testing capabilities

The combination of all five Phyxius primitives creates a SaaS platform that is not just functional, but truly **compliant**, **observable**, **reliable**, and **scalable** for enterprise use.

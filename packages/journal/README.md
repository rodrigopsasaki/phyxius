# Journal

**Append-only event logs for replay, debugging, and audit trails**

## What is Journal?

Journal provides append-only event logging with powerful replay capabilities. It's an immutable log where events are recorded with timestamps and can be filtered, queried, and replayed to reconstruct system state at any point in time.

Think of Journal as your application's "black box recorder" - capturing every important event so you can understand what happened, when it happened, and replay those events to reproduce any state.

## Why does Journal exist?

Debugging distributed systems, understanding complex state changes, and maintaining audit trails are notoriously difficult. Traditional logging gives you snapshots, but doesn't let you replay events or reconstruct state. Journal solves this by making events first-class citizens.

**The Problem:**

```typescript
// Traditional logging: hard to correlate, no replay capability
class OrderProcessor {
  process(order: Order) {
    console.log(`Processing order ${order.id}`);

    if (this.validateOrder(order)) {
      console.log(`Order ${order.id} validated`);
      this.updateInventory(order);
      console.log(`Inventory updated for order ${order.id}`);
      this.chargeCustomer(order);
      console.log(`Customer charged for order ${order.id}`);
    } else {
      console.log(`Order ${order.id} validation failed`);
    }
  }

  // What if something goes wrong?
  // How do you replay just the failed orders?
  // How do you see the exact sequence of events?
  // How do you audit what happened to a specific order?
}
```

**The Solution:**

```typescript
// Event-driven with replay: complete auditability, reproducible state
class OrderProcessor {
  constructor(private journal: Journal) {}

  async process(order: Order) {
    await this.journal.append({
      type: "order.processing_started",
      orderId: order.id,
      order,
      timestamp: Date.now(),
    });

    if (this.validateOrder(order)) {
      await this.journal.append({
        type: "order.validated",
        orderId: order.id,
        timestamp: Date.now(),
      });

      await this.updateInventory(order);
      await this.chargeCustomer(order);
    } else {
      await this.journal.append({
        type: "order.validation_failed",
        orderId: order.id,
        reason: "insufficient_inventory",
        timestamp: Date.now(),
      });
    }
  }

  // Replay all events for a specific order
  async replayOrder(orderId: string) {
    const events = await this.journal.filter((event) => event.orderId === orderId);

    return events; // Complete audit trail
  }

  // Replay all failed orders
  async getFailedOrders() {
    return await this.journal.filter((event) => event.type === "order.validation_failed");
  }
}
```

## Why is Journal good?

### 1. **Complete Auditability**

Every event is permanently recorded with precise timestamps and metadata.

### 2. **Deterministic Replay**

Reconstruct any state by replaying events in chronological order.

### 3. **Powerful Querying**

Filter events by type, time range, or any custom criteria.

### 4. **Event Sourcing Foundation**

Perfect building block for event sourcing architectures.

### 5. **Debugging Superpower**

Trace through complex flows by following the event chain.

## Usage Examples

### Basic Event Logging

```typescript
import { createJournal } from "@phyxius/journal";

const journal = createJournal();

// Append events
await journal.append({
  type: "user.login",
  userId: "user123",
  timestamp: Date.now(),
  ip: "192.168.1.1",
});

await journal.append({
  type: "user.profile_updated",
  userId: "user123",
  changes: { email: "new@email.com" },
  timestamp: Date.now(),
});

// Get all events
const events = await journal.getAll();
console.log(events);

// Filter events
const userEvents = await journal.filter((event) => event.userId === "user123");
```

### User Activity Tracking

```typescript
interface UserEvent {
  type: string;
  userId: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

class UserActivityTracker {
  constructor(private journal: Journal) {}

  async trackLogin(userId: string, ip: string, userAgent: string) {
    await this.journal.append({
      type: "user.login",
      userId,
      timestamp: Date.now(),
      metadata: { ip, userAgent },
    });
  }

  async trackPageView(userId: string, page: string, duration?: number) {
    await this.journal.append({
      type: "user.page_view",
      userId,
      timestamp: Date.now(),
      metadata: { page, duration },
    });
  }

  async trackPurchase(userId: string, productId: string, amount: number) {
    await this.journal.append({
      type: "user.purchase",
      userId,
      timestamp: Date.now(),
      metadata: { productId, amount },
    });
  }

  // Get user's complete activity timeline
  async getUserTimeline(userId: string) {
    return await this.journal.filter((event) => event.userId === userId);
  }

  // Get activity within time range
  async getActivityInRange(start: number, end: number) {
    return await this.journal.filter((event) => event.timestamp >= start && event.timestamp <= end);
  }

  // Get all purchases
  async getAllPurchases() {
    return await this.journal.filter((event) => event.type === "user.purchase");
  }

  // Calculate daily active users
  async getDailyActiveUsers(date: Date) {
    const startOfDay = new Date(date).setHours(0, 0, 0, 0);
    const endOfDay = new Date(date).setHours(23, 59, 59, 999);

    const events = await this.journal.filter(
      (event) =>
        event.timestamp >= startOfDay &&
        event.timestamp <= endOfDay &&
        (event.type === "user.login" || event.type === "user.page_view"),
    );

    const uniqueUsers = new Set(events.map((event) => event.userId));
    return uniqueUsers.size;
  }
}

// Usage
const tracker = new UserActivityTracker(createJournal());

await tracker.trackLogin("user123", "192.168.1.1", "Mozilla/5.0...");
await tracker.trackPageView("user123", "/dashboard", 45000);
await tracker.trackPurchase("user123", "product-456", 29.99);

// Get complete user timeline
const timeline = await tracker.getUserTimeline("user123");
console.log("User activity:", timeline);

// Analytics
const dau = await tracker.getDailyActiveUsers(new Date());
console.log("Daily active users:", dau);
```

### Financial Transaction Audit

```typescript
interface TransactionEvent {
  type: string;
  transactionId: string;
  accountId: string;
  amount: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

class TransactionJournal {
  constructor(private journal: Journal) {}

  async recordDeposit(transactionId: string, accountId: string, amount: number, source: string) {
    await this.journal.append({
      type: "transaction.deposit",
      transactionId,
      accountId,
      amount,
      timestamp: Date.now(),
      metadata: { source },
    });
  }

  async recordWithdrawal(transactionId: string, accountId: string, amount: number, destination: string) {
    await this.journal.append({
      type: "transaction.withdrawal",
      transactionId,
      accountId,
      amount: -amount, // Negative for withdrawals
      timestamp: Date.now(),
      metadata: { destination },
    });
  }

  async recordTransfer(transactionId: string, fromAccount: string, toAccount: string, amount: number) {
    // Record as two separate but linked events
    await this.journal.append({
      type: "transaction.transfer_out",
      transactionId,
      accountId: fromAccount,
      amount: -amount,
      timestamp: Date.now(),
      metadata: { toAccount },
    });

    await this.journal.append({
      type: "transaction.transfer_in",
      transactionId,
      accountId: toAccount,
      amount: amount,
      timestamp: Date.now(),
      metadata: { fromAccount },
    });
  }

  // Calculate account balance by replaying all transactions
  async calculateBalance(accountId: string, upToTimestamp?: number): Promise<number> {
    const transactions = await this.journal.filter((event) => {
      const isForAccount = event.accountId === accountId;
      const isInTimeRange = !upToTimestamp || event.timestamp <= upToTimestamp;
      const isTransaction = event.type.startsWith("transaction.");

      return isForAccount && isInTimeRange && isTransaction;
    });

    return transactions.reduce((balance, transaction) => balance + transaction.amount, 0);
  }

  // Get complete audit trail for an account
  async getAccountAuditTrail(accountId: string) {
    return await this.journal.filter((event) => event.accountId === accountId);
  }

  // Find all transactions above a certain amount (for compliance)
  async getHighValueTransactions(minAmount: number) {
    return await this.journal.filter((event) => Math.abs(event.amount) >= minAmount);
  }

  // Detect potential fraud patterns
  async detectSuspiciousActivity(accountId: string): Promise<TransactionEvent[]> {
    const transactions = await this.getAccountAuditTrail(accountId);
    const suspicious: TransactionEvent[] = [];

    // Look for rapid large withdrawals
    for (let i = 1; i < transactions.length; i++) {
      const current = transactions[i];
      const previous = transactions[i - 1];

      const isWithdrawal = current.amount < 0;
      const isLarge = Math.abs(current.amount) > 10000;
      const isRapid = current.timestamp - previous.timestamp < 60000; // 1 minute

      if (isWithdrawal && isLarge && isRapid) {
        suspicious.push(current);
      }
    }

    return suspicious;
  }

  // Generate compliance report
  async generateComplianceReport(startDate: Date, endDate: Date) {
    const start = startDate.getTime();
    const end = endDate.getTime();

    const transactions = await this.journal.filter(
      (event) => event.timestamp >= start && event.timestamp <= end && event.type.startsWith("transaction."),
    );

    const totalVolume = transactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const totalTransactions = transactions.length;
    const highValueTransactions = transactions.filter((t) => Math.abs(t.amount) > 10000);

    return {
      period: { start: startDate, end: endDate },
      totalVolume,
      totalTransactions,
      highValueTransactions: highValueTransactions.length,
      details: transactions,
    };
  }
}

// Usage
const txnJournal = new TransactionJournal(createJournal());

// Record transactions
await txnJournal.recordDeposit("tx001", "acc123", 1000, "bank_transfer");
await txnJournal.recordWithdrawal("tx002", "acc123", 50, "atm");
await txnJournal.recordTransfer("tx003", "acc123", "acc456", 200);

// Get current balance by replaying all events
const balance = await txnJournal.calculateBalance("acc123");
console.log("Current balance:", balance); // 750

// Get historical balance
const balanceYesterday = await txnJournal.calculateBalance("acc123", Date.now() - 86400000);

// Compliance and auditing
const auditTrail = await txnJournal.getAccountAuditTrail("acc123");
const suspiciousActivity = await txnJournal.detectSuspiciousActivity("acc123");
const complianceReport = await txnJournal.generateComplianceReport(new Date("2024-01-01"), new Date("2024-01-31"));
```

### Application State Reconstruction

```typescript
interface StateEvent {
  type: string;
  entityId: string;
  changes: Record<string, any>;
  timestamp: number;
}

class EventSourcedEntity {
  constructor(
    private id: string,
    private journal: Journal,
    private initialState: any = {},
  ) {}

  // Apply a change and record it
  async applyChange(type: string, changes: Record<string, any>) {
    await this.journal.append({
      type,
      entityId: this.id,
      changes,
      timestamp: Date.now(),
    });
  }

  // Reconstruct current state by replaying all events
  async getCurrentState() {
    const events = await this.journal.filter((event) => event.entityId === this.id);

    return this.replayEvents(events);
  }

  // Reconstruct state at a specific point in time
  async getStateAt(timestamp: number) {
    const events = await this.journal.filter((event) => event.entityId === this.id && event.timestamp <= timestamp);

    return this.replayEvents(events);
  }

  // Get all changes to this entity
  async getHistory() {
    return await this.journal.filter((event) => event.entityId === this.id);
  }

  private replayEvents(events: StateEvent[]) {
    return events.reduce(
      (state, event) => ({
        ...state,
        ...event.changes,
      }),
      { ...this.initialState },
    );
  }
}

// Usage: Document editing with full history
class Document extends EventSourcedEntity {
  constructor(id: string, journal: Journal) {
    super(id, journal, {
      title: "Untitled",
      content: "",
      lastModified: Date.now(),
      version: 1,
    });
  }

  async updateTitle(title: string) {
    await this.applyChange("document.title_changed", {
      title,
      lastModified: Date.now(),
    });
  }

  async updateContent(content: string) {
    await this.applyChange("document.content_changed", {
      content,
      lastModified: Date.now(),
      version: (await this.getCurrentState()).version + 1,
    });
  }

  async addComment(comment: string, position: number) {
    const comments = (await this.getCurrentState()).comments || [];
    await this.applyChange("document.comment_added", {
      comments: [...comments, { comment, position, timestamp: Date.now() }],
    });
  }
}

// Usage
const doc = new Document("doc123", createJournal());

await doc.updateTitle("My Important Document");
await doc.updateContent("This is the first paragraph.");
await doc.addComment("Great point!", 15);
await doc.updateContent("This is the first paragraph.\nThis is the second paragraph.");

// Get current state
const currentState = await doc.getCurrentState();
console.log("Current document:", currentState);

// Get document state from 1 hour ago
const historicalState = await doc.getStateAt(Date.now() - 3600000);
console.log("Document 1 hour ago:", historicalState);

// Get complete edit history
const history = await doc.getHistory();
console.log("All changes:", history);
```

### System Performance Monitoring

```typescript
interface PerformanceEvent {
  type: string;
  operation: string;
  duration: number;
  success: boolean;
  timestamp: number;
  metadata?: Record<string, any>;
}

class PerformanceJournal {
  constructor(private journal: Journal) {}

  async recordOperation(operation: string, duration: number, success: boolean, metadata?: Record<string, any>) {
    await this.journal.append({
      type: "performance.operation",
      operation,
      duration,
      success,
      timestamp: Date.now(),
      metadata,
    });
  }

  async recordError(operation: string, error: string, metadata?: Record<string, any>) {
    await this.journal.append({
      type: "performance.error",
      operation,
      error,
      timestamp: Date.now(),
      metadata,
    });
  }

  // Analyze performance trends
  async getPerformanceStats(operation: string, timeRangeMs: number = 3600000) {
    const cutoff = Date.now() - timeRangeMs;
    const events = await this.journal.filter(
      (event) => event.operation === operation && event.timestamp >= cutoff && event.type === "performance.operation",
    );

    if (events.length === 0) return null;

    const durations = events.map((e) => e.duration);
    const successful = events.filter((e) => e.success);

    return {
      totalOperations: events.length,
      successfulOperations: successful.length,
      successRate: successful.length / events.length,
      averageDuration: durations.reduce((a, b) => a + b) / durations.length,
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
      p95Duration: this.percentile(durations, 0.95),
      p99Duration: this.percentile(durations, 0.99),
    };
  }

  // Detect performance anomalies
  async detectAnomalies(operation: string) {
    const stats = await this.getPerformanceStats(operation);
    if (!stats) return [];

    const threshold = stats.averageDuration * 3; // 3x average is anomaly
    const cutoff = Date.now() - 3600000; // Last hour

    return await this.journal.filter(
      (event) =>
        event.operation === operation &&
        event.timestamp >= cutoff &&
        event.type === "performance.operation" &&
        event.duration > threshold,
    );
  }

  // Generate performance report
  async generateReport(operations: string[], timeRangeMs: number = 86400000) {
    const report: Record<string, any> = {
      period: timeRangeMs,
      operations: {},
    };

    for (const operation of operations) {
      const stats = await this.getPerformanceStats(operation, timeRangeMs);
      const anomalies = await this.detectAnomalies(operation);

      report.operations[operation] = {
        ...stats,
        anomalies: anomalies.length,
      };
    }

    return report;
  }

  private percentile(values: number[], p: number): number {
    const sorted = values.sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[index];
  }
}

// Usage with instrumentation
class InstrumentedService {
  constructor(private performance: PerformanceJournal) {}

  async performDatabaseQuery(query: string) {
    const start = Date.now();
    try {
      const result = await this.executeQuery(query);
      const duration = Date.now() - start;

      await this.performance.recordOperation("database_query", duration, true, {
        query: query.substring(0, 100), // First 100 chars
      });

      return result;
    } catch (error) {
      const duration = Date.now() - start;

      await this.performance.recordOperation("database_query", duration, false, {
        query: query.substring(0, 100),
      });

      await this.performance.recordError("database_query", error.message, {
        query: query.substring(0, 100),
      });

      throw error;
    }
  }

  private async executeQuery(query: string): Promise<any> {
    // Simulate database query
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));
    return { rows: [] };
  }
}

// Usage
const perfJournal = new PerformanceJournal(createJournal());
const service = new InstrumentedService(perfJournal);

// Execute some operations
await service.performDatabaseQuery("SELECT * FROM users");
await service.performDatabaseQuery("SELECT * FROM orders WHERE date > ?");

// Analyze performance
const stats = await perfJournal.getPerformanceStats("database_query");
console.log("Database query performance:", stats);

const anomalies = await perfJournal.detectAnomalies("database_query");
console.log("Performance anomalies:", anomalies);

const report = await perfJournal.generateReport(["database_query", "api_call"], 86400000);
console.log("24-hour performance report:", report);
```

## API Reference

### Creating Journals

```typescript
const journal = createJournal();
```

### Core Methods

```typescript
// Append an event
await journal.append(event);

// Get all events
const events = await journal.getAll();

// Filter events
const filteredEvents = await journal.filter(predicate);

// Get event count
const count = await journal.getCount();

// Clear all events (use with caution!)
await journal.clear();
```

### Event Structure

Events can be any object, but typically include:

```typescript
interface Event {
  type: string; // Event type identifier
  timestamp: number; // When the event occurred
  [key: string]: any; // Additional event data
}
```

## Testing Patterns

### Testing Event Recording

```typescript
describe("UserRegistration", () => {
  it("should record registration events", async () => {
    const journal = createJournal();
    const service = new UserRegistrationService(journal);

    await service.registerUser("john@example.com");

    const events = await journal.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user.registered");
    expect(events[0].email).toBe("john@example.com");
  });
});
```

### Testing Event Replay

```typescript
describe("StateReconstruction", () => {
  it("should reconstruct state from events", async () => {
    const journal = createJournal();
    const entity = new EventSourcedEntity("test", journal, { value: 0 });

    await entity.applyChange("increment", { value: 5 });
    await entity.applyChange("increment", { value: 10 });
    await entity.applyChange("increment", { value: 15 });

    const finalState = await entity.getCurrentState();
    expect(finalState.value).toBe(15);
  });
});
```

### Testing Event Filtering

```typescript
describe("EventFiltering", () => {
  it("should filter events by criteria", async () => {
    const journal = createJournal();

    await journal.append({ type: "user.login", userId: "user1" });
    await journal.append({ type: "user.logout", userId: "user1" });
    await journal.append({ type: "user.login", userId: "user2" });

    const loginEvents = await journal.filter((e) => e.type === "user.login");
    expect(loginEvents).toHaveLength(2);

    const user1Events = await journal.filter((e) => e.userId === "user1");
    expect(user1Events).toHaveLength(2);
  });
});
```

---

Journal provides the foundation for event-driven architectures. By capturing every important event with complete fidelity, it enables powerful patterns like event sourcing, audit trails, performance monitoring, and deterministic replay. Combined with other Phyxius primitives, it becomes the backbone of observable, debuggable systems.

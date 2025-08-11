# Atom

**Versioned mutable references for safe, observable state management**

## What is Atom?

Atom provides thread-safe mutable references with built-in versioning and change tracking. Unlike simple variables or objects, Atoms maintain a complete history of changes and provide atomic update operations that prevent race conditions and data corruption.

Think of an Atom as a "smart container" for any value that needs to change over time while maintaining complete auditability and consistency.

## Why does Atom exist?

State management in concurrent applications is fraught with race conditions, lost updates, and inconsistent reads. Traditional approaches either sacrifice performance (locks everywhere) or correctness (hope for the best).

**The Problem:**

```typescript
// Dangerous: race conditions, lost updates
let userCount = 0;
let totalRevenue = 0;

async function processOrder(order: Order) {
  // Multiple async operations can interfere with each other
  const currentCount = userCount;
  const currentRevenue = totalRevenue;

  // ... async processing ...

  userCount = currentCount + 1; // Lost update if another operation runs
  totalRevenue = currentRevenue + order.amount; // Same problem
}

// State can become inconsistent
// No way to track what changed when
// No way to roll back or replay changes
```

**The Solution:**

```typescript
// Safe: atomic updates, complete history, observable changes
const userCount = createAtom(0);
const totalRevenue = createAtom(0);

async function processOrder(order: Order) {
  // Atomic updates prevent race conditions
  userCount.update((count) => count + 1);
  totalRevenue.update((revenue) => revenue + order.amount);

  // Or coordinate multiple updates
  const updates = [
    () => userCount.update((count) => count + 1),
    () => totalRevenue.update((revenue) => revenue + order.amount),
  ];

  updates.forEach((update) => update()); // Each update is atomic
}

// Complete auditability
console.log(userCount.getHistory()); // Every change recorded
console.log(userCount.getVersion()); // Current version number

// Observable changes
userCount.subscribe((value) => console.log(`Users: ${value}`));
```

## Why is Atom good?

### 1. **Race Condition Prevention**

All updates are atomic and thread-safe. No more lost updates or data corruption.

### 2. **Complete Auditability**

Every change is recorded with timestamps and version numbers. Perfect for debugging and compliance.

### 3. **Observable Changes**

Subscribe to value changes for reactive programming patterns.

### 4. **STM Ready**

Designed to support Software Transactional Memory for coordinated multi-atom updates.

### 5. **Functional Updates**

Update functions receive the current value and return the new value, making updates predictable and testable.

## Usage Examples

### Basic State Management

```typescript
import { createAtom } from "@phyxius/atom";

// Simple counter
const counter = createAtom(0);

console.log(counter.get()); // 0

counter.set(5);
console.log(counter.get()); // 5

counter.update((n) => n + 1);
console.log(counter.get()); // 6
```

### Configuration Management

```typescript
interface AppConfig {
  apiUrl: string;
  timeout: number;
  retries: number;
  features: Set<string>;
}

const config = createAtom<AppConfig>({
  apiUrl: "https://api.example.com",
  timeout: 5000,
  retries: 3,
  features: new Set(["auth", "logging"]),
});

// Safe updates that preserve type safety
config.update((cfg) => ({
  ...cfg,
  timeout: 10000,
  features: new Set([...cfg.features, "analytics"]),
}));

// Subscribe to config changes
config.subscribe((newConfig) => {
  console.log("Config updated:", newConfig);
  // Reinitialize services with new config
});

// Audit trail
console.log("Config changes:", config.getHistory());
```

### User Session Management

```typescript
interface UserSession {
  userId: string;
  permissions: Set<string>;
  lastActivity: number;
  metadata: Record<string, any>;
}

class SessionManager {
  private sessions = new Map<string, Atom<UserSession>>();

  createSession(userId: string, permissions: string[]): string {
    const sessionId = generateId();
    const session = createAtom<UserSession>({
      userId,
      permissions: new Set(permissions),
      lastActivity: Date.now(),
      metadata: {},
    });

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  updateActivity(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.update((s) => ({
      ...s,
      lastActivity: Date.now(),
    }));

    return true;
  }

  grantPermission(sessionId: string, permission: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.update((s) => ({
      ...s,
      permissions: new Set([...s.permissions, permission]),
    }));

    return true;
  }

  getSession(sessionId: string): UserSession | undefined {
    return this.sessions.get(sessionId)?.get();
  }

  // Get audit trail for a session
  getSessionHistory(sessionId: string) {
    return this.sessions.get(sessionId)?.getHistory() || [];
  }
}

// Usage
const sessionManager = new SessionManager();
const sessionId = sessionManager.createSession("user123", ["read"]);

sessionManager.grantPermission(sessionId, "write");
sessionManager.updateActivity(sessionId);

// Full audit trail available
const history = sessionManager.getSessionHistory(sessionId);
console.log("Session changes:", history);
```

### Shopping Cart

```typescript
interface CartItem {
  productId: string;
  quantity: number;
  price: number;
}

interface Cart {
  items: CartItem[];
  total: number;
  discountCode?: string;
  discountAmount: number;
}

class ShoppingCart {
  private cart = createAtom<Cart>({
    items: [],
    total: 0,
    discountAmount: 0,
  });

  constructor() {
    // Auto-calculate total when cart changes
    this.cart.subscribe((cart) => {
      const itemsTotal = cart.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
      const total = itemsTotal - cart.discountAmount;

      // Only update if total changed to avoid infinite loops
      if (cart.total !== total) {
        this.cart.update((c) => ({ ...c, total }));
      }
    });
  }

  addItem(productId: string, price: number, quantity: number = 1) {
    this.cart.update((cart) => {
      const existingIndex = cart.items.findIndex((item) => item.productId === productId);

      if (existingIndex >= 0) {
        // Update existing item
        const newItems = [...cart.items];
        newItems[existingIndex] = {
          ...newItems[existingIndex],
          quantity: newItems[existingIndex].quantity + quantity,
        };
        return { ...cart, items: newItems };
      } else {
        // Add new item
        return {
          ...cart,
          items: [...cart.items, { productId, quantity, price }],
        };
      }
    });
  }

  removeItem(productId: string) {
    this.cart.update((cart) => ({
      ...cart,
      items: cart.items.filter((item) => item.productId !== productId),
    }));
  }

  applyDiscount(code: string, amount: number) {
    this.cart.update((cart) => ({
      ...cart,
      discountCode: code,
      discountAmount: amount,
    }));
  }

  get() {
    return this.cart.get();
  }

  // Get complete cart history for analytics
  getHistory() {
    return this.cart.getHistory();
  }

  // Subscribe to cart changes for UI updates
  subscribe(callback: (cart: Cart) => void) {
    return this.cart.subscribe(callback);
  }
}

// Usage
const cart = new ShoppingCart();

// Subscribe to changes for UI updates
cart.subscribe((cartState) => {
  updateCartDisplay(cartState);
  trackAnalytics("cart_changed", cartState);
});

cart.addItem("product-1", 29.99, 2);
cart.addItem("product-2", 15.5);
cart.applyDiscount("SAVE10", 5.0);

console.log("Current cart:", cart.get());
console.log("Cart history:", cart.getHistory());
```

### Application State with Undo/Redo

```typescript
interface AppState {
  currentTool: string;
  canvas: CanvasData;
  layers: Layer[];
  selectedLayer: number;
}

class UndoableState {
  private state = createAtom<AppState>(initialState);
  private maxHistorySize = 50;

  getCurrentState() {
    return this.state.get();
  }

  updateState(updater: (state: AppState) => AppState) {
    this.state.update(updater);
    this.pruneHistory();
  }

  undo(): boolean {
    const history = this.state.getHistory();
    if (history.length < 2) return false; // Need at least current + previous

    const previousState = history[history.length - 2].value;
    this.state.set(previousState);
    return true;
  }

  canUndo(): boolean {
    return this.state.getHistory().length > 1;
  }

  getHistory() {
    return this.state.getHistory();
  }

  private pruneHistory() {
    const history = this.state.getHistory();
    if (history.length > this.maxHistorySize) {
      // In a real implementation, you'd want more sophisticated pruning
      // For now, this shows the concept
    }
  }

  // Subscribe to state changes
  subscribe(callback: (state: AppState) => void) {
    return this.state.subscribe(callback);
  }
}

// Usage
const appState = new UndoableState();

// Subscribe to state changes for UI updates
appState.subscribe((state) => {
  renderCanvas(state.canvas);
  updateToolbar(state.currentTool);
  updateLayerPanel(state.layers, state.selectedLayer);
});

// Make changes
appState.updateState((state) => ({
  ...state,
  currentTool: "brush",
}));

appState.updateState((state) => ({
  ...state,
  selectedLayer: 1,
}));

// Undo last change
if (appState.canUndo()) {
  appState.undo();
  console.log("Undid last action");
}
```

### Reactive Data Pipeline

```typescript
// Create atoms for different stages of data processing
const rawData = createAtom<number[]>([]);
const filteredData = createAtom<number[]>([]);
const processedData = createAtom<number[]>([]);
const stats = createAtom({ count: 0, average: 0, max: 0 });

// Set up reactive pipeline
rawData.subscribe((data) => {
  // Filter out negative numbers
  const filtered = data.filter((n) => n >= 0);
  filteredData.set(filtered);
});

filteredData.subscribe((data) => {
  // Apply processing (e.g., normalization)
  const processed = data.map((n) => Math.round(n * 100) / 100);
  processedData.set(processed);
});

processedData.subscribe((data) => {
  // Calculate statistics
  const count = data.length;
  const average = count > 0 ? data.reduce((a, b) => a + b) / count : 0;
  const max = count > 0 ? Math.max(...data) : 0;

  stats.set({ count, average, max });
});

// Subscribe to final results
stats.subscribe((s) => {
  console.log(`Processed ${s.count} items, avg: ${s.average}, max: ${s.max}`);
});

// Feed data into pipeline
rawData.set([1.234, -5, 3.456, 8.9, -2, 10.1]);
// Triggers the entire pipeline automatically
```

### Multi-User Counter (Conflict Resolution)

```typescript
interface CounterState {
  value: number;
  lastUpdatedBy: string;
  conflictResolution: "latest" | "sum";
}

class DistributedCounter {
  private counter = createAtom<CounterState>({
    value: 0,
    lastUpdatedBy: "",
    conflictResolution: "latest",
  });

  constructor(private userId: string) {}

  increment(amount: number = 1) {
    this.counter.update((state) => {
      // Simple conflict resolution: always add
      if (state.conflictResolution === "sum") {
        return {
          ...state,
          value: state.value + amount,
          lastUpdatedBy: this.userId,
        };
      } else {
        // Latest writer wins
        return {
          ...state,
          value: state.value + amount,
          lastUpdatedBy: this.userId,
        };
      }
    });
  }

  // Merge state from another instance (for distributed sync)
  mergeState(otherState: CounterState) {
    this.counter.update((currentState) => {
      if (currentState.conflictResolution === "sum") {
        // Add both values
        return {
          value: currentState.value + otherState.value,
          lastUpdatedBy: `${currentState.lastUpdatedBy},${otherState.lastUpdatedBy}`,
          conflictResolution: "sum",
        };
      } else {
        // Use latest (could use vector clocks in real implementation)
        return otherState;
      }
    });
  }

  get() {
    return this.counter.get();
  }

  getHistory() {
    return this.counter.getHistory();
  }

  subscribe(callback: (state: CounterState) => void) {
    return this.counter.subscribe(callback);
  }
}

// Usage in distributed system
const counter1 = new DistributedCounter("user1");
const counter2 = new DistributedCounter("user2");

counter1.increment(5);
counter2.increment(3);

// Simulate syncing between instances
counter1.mergeState(counter2.get());

console.log("Final state:", counter1.get());
console.log("Change history:", counter1.getHistory());
```

## API Reference

### Creating Atoms

```typescript
const atom = createAtom<T>(initialValue: T, options?: AtomOptions);
```

### Core Methods

```typescript
// Get current value
const value = atom.get();

// Set new value
atom.set(newValue);

// Update with function
atom.update((currentValue) => newValue);

// Get current version
const version = atom.getVersion();

// Get complete history
const history = atom.getHistory();

// Subscribe to changes
const unsubscribe = atom.subscribe((newValue) => {
  console.log("Value changed:", newValue);
});

// Unsubscribe
unsubscribe();
```

### History Entries

Each history entry contains:

```typescript
interface AtomHistoryEntry<T> {
  version: number;
  value: T;
  timestamp: number;
  previousValue?: T;
}
```

## Testing Patterns

### Testing State Changes

```typescript
describe("UserProfile", () => {
  it("should track profile updates", () => {
    const profile = createAtom({ name: "John", age: 30 });

    profile.update((p) => ({ ...p, age: 31 }));

    expect(profile.get().age).toBe(31);
    expect(profile.getVersion()).toBe(2);

    const history = profile.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].value.age).toBe(30);
    expect(history[1].value.age).toBe(31);
  });
});
```

### Testing Subscriptions

```typescript
describe("Reactive Updates", () => {
  it("should notify subscribers", () => {
    const atom = createAtom(0);
    const values: number[] = [];

    atom.subscribe((value) => values.push(value));

    atom.set(1);
    atom.set(2);
    atom.update((n) => n + 1);

    expect(values).toEqual([1, 2, 3]);
  });
});
```

### Testing Concurrent Updates

```typescript
describe("Concurrent Access", () => {
  it("should handle concurrent updates safely", async () => {
    const counter = createAtom(0);

    // Simulate concurrent updates
    const promises = Array.from({ length: 100 }, () => Promise.resolve().then(() => counter.update((n) => n + 1)));

    await Promise.all(promises);

    expect(counter.get()).toBe(100);
    expect(counter.getVersion()).toBe(101); // Initial + 100 updates
  });
});
```

---

Atom provides the foundation for safe, observable state management. By combining atomic updates with complete auditability, it eliminates race conditions while providing the transparency needed for debugging and compliance. Its design makes it perfect for building larger abstractions like Software Transactional Memory systems.

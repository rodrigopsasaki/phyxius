# Atom

**Versioned mutable references for safe, observable state management**

## What is Atom?

Atom provides safe mutable references with built-in versioning and change tracking. Unlike simple variables or objects, Atoms maintain a bounded history of changes and provide atomic update operations relative to the JavaScript event loop.

Think of an Atom as a "smart container" for any value that needs to change over time while maintaining complete auditability and consistency.

## Why does Atom exist?

State management in applications is fraught with race conditions, lost updates, and inconsistent reads. Traditional approaches either sacrifice performance (locks everywhere) or correctness (hope for the best).

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
// Safe: atomic updates, bounded history, observable changes
const clock = createSystemClock();
const userCount = createAtom(0, clock);
const totalRevenue = createAtom(0, clock);

async function processOrder(order: Order) {
  // Atomic updates prevent race conditions within the event loop
  userCount.swap((count) => count + 1);
  totalRevenue.swap((revenue) => revenue + order.amount);

  // Or coordinate multiple updates
  const updates = [
    () => userCount.swap((count) => count + 1),
    () => totalRevenue.swap((revenue) => revenue + order.amount),
  ];

  updates.forEach((update) => update()); // Each update is atomic
}

// Bounded history for recent changes
console.log(userCount.history()); // Recent changes recorded
console.log(userCount.version()); // Current version number

// Observable changes
userCount.watch((change) => console.log(`Users changed: ${change.from} → ${change.to}`));
```

## Why is Atom good?

### 1. **Race Condition Prevention**

All updates are atomic relative to the JavaScript event loop. No more lost updates or data corruption within synchronous execution.

### 2. **Bounded History**

Recent changes are recorded with timestamps and version numbers. Perfect for debugging without memory leaks.

### 3. **Observable Changes**

Watch value changes with synchronous, ordered notifications for reactive programming patterns.

### 4. **STM Ready**

Designed to support Software Transactional Memory for coordinated multi-atom updates.

### 5. **Functional Updates**

Update functions receive the current value and return the new value, making updates predictable and testable.

## Usage Examples

### Basic State Management

```typescript
import { createAtom } from "@phyxius/atom";
import { createSystemClock } from "@phyxius/clock";

// Simple counter requires a clock for deterministic timestamps
const clock = createSystemClock();
const counter = createAtom(0, clock);

console.log(counter.deref()); // 0

counter.reset(5);
console.log(counter.deref()); // 5

counter.swap((n) => n + 1);
console.log(counter.deref()); // 6
```

### Configuration Management

```typescript
interface AppConfig {
  apiUrl: string;
  timeout: number;
  retries: number;
  features: Set<string>;
}

const clock = createSystemClock();
const config = createAtom<AppConfig>(
  {
    apiUrl: "https://api.example.com",
    timeout: 5000,
    retries: 3,
    features: new Set(["auth", "logging"]),
  },
  clock,
);

// Safe updates that preserve type safety
config.swap((cfg) => ({
  ...cfg,
  timeout: 10000,
  features: new Set([...cfg.features, "analytics"]),
}));

// Watch config changes
config.watch((change) => {
  console.log("Config updated:", change.to);
  // Reinitialize services with new config
});

// Recent history
console.log("Config changes:", config.history());
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

  constructor(private clock: Clock) {}

  createSession(userId: string, permissions: string[]): string {
    const sessionId = generateId();
    const session = createAtom<UserSession>(
      {
        userId,
        permissions: new Set(permissions),
        lastActivity: this.clock.now().wallMs,
        metadata: {},
      },
      this.clock,
    );

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  updateActivity(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.swap((s) => ({
      ...s,
      lastActivity: this.clock.now().wallMs,
    }));

    return true;
  }

  grantPermission(sessionId: string, permission: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.swap((s) => ({
      ...s,
      permissions: new Set([...s.permissions, permission]),
    }));

    return true;
  }

  getSession(sessionId: string): UserSession | undefined {
    return this.sessions.get(sessionId)?.deref();
  }

  // Get recent changes for a session
  getSessionHistory(sessionId: string) {
    return this.sessions.get(sessionId)?.history() || [];
  }
}

// Usage
const clock = createSystemClock();
const sessionManager = new SessionManager(clock);
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
  private cart: Atom<Cart>;

  constructor(private clock: Clock) {
    this.cart = createAtom<Cart>(
      {
        items: [],
        total: 0,
        discountAmount: 0,
      },
      clock,
    );
  }

  // Auto-calculate total when cart changes (after constructor)
  private setupAutoCalculation() {
    this.cart.watch((change) => {
      const cart = change.to;
      const itemsTotal = cart.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
      const total = itemsTotal - cart.discountAmount;

      // Only update if total changed to avoid infinite loops
      if (cart.total !== total) {
        this.cart.swap((c) => ({ ...c, total }));
      }
    });
  }

  addItem(productId: string, price: number, quantity: number = 1) {
    this.cart.swap((cart) => {
      const existingIndex = cart.items.findIndex((item) => item.productId === productId);

      if (existingIndex >= 0) {
        // Update existing item
        const newItems = [...cart.items];
        newItems[existingIndex] = {
          ...newItems[existingIndex]!,
          quantity: newItems[existingIndex]!.quantity + quantity,
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
    this.cart.swap((cart) => ({
      ...cart,
      items: cart.items.filter((item) => item.productId !== productId),
    }));
  }

  applyDiscount(code: string, amount: number) {
    this.cart.swap((cart) => ({
      ...cart,
      discountCode: code,
      discountAmount: amount,
    }));
  }

  get() {
    return this.cart.deref();
  }

  // Get recent cart history for analytics
  getHistory() {
    return this.cart.history();
  }

  // Watch cart changes for UI updates
  watch(callback: (change: Change<Cart>) => void) {
    return this.cart.watch(callback);
  }
}

// Usage
const clock = createSystemClock();
const cart = new ShoppingCart(clock);

// Watch changes for UI updates
cart.watch((change) => {
  updateCartDisplay(change.to);
  trackAnalytics("cart_changed", change.to);
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
  private state: Atom<AppState>;
  private maxHistorySize = 50;

  constructor(private clock: Clock) {
    this.state = createAtom<AppState>(initialState, clock);
  }

  getCurrentState() {
    return this.state.deref();
  }

  updateState(updater: (state: AppState) => AppState) {
    this.state.swap(updater);
  }

  undo(): boolean {
    const history = this.state.history();
    if (history.length < 2) return false; // Need at least current + previous

    const previousState = history[history.length - 2]!.value;
    this.state.reset(previousState);
    return true;
  }

  canUndo(): boolean {
    return this.state.history().length > 1;
  }

  getHistory() {
    return this.state.history();
  }

  // Watch state changes
  watch(callback: (change: Change<AppState>) => void) {
    return this.state.watch(callback);
  }
}

// Usage
const clock = createSystemClock();
const appState = new UndoableState(clock);

// Watch state changes for UI updates
appState.watch((change) => {
  renderCanvas(change.to.canvas);
  updateToolbar(change.to.currentTool);
  updateLayerPanel(change.to.layers, change.to.selectedLayer);
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
const clock = createSystemClock();
const rawData = createAtom<number[]>([], clock);
const filteredData = createAtom<number[]>([], clock);
const processedData = createAtom<number[]>([], clock);
const stats = createAtom({ count: 0, average: 0, max: 0 }, clock);

// Set up reactive pipeline
rawData.watch((change) => {
  // Filter out negative numbers
  const filtered = change.to.filter((n) => n >= 0);
  filteredData.reset(filtered);
});

filteredData.watch((change) => {
  // Apply processing (e.g., normalization)
  const processed = change.to.map((n) => Math.round(n * 100) / 100);
  processedData.reset(processed);
});

processedData.watch((change) => {
  // Calculate statistics
  const data = change.to;
  const count = data.length;
  const average = count > 0 ? data.reduce((a, b) => a + b) / count : 0;
  const max = count > 0 ? Math.max(...data) : 0;

  stats.reset({ count, average, max });
});

// Watch final results
stats.watch((change) => {
  const s = change.to;
  console.log(`Processed ${s.count} items, avg: ${s.average}, max: ${s.max}`);
});

// Feed data into pipeline
rawData.reset([1.234, -5, 3.456, 8.9, -2, 10.1]);
// Triggers the entire pipeline automatically
```

## API Reference

### Creating Atoms

```typescript
import { createAtom } from "@phyxius/atom";
import { createSystemClock } from "@phyxius/clock";

const clock = createSystemClock();
const atom = createAtom<T>(initialValue: T, clock, options?: AtomOptions<T>);
```

### Core Methods

```typescript
// Get current value
const value = atom.deref();

// Set new value
atom.reset(newValue);

// Update with function
atom.swap((currentValue) => newValue);

// Compare and set
const success = atom.compareAndSet(expectedValue, newValue);

// Get current version
const version = atom.version();

// Get current snapshot
const snapshot = atom.snapshot();

// Get recent history (bounded)
const history = atom.history();

// Watch changes (synchronous, ordered)
const unsubscribe = atom.watch((change) => {
  console.log(`Value changed: ${change.from} → ${change.to}`);
});

// Unsubscribe
unsubscribe();

// Clear history buffer
atom.clearHistory();
```

### Snapshots and Changes

Each snapshot contains:

```typescript
interface AtomSnapshot<T> {
  readonly value: T;
  readonly version: number;
  readonly at: Instant; // from injected Clock
}
```

Each change contains:

```typescript
interface Change<T> {
  readonly from: T;
  readonly to: T;
  readonly versionFrom: number;
  readonly versionTo: number;
  readonly at: Instant;
  readonly cause?: unknown; // optional metadata
}
```

## Testing Patterns

### Testing State Changes

```typescript
describe("UserProfile", () => {
  it("should track profile updates", () => {
    const clock = createSystemClock();
    const profile = createAtom({ name: "John", age: 30 }, clock);

    profile.swap((p) => ({ ...p, age: 31 }));

    expect(profile.deref().age).toBe(31);
    expect(profile.version()).toBe(1);

    const history = profile.history();
    expect(history).toHaveLength(2);
    expect(history[0]!.value.age).toBe(30);
    expect(history[1]!.value.age).toBe(31);
  });
});
```

### Testing Subscriptions

```typescript
describe("Reactive Updates", () => {
  it("should notify subscribers", () => {
    const clock = createSystemClock();
    const atom = createAtom(0, clock);
    const changes: Change<number>[] = [];

    atom.watch((change) => changes.push(change));

    atom.reset(1);
    atom.reset(2);
    atom.swap((n) => n + 1);

    expect(changes.map((c) => c.to)).toEqual([1, 2, 3]);
  });
});
```

### Testing Concurrent Updates

```typescript
describe("Concurrent Access", () => {
  it("should handle concurrent updates safely", async () => {
    const clock = createSystemClock();
    const counter = createAtom(0, clock);

    // Simulate concurrent updates in the same event loop
    const promises = Array.from({ length: 100 }, () => Promise.resolve().then(() => counter.swap((n) => n + 1)));

    await Promise.all(promises);

    expect(counter.deref()).toBe(100);
    expect(counter.version()).toBe(100); // 100 updates from initial version 0
  });
});
```

---

Atom provides the foundation for safe, observable state management within the JavaScript event loop. By combining atomic updates with bounded history tracking, it eliminates race conditions in synchronous execution while providing the transparency needed for debugging. Its design makes it perfect for building larger abstractions like Software Transactional Memory systems.

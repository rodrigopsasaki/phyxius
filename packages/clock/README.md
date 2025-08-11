# Clock

**Deterministic time control for reliable, testable applications**

## What is Clock?

Clock provides deterministic time control through two implementations: `SystemClock` for real-world time and `ControlledClock` for tests and simulations. Instead of calling `Date.now()` directly, your code uses a clock interface that can be controlled and manipulated.

## Why does Clock exist?

Time-dependent code is notoriously difficult to test and reason about. Race conditions, timing-dependent bugs, and flaky tests often stem from uncontrolled time progression. Clock solves this by making time explicit and controllable.

**The Problem:**

```typescript
// Hard to test, non-deterministic
class SessionManager {
  private sessions = new Map<string, { expires: number }>();

  createSession(userId: string): string {
    const sessionId = generateId();
    this.sessions.set(sessionId, {
      expires: Date.now() + 30 * 60 * 1000, // 30 minutes
    });
    return sessionId;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expires < now) {
        this.sessions.delete(id);
      }
    }
  }
}

// How do you test this? Mock Date.now()? Wait 30 minutes?
```

**The Solution:**

```typescript
// Deterministic, fully testable
class SessionManager {
  constructor(private clock: Clock) {}

  createSession(userId: string): string {
    const sessionId = generateId();
    this.sessions.set(sessionId, {
      expires: this.clock.now() + 30 * 60 * 1000,
    });
    return sessionId;
  }

  cleanupExpired() {
    const now = this.clock.now();
    for (const [id, session] of this.sessions) {
      if (session.expires < now) {
        this.sessions.delete(id);
      }
    }
  }
}
```

## Why is Clock good?

### 1. **Deterministic Testing**

Control time progression in tests for reliable, fast test suites.

### 2. **Replay and Debugging**

Reproduce time-dependent bugs by replaying with the same time sequence.

### 3. **Simulation and Load Testing**

Speed up or slow down time to test long-running processes quickly.

### 4. **Clear Dependencies**

Makes time dependencies explicit in your code architecture.

## Usage Examples

### Basic Usage

```typescript
import { createSystemClock, createControlledClock } from "@phyxius/clock";

// Production: real time
const clock = createSystemClock();
console.log(clock.now()); // 1704063600000

// Testing: controlled time
const testClock = createControlledClock(1000);
console.log(testClock.now()); // 1000

testClock.advance(500);
console.log(testClock.now()); // 1500
```

### Rate Limiting

```typescript
class RateLimiter {
  private attempts = new Map<string, number[]>();

  constructor(
    private clock: Clock,
    private windowMs: number = 60000,
    private maxAttempts: number = 10,
  ) {}

  isAllowed(key: string): boolean {
    const now = this.clock.now();
    const attempts = this.attempts.get(key) || [];

    // Remove old attempts outside window
    const recentAttempts = attempts.filter((time) => now - time < this.windowMs);

    if (recentAttempts.length >= this.maxAttempts) {
      return false;
    }

    // Record this attempt
    recentAttempts.push(now);
    this.attempts.set(key, recentAttempts);
    return true;
  }
}

// Test rate limiting instantly
const rateLimiter = new RateLimiter(createControlledClock(0), 1000, 3);

expect(rateLimiter.isAllowed("user1")).toBe(true);
expect(rateLimiter.isAllowed("user1")).toBe(true);
expect(rateLimiter.isAllowed("user1")).toBe(true);
expect(rateLimiter.isAllowed("user1")).toBe(false); // Rate limited

// Fast-forward past window
testClock.advance(1001);
expect(rateLimiter.isAllowed("user1")).toBe(true); // Allowed again
```

### Cache with TTL

```typescript
class TTLCache<T> {
  private cache = new Map<string, { value: T; expires: number }>();

  constructor(
    private clock: Clock,
    private defaultTTL: number = 300000,
  ) {}

  set(key: string, value: T, ttl?: number): void {
    const expires = this.clock.now() + (ttl ?? this.defaultTTL);
    this.cache.set(key, { value, expires });
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (this.clock.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }
}

// Test cache expiration without waiting
const cache = new TTLCache(createControlledClock(0), 1000);
cache.set("key", "value");

expect(cache.get("key")).toBe("value");

testClock.advance(999);
expect(cache.get("key")).toBe("value"); // Still valid

testClock.advance(2);
expect(cache.get("key")).toBeUndefined(); // Expired
```

### Retry with Backoff

```typescript
class RetryManager {
  constructor(private clock: Clock) {}

  async withRetry<T>(operation: () => Promise<T>, maxAttempts: number = 3, baseDelayMs: number = 1000): Promise<T> {
    let attempt = 1;

    while (attempt <= maxAttempts) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === maxAttempts) throw error;

        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await this.delay(delay);
        attempt++;
      }
    }

    throw new Error("Max attempts reached");
  }

  private async delay(ms: number): Promise<void> {
    const start = this.clock.now();
    return new Promise((resolve) => {
      const check = () => {
        if (this.clock.now() - start >= ms) {
          resolve();
        } else {
          setImmediate(check);
        }
      };
      check();
    });
  }
}

// Test retry logic instantly with ControlledClock
const retryManager = new RetryManager(createControlledClock(0));
let attempts = 0;

const operation = async () => {
  attempts++;
  if (attempts < 3) throw new Error("Temporary failure");
  return "success";
};

// In another async context, advance time to trigger retries
const result = retryManager.withRetry(operation, 3, 100);
testClock.advance(100); // First retry
testClock.advance(200); // Second retry
expect(await result).toBe("success");
```

### Performance Monitoring

```typescript
class PerformanceMonitor {
  private metrics = new Map<string, number[]>();

  constructor(private clock: Clock) {}

  time<T>(operation: string, fn: () => T): T {
    const start = this.clock.now();
    try {
      return fn();
    } finally {
      const duration = this.clock.now() - start;
      this.recordMetric(operation, duration);
    }
  }

  async timeAsync<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = this.clock.now();
    try {
      return await fn();
    } finally {
      const duration = this.clock.now() - start;
      this.recordMetric(operation, duration);
    }
  }

  private recordMetric(operation: string, duration: number): void {
    const metrics = this.metrics.get(operation) || [];
    metrics.push(duration);
    this.metrics.set(operation, metrics);
  }

  getStats(operation: string) {
    const metrics = this.metrics.get(operation) || [];
    if (metrics.length === 0) return null;

    return {
      count: metrics.length,
      avg: metrics.reduce((a, b) => a + b) / metrics.length,
      min: Math.min(...metrics),
      max: Math.max(...metrics),
    };
  }
}

// Test performance monitoring with precise control
const monitor = new PerformanceMonitor(createControlledClock(1000));

monitor.time("operation1", () => {
  testClock.advance(50);
  return "result";
});

monitor.time("operation1", () => {
  testClock.advance(75);
  return "result";
});

const stats = monitor.getStats("operation1");
expect(stats).toEqual({
  count: 2,
  avg: 62.5,
  min: 50,
  max: 75,
});
```

## API Reference

### Clock Interface

```typescript
interface Clock {
  now(): number;
}
```

### SystemClock

Uses real system time via `Date.now()`.

```typescript
const clock = createSystemClock();
clock.now(); // Current timestamp
```

### ControlledClock

Controllable time for testing and simulation.

```typescript
const clock = createControlledClock(initialTime);
clock.now(); // Current controlled time
clock.advance(milliseconds); // Move time forward
clock.set(timestamp); // Set absolute time
```

## Testing Patterns

### Fast Time-based Tests

```typescript
describe("SessionTimeout", () => {
  it("should expire sessions after timeout", () => {
    const clock = createControlledClock(0);
    const session = new SessionManager(clock, 1000); // 1s timeout

    const id = session.create("user");
    expect(session.isValid(id)).toBe(true);

    clock.advance(999);
    expect(session.isValid(id)).toBe(true);

    clock.advance(2);
    expect(session.isValid(id)).toBe(false);
  });
});
```

### Deterministic Race Condition Testing

```typescript
describe("ConcurrentOperations", () => {
  it("should handle operations in precise order", () => {
    const clock = createControlledClock(1000);
    const events: string[] = [];

    setTimeout(() => events.push("A"), 100);
    setTimeout(() => events.push("B"), 200);
    setTimeout(() => events.push("C"), 150);

    clock.advance(100);
    expect(events).toEqual(["A"]);

    clock.advance(50);
    expect(events).toEqual(["A", "C"]);

    clock.advance(50);
    expect(events).toEqual(["A", "C", "B"]);
  });
});
```

---

Clock is the foundation of deterministic systems. By controlling time, you control one of the most chaotic aspects of distributed systems, making your applications more reliable, testable, and debuggable.

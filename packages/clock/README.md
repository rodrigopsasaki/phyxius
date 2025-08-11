# Clock

**Deterministic time control for reliable, testable applications**

## What is Clock?

Clock provides deterministic time control through two implementations: `SystemClock` for real-world time and `ControlledClock` for tests and simulations. Instead of calling `Date.now()` directly, your code uses a clock interface that can be controlled and manipulated.

The `clock.now()` method returns an `Instant` object with two time values:

- **`wallMs`** - Wall clock time (can jump due to system clock changes)
- **`monoMs`** - Monotonic time (never goes backwards, perfect for measuring intervals)

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
      expires: this.clock.now().wallMs + 30 * 60 * 1000,
    });
    return sessionId;
  }

  cleanupExpired() {
    const now = this.clock.now().wallMs;
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

## Non-Goals

Clock is **only** about controlling the progression of time. It deliberately does not handle:

- **No timezones or DST handling** - Use date-fns, Luxon, or Temporal for timezone-aware operations
- **No date parsing or formatting** - Clock works with millisecond timestamps, nothing more
- **No implicit conversion** between monotonic and wall time - You explicitly choose which time to use
- **No hidden globals** - Time flows from the `Clock` instance you pass around, making dependencies explicit

Clock abstracts "what time is it now?" so you can control it. That's all.

## How Clock Differs from Other Solutions

**vs. `jest.useFakeTimers()`:**

- Jest replaces global timers system-wide, Clock uses dependency injection
- Jest can cause interference between tests, Clock instances are isolated
- Jest requires manual `.tick()` calls, Clock can advance time automatically
- Clock separates wall time from monotonic time for more realistic testing

**vs. Manual mocks:**

- Clock provides a complete time abstraction, not just `Date.now()` replacement
- Clock includes timer management (`sleep`, `interval`, `deadline`)
- Clock maintains consistent relationships between wall time and monotonic time

## Usage Examples

### Basic Usage

```typescript
import { createSystemClock, createControlledClock } from "@phyxius/clock";

// Production: real time
const clock = createSystemClock();
console.log(clock.now()); // { wallMs: 1704063600000, monoMs: 42.1 }

// Testing: controlled time
const testClock = createControlledClock({ initialTime: 1000 });
console.log(testClock.now()); // { wallMs: 1000, monoMs: 1000 }

type Millis = number & { readonly __brand: "millis" };
await testClock.advanceBy(500 as Millis);
console.log(testClock.now()); // { wallMs: 1500, monoMs: 1500 }
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
const testClock = createControlledClock({ initialTime: 0 });
const rateLimiter = new RateLimiter(testClock, 1000, 3);

expect(rateLimiter.isAllowed("user1")).toBe(true);
expect(rateLimiter.isAllowed("user1")).toBe(true);
expect(rateLimiter.isAllowed("user1")).toBe(true);
expect(rateLimiter.isAllowed("user1")).toBe(false); // Rate limited

// Fast-forward past window
await testClock.advanceBy(1001 as Millis);
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
    const expires = this.clock.now().wallMs + (ttl ?? this.defaultTTL);
    this.cache.set(key, { value, expires });
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (this.clock.now().wallMs > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }
}

// Test cache expiration without waiting
const testClock = createControlledClock({ initialTime: 0 });
const cache = new TTLCache(testClock, 1000);
cache.set("key", "value");

expect(cache.get("key")).toBe("value");

await testClock.advanceBy(999 as Millis);
expect(cache.get("key")).toBe("value"); // Still valid

await testClock.advanceBy(2 as Millis);
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

> **Note:** For complete type definitions, see [`src/types.ts`](./src/types.ts)

### Core Types

```typescript
type Millis = number & { readonly __brand: "millis" };

interface Instant {
  readonly wallMs: number; // Wall clock time (can jump due to system changes)
  readonly monoMs: number; // Monotonic time (never goes backwards)
}

interface DeadlineTarget {
  readonly wallMs: number; // When the deadline should fire
}

interface TimerHandle {
  cancel(): void;
}
```

### Clock Interface

```typescript
interface Clock {
  now(): Instant;
  sleep(ms: Millis): Promise<void>;
  timeout(ms: Millis): Promise<void>;
  deadline(target: DeadlineTarget): Promise<void>;
  interval(ms: Millis, callback: () => void | Promise<void>): TimerHandle;
}
```

### SystemClock

Uses real system time via `Date.now()` and `performance.now()`.

```typescript
const clock = createSystemClock();
const instant = clock.now(); // { wallMs: 1704063600000, monoMs: 42.1 }
```

### ControlledClock

Extends `Clock` with time manipulation methods for testing.

```typescript
class ControlledClock implements Clock {
  // ... Clock methods ...

  // Additional methods for time control:
  advanceBy(ms: Millis): Promise<void>; // Advance by duration
  advanceTo(targetMono: number): Promise<void>; // Advance to specific monotonic time
  jumpWallTime(newWallMs: number): void; // Jump wall time (keep monotonic continuous)
  tick(): Promise<void>; // Advance to next pending timer
  getPendingTimerCount(): number; // Number of pending timers
}

const clock = createControlledClock({ initialTime: 1000 });
await clock.advanceBy(500 as Millis); // Time manipulation
```

## Testing Patterns

### Fast Time-based Tests

```typescript
describe("SessionTimeout", () => {
  it("should expire sessions after timeout", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const session = new SessionManager(clock, 1000); // 1s timeout

    const id = session.create("user");
    expect(session.isValid(id)).toBe(true);

    await clock.advanceBy(999 as Millis);
    expect(session.isValid(id)).toBe(true);

    await clock.advanceBy(2 as Millis);
    expect(session.isValid(id)).toBe(false);
  });
});
```

### Deterministic Race Condition Testing

```typescript
describe("ConcurrentOperations", () => {
  it("should handle operations in precise order", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const events: string[] = [];

    // Use Clock's methods instead of global timers
    clock.sleep(100 as Millis).then(() => events.push("A"));
    clock.sleep(200 as Millis).then(() => events.push("B"));
    clock.sleep(150 as Millis).then(() => events.push("C"));

    await clock.advanceBy(100 as Millis);
    expect(events).toEqual(["A"]);

    await clock.advanceBy(50 as Millis);
    expect(events).toEqual(["A", "C"]);

    await clock.advanceBy(50 as Millis);
    expect(events).toEqual(["A", "C", "B"]);
  });
});
```

---

Clock is the foundation of deterministic systems. By controlling time, you control one of the most chaotic aspects of distributed systems, making your applications more reliable, testable, and debuggable.

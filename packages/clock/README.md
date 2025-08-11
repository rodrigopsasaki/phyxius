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

## Which Time Do I Use?

Clock provides two time values in every `Instant`. Here's when to use each:

### Use `wallMs` for:

- **TTLs and expiration**: Session expiry, cache expiration, token validity
- **Business rules tied to human time**: "Orders placed after 5 PM ship tomorrow"
- **Scheduling and calendar operations**: "Run this job at 3 AM daily"
- **Logging and audit trails**: When events actually happened in the real world
- **API rate limiting**: "100 requests per hour" based on wall clock time

### Use `monoMs` for:

- **Performance measurement**: Timing how long operations take
- **Timeouts and intervals**: "Retry after 5 seconds", "Poll every 10ms"
- **SLA monitoring**: Measuring response times, uptime calculations
- **Deadlines relative to now**: "Timeout this request in 30 seconds"
- **Animation and game loops**: Smooth, consistent timing that can't go backwards

### Quick Examples:

```typescript
const clock = createSystemClock();
const now = clock.now();

// Cache expiration (wall time - can be affected by clock adjustments)
const expiresAt = now.wallMs + 30 * 60 * 1000; // 30 minutes from now

// Performance measurement (monotonic - never affected by clock adjustments)
const start = now.monoMs;
// ... do work ...
const duration = clock.now().monoMs - start; // Always positive, never jumps
```

## Usage Examples

### Basic Usage

```typescript
import { createSystemClock, createControlledClock, ms } from "@phyxius/clock";

// Production: real time
const clock = createSystemClock();
console.log(clock.now()); // { wallMs: 1704063600000, monoMs: 42.1 }

// Testing: controlled time (defaults to 0 for deterministic tests)
const testClock = createControlledClock({ initialTime: 1000 });
console.log(testClock.now()); // { wallMs: 1000, monoMs: 1000 }

// Use ms() helper to avoid casting noise
testClock.advanceBy(ms(500));
console.log(testClock.now()); // { wallMs: 1500, monoMs: 1500 }
```

### Interval Cancellation

```typescript
import { createSystemClock, ms } from "@phyxius/clock";

const clock = createSystemClock();
let count = 0;

// Create an interval
const handle = clock.interval(ms(1000), () => {
  count++;
  console.log(`Tick ${count}`);

  // Cancel after 5 ticks
  if (count >= 5) {
    handle.cancel();
    console.log("Interval cancelled");
  }
});

// Or cancel from outside
setTimeout(() => {
  handle.cancel();
  console.log("Cancelled early");
}, 3000);
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
    const now = this.clock.now().wallMs;
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
testClock.advanceBy(ms(1001));
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

testClock.advanceBy(ms(999));
expect(cache.get("key")).toBe("value"); // Still valid

testClock.advanceBy(ms(2));
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
    const start = this.clock.now().monoMs;
    return new Promise((resolve) => {
      const check = () => {
        if (this.clock.now().monoMs - start >= ms) {
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
const testClock = createControlledClock({ initialTime: 0 });
const retryManager = new RetryManager(testClock);
let attempts = 0;

const operation = async () => {
  attempts++;
  if (attempts < 3) throw new Error("Temporary failure");
  return "success";
};

// In another async context, advance time to trigger retries
const result = retryManager.withRetry(operation, 3, 100);
testClock.advanceBy(ms(100)); // First retry
testClock.advanceBy(ms(200)); // Second retry
expect(await result).toBe("success");
```

### Performance Monitoring

```typescript
class PerformanceMonitor {
  private metrics = new Map<string, number[]>();

  constructor(private clock: Clock) {}

  time<T>(operation: string, fn: () => T): T {
    const start = this.clock.now().monoMs;
    try {
      return fn();
    } finally {
      const duration = this.clock.now().monoMs - start;
      this.recordMetric(operation, duration);
    }
  }

  async timeAsync<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = this.clock.now().monoMs;
    try {
      return await fn();
    } finally {
      const duration = this.clock.now().monoMs - start;
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
const testClock = createControlledClock({ initialTime: 1000 });
const monitor = new PerformanceMonitor(testClock);

monitor.time("operation1", () => {
  testClock.advanceBy(ms(50));
  return "result";
});

monitor.time("operation1", () => {
  testClock.advanceBy(ms(75));
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
  advanceBy(ms: Millis): void; // Advance by duration (synchronous)
  advanceTo(targetMono: number): void; // Advance to specific monotonic time (synchronous)
  jumpWallTime(newWallMs: number): void; // Jump wall time (keep monotonic continuous)
  tick(): void; // Advance to next pending timer (synchronous)
  getPendingTimerCount(): number; // Number of pending timers
  flush(): Promise<void>; // Await completion of fired callbacks
}

const clock = createControlledClock({ initialTime: 1000 });
clock.advanceBy(ms(500)); // Time manipulation (synchronous)
await clock.flush(); // Wait for callbacks to complete
```

## Testing Patterns

### Fast Time-based Tests

```typescript
describe("SessionTimeout", () => {
  it("should expire sessions after timeout", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const session = new SessionManager(clock, 1000); // 1s timeout

    const id = session.create("user");
    expect(session.isValid(id)).toBe(true);

    clock.advanceBy(ms(999));
    expect(session.isValid(id)).toBe(true);

    clock.advanceBy(ms(2));
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
    clock.sleep(ms(100)).then(() => events.push("A"));
    clock.sleep(ms(200)).then(() => events.push("B"));
    clock.sleep(ms(150)).then(() => events.push("C"));

    clock.advanceBy(ms(100));
    await clock.flush();
    expect(events).toEqual(["A"]);

    clock.advanceBy(ms(50));
    await clock.flush();
    expect(events).toEqual(["A", "C"]);

    clock.advanceBy(ms(50));
    await clock.flush();
    expect(events).toEqual(["A", "C", "B"]);
  });
});
```

---

Clock is the foundation of deterministic systems. By controlling time, you control one of the most chaotic aspects of distributed systems, making your applications more reliable, testable, and debuggable.

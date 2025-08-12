# Clock

**Time you can reason about. Time you can test. Time that works.**

Time is the root of all chaos in software. Race conditions, flaky tests, production bugs that only happen "sometimes" - they all trace back to time being unpredictable.

Clock fixes this. Two implementations, same interface. Real time for production, controlled time for tests.

## The Problem

```typescript
// This is broken. You just don't know it yet.
setTimeout(() => {
  console.log("I hope this runs when I think it does");
}, 1000);

// In tests? Forget about it.
it("should timeout after 1 second", async () => {
  // Actually waits 1 second. Every. Single. Time.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(something).toBe(true);
});
```

The real world has NTP corrections, system sleep, clock drift, and a thousand other ways time can surprise you. Your code assumes time is linear. It's not.

## The Solution

```typescript
import { createSystemClock, ms } from "@phyxius/clock";

const clock = createSystemClock();

// Two times: wall time (can jump) and mono time (never backwards)
const now = clock.now();
console.log("Wall time:", now.wallMs); // Can jump due to NTP
console.log("Mono time:", now.monoMs); // Monotonic, perfect for intervals
```

Clock gives you **two time tracks**:

- **Wall time** (`wallMs`) - Real world time. Can jump forwards or backwards due to NTP corrections, timezone changes, manual clock adjustments.
- **Monotonic time** (`monoMs`) - Interval time. Never goes backwards. Perfect for measuring durations.

## Start Simple: Basic Sleep

```typescript
import { createSystemClock, ms } from "@phyxius/clock";

const clock = createSystemClock();

// Sleep for 100ms
await clock.sleep(ms(100));

// That's it. No more setTimeout.
```

The `ms()` function creates a branded `Millis` type. This prevents you from accidentally mixing milliseconds with other numbers:

```typescript
const delay = ms(1000);
const count = 42;

await clock.sleep(delay); // ✅ Works
await clock.sleep(count); // ❌ Type error - can't mix units
```

## Add Deadlines: Wall Time Targets

```typescript
const clock = createSystemClock();

// Schedule something for exactly 3pm
const target = { wallMs: new Date("2024-01-01T15:00:00Z").getTime() };
await clock.deadline(target);

console.log("It's 3pm!");
```

Deadlines use wall time because you care about _when_ something happens in the real world, not how much time has elapsed.

## Add Intervals: Repeating Actions

```typescript
const clock = createSystemClock();

// Run something every 5 seconds
const handle = clock.interval(ms(5000), () => {
  console.log("Tick", clock.now().wallMs);
});

// Later, stop it
handle.cancel();
```

Intervals use monotonic time internally, so they never drift or accumulate timing errors. If a callback takes longer than the interval, the next one waits - no overlapping execution.

## Observability: See Everything

```typescript
const clock = createSystemClock({
  emit: (event) => console.log("Clock event:", event),
});

await clock.sleep(ms(100));
// Clock event: { type: "time:sleep:start", durationMs: 100, at: { ... } }
// Clock event: { type: "time:sleep:end", durationMs: 100, actualMs: 102, at: { ... } }

const handle = clock.interval(ms(1000), () => {
  // Do work
});
// Clock event: { type: "time:interval:set", intervalMs: 1000, at: { ... } }
// Clock event: { type: "time:interval:tick", intervalMs: 1000, tick: 1, at: { ... } }
// Clock event: { type: "time:interval:tick", intervalMs: 1000, tick: 2, at: { ... } }

handle.cancel();
// Clock event: { type: "time:interval:cancel", intervalMs: 1000, ticks: 2, at: { ... } }
```

Every operation emits structured events. Perfect for debugging, monitoring, and understanding what your time-dependent code is actually doing.

## Testing: Control Time

```typescript
import { createControlledClock, ms } from "@phyxius/clock";

const clock = createControlledClock({ initialTime: 0 });

// Start at time 0
console.log(clock.now().monoMs); // 0

// Jump forward instantly
clock.advanceBy(ms(1000));
console.log(clock.now().monoMs); // 1000

// Or jump to a specific time
clock.advanceTo(5000);
console.log(clock.now().monoMs); // 5000
```

No more `setTimeout` in tests. No more waiting. Jump to any moment instantly.

## Advanced Testing: Timer Queues

```typescript
const clock = createControlledClock();

// Schedule multiple things
const promises = [clock.sleep(ms(100)), clock.sleep(ms(200)), clock.sleep(ms(150))];

// Nothing has resolved yet
console.log(clock.getPendingTimerCount()); // 3

// Advance to 150ms - two timers fire
clock.advanceTo(150);
console.log(clock.getPendingTimerCount()); // 1

// Finish the last one
clock.advanceTo(200);
console.log(clock.getPendingTimerCount()); // 0

// All promises are now resolved
const results = await Promise.all(promises);
```

The controlled clock maintains a sorted timer queue. When you advance time, all due timers fire in the correct order, instantly.

## Wall Time Jumps: Simulate NTP

```typescript
const clock = createControlledClock({ initialTime: 1000 });

console.log(clock.now().wallMs); // 1000
console.log(clock.now().monoMs); // 1000

// Simulate NTP correction - wall time jumps backwards
clock.jumpWallTime(500);

console.log(clock.now().wallMs); // 500 (jumped backwards)
console.log(clock.now().monoMs); // 1000 (unchanged)

// Advance monotonic time
clock.advanceBy(ms(100));

console.log(clock.now().wallMs); // 600 (500 + 100)
console.log(clock.now().monoMs); // 1100 (1000 + 100)
```

Wall time can jump independently of monotonic time. This lets you test how your code handles NTP corrections, timezone changes, and manual clock adjustments.

## DST Protection: Duration Tracking That Works

```typescript
const clock = createControlledClock();

// Start tracking a process at 1:30 AM on DST transition day
const startWall = 1_699_156_200_000; // 1:30 AM, Nov 5, 2023 (before fall-back)
const startMono = 10_000;

clock.jumpWallTime(startWall);
clock.advanceTo(startMono);

const start = clock.now();
console.log("Process started:");
console.log("  Wall time:", new Date(start.wallMs).toISOString());
console.log("  Mono time:", start.monoMs);

// Process runs for 2 hours of monotonic time
clock.advanceBy(ms(2 * 60 * 60 * 1000)); // 2 hours

const end = clock.now();

// Calculate duration using wall time (WRONG!)
const wallDuration = end.wallMs - start.wallMs;

// Calculate duration using monotonic time (CORRECT!)
const monoDuration = end.monoMs - start.monoMs;

console.log("\nAfter 2 hours of real work:");
console.log("  Wall time:", new Date(end.wallMs).toISOString());
console.log("  Mono time:", end.monoMs);

console.log("\nDuration calculations:");
console.log("  Wall time duration:", wallDuration / 1000 / 60, "minutes");
console.log("  Mono time duration:", monoDuration / 1000 / 60, "minutes");

// Simulate DST fall-back during the process
// Wall time jumps back 1 hour at 2:00 AM
clock.jumpWallTime(end.wallMs - 60 * 60 * 1000); // Jump back 1 hour

const afterDST = clock.now();
console.log("\nAfter DST fall-back:");
console.log("  Wall time:", new Date(afterDST.wallMs).toISOString());
console.log("  Mono time:", afterDST.monoMs);

// Recalculate durations
const wallDurationAfterDST = afterDST.wallMs - start.wallMs;
const monoDurationAfterDST = afterDST.monoMs - start.monoMs;

console.log("\nDuration after DST shift:");
console.log("  Wall time duration:", wallDurationAfterDST / 1000 / 60, "minutes"); // 60 minutes (WRONG!)
console.log("  Mono time duration:", monoDurationAfterDST / 1000 / 60, "minutes"); // 120 minutes (CORRECT!)
```

When DST "falls back," wall time repeats an hour. A 2-hour process that spans the transition would appear to take only 1 hour if you use wall time for duration. Monotonic time never goes backwards, so it gives you the true elapsed time.

## Perfect Intervals: No Drift, No Overlap

```typescript
const clock = createControlledClock();
const events: number[] = [];

const handle = clock.interval(ms(100), () => {
  events.push(clock.now().monoMs);
});

// Advance by 350ms
clock.advanceBy(ms(350));

console.log(events); // [100, 200, 300]

// Intervals fire at exactly 100ms intervals
// No accumulating drift, no timing errors
```

Even if callbacks take time to execute, the next interval waits. No overlapping, no cascading delays.

## Error Handling: Intervals That Don't Break

```typescript
const clock = createControlledClock({
  emit: (event) => {
    if (event.type === "time:interval:error") {
      console.log("Callback failed:", event.error);
    }
  },
});

const handle = clock.interval(ms(100), () => {
  throw new Error("Oops");
});

// Advance time - the interval keeps running despite errors
clock.advanceBy(ms(300));

// Still firing - errors don't stop the interval
console.log(clock.getPendingTimerCount()); // 1 (still active)
```

Intervals are resilient. If a callback throws or rejects, the interval keeps going. Errors are emitted as events for observability.

## Production Monitoring: Real System Timers

```typescript
import { createSystemClock, ms } from "@phyxius/clock";

const clock = createSystemClock({
  emit: (event) => {
    if (event.type === "time:deadline:err") {
      // We missed a deadline - system is under load
      console.warn("Deadline missed:", {
        target: event.targetMs,
        actual: event.actualMs,
        drift: event.driftMs,
      });
    }

    if (event.type === "time:interval:tick") {
      // Interval fired - system is healthy
      metrics.increment("interval.tick", {
        interval: event.intervalMs,
      });
    }
  },
});

// Monitor critical deadlines
const deadline = { wallMs: Date.now() + 5000 };
await clock.deadline(deadline);
// If this fires late, you'll know via the emit function
```

In production, the system clock uses real Node.js timers but adds complete observability. See exactly when timers fire, how much they drift, and when deadlines are missed.

## The Full Power: Time-Based State Machines

```typescript
import { createControlledClock, ms } from "@phyxius/clock";

class ConnectionManager {
  private clock: Clock;
  private reconnectHandle?: TimerHandle;
  private heartbeatHandle?: TimerHandle;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async connect() {
    // Connect with timeout
    const deadline = {
      wallMs: this.clock.now().wallMs + 5000,
    };

    const connection = await Promise.race([
      this.attemptConnection(),
      this.clock.deadline(deadline).then(() => Promise.reject(new Error("Connection timeout"))),
    ]);

    // Start heartbeat
    this.heartbeatHandle = this.clock.interval(ms(30000), () => {
      this.sendHeartbeat();
    });

    return connection;
  }

  scheduleReconnect() {
    this.heartbeatHandle?.cancel();

    // Exponential backoff
    const delay = ms(Math.min(30000, 1000 * Math.pow(2, this.retryCount)));

    this.reconnectHandle = this.clock.interval(delay, () => {
      this.connect().catch(() => this.scheduleReconnect());
    });
  }
}

// In tests - control time completely
const clock = createControlledClock();
const manager = new ConnectionManager(clock);

// Simulate connection timeout
const connectPromise = manager.connect();
clock.advanceBy(ms(6000)); // Force timeout
await expect(connectPromise).rejects.toThrow("Connection timeout");

// Simulate reconnection backoff
manager.scheduleReconnect();
clock.advanceBy(ms(1000)); // First retry
clock.advanceBy(ms(2000)); // Second retry
clock.advanceBy(ms(4000)); // Third retry
// Perfect control over complex timing scenarios
```

This is where Clock shows its full power. Complex state machines with timeouts, retries, heartbeats, and backoff become completely deterministic and testable.

## Interface

```typescript
interface Clock {
  now(): Instant;
  sleep(ms: Millis): Promise<void>;
  timeout(ms: Millis): Promise<void>; // Alias for sleep
  deadline(target: DeadlineTarget): Promise<void>;
  interval(ms: Millis, callback: () => void | Promise<void>): TimerHandle;
}

interface Instant {
  wallMs: number; // Wall clock time - can jump
  monoMs: number; // Monotonic time - never backwards
}

interface DeadlineTarget {
  wallMs: number; // When to fire (wall time)
}

interface TimerHandle {
  cancel(): void;
}

type Millis = number & { readonly __brand: "millis" };
const ms = (n: number): Millis => n as Millis;
```

## Installation

```bash
npm install @phyxius/clock
```

## What You Get

**Time you can reason about.** Two tracks - wall time for scheduling, monotonic time for intervals. No more confusion about which time to use when.

**Time you can test.** Jump to any moment instantly. Complex timing scenarios become trivial to set up and verify.

**Time that works in production.** Complete observability into timing behavior. See exactly when things fire and how much they drift.

Clock solves time. Everything else builds on that foundation.

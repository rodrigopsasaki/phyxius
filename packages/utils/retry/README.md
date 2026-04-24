# Retry

Retry policies as data, not as ad-hoc loops. Clock-driven delays, AbortSignal-aware, structured outcomes.

---

## What this really is

A retry policy is a value you construct, inspect, pass around, serialize if you want. `runWithRetry(fn, policy, clock)` interprets it.

Three factories cover most needs:

- `retry.none()` — explicit "I decided not to retry"
- `retry.fixed(...)` — constant delay between attempts
- `retry.exponential(...)` — exponential backoff with optional jitter and max cap

The delay between attempts is always paced by the injected `Clock`, so retry timing is deterministic under `createControlledClock`.

---

## Installation

```bash
npm install @phyxiusjs/retry @phyxiusjs/clock @phyxiusjs/fp
```

---

## Quick start

```ts
import { retry, runWithRetry } from "@phyxiusjs/retry";
import { createSystemClock, ms } from "@phyxiusjs/clock";
import { isOk } from "@phyxiusjs/fp";

const clock = createSystemClock();

const policy = retry.exponential({
  maxAttempts: 5,
  initialDelay: ms(100),
  maxDelay: ms(5_000),
  factor: 2,
  jitter: 0.2, // ±20%
});

const result = await runWithRetry(async () => fetch("/api/charge").then((r) => r.json()), policy, clock);

if (isOk(result)) {
  console.log("charged:", result.value);
} else {
  // result.error is a RetryError — typed outcome, not a generic Error.
  switch (result.error.type) {
    case "EXHAUSTED":
      console.log(`failed after ${result.error.attempts} attempts`);
      break;
    case "REJECTED":
      console.log("shouldRetry predicate rejected");
      break;
    case "ABORTED":
      console.log("cancelled via signal");
      break;
  }
}
```

---

## Policies

### `retry.none()`

Runs the function exactly once. Use when you want to declare "I've decided not to retry" explicitly — the declaration is the whole point.

```ts
const policy = retry.none();
// policy.maxAttempts === 1
```

### `retry.fixed({ maxAttempts, delay, shouldRetry? })`

Constant delay between attempts.

```ts
const policy = retry.fixed({
  maxAttempts: 3,
  delay: ms(200),
});
// attempt 1 → wait 200ms → attempt 2 → wait 200ms → attempt 3
```

### `retry.exponential({ maxAttempts, initialDelay, maxDelay?, factor?, jitter?, shouldRetry? })`

Exponential backoff. Delay before attempt N (N ≥ 2):

```
min(maxDelay, initialDelay * factor^(N-2)) * (1 ± jitter)
```

```ts
const policy = retry.exponential({
  maxAttempts: 5,
  initialDelay: ms(100),
  maxDelay: ms(10_000), // default 30_000
  factor: 2, // default 2
  jitter: 0.1, // default 0 (no jitter)
});
// Delays: 100, 200, 400, 800 (all within maxDelay)
```

### Custom predicates via `shouldRetry`

Either factory accepts a `shouldRetry(error, attempt)` predicate. Returning `false` stops retrying and returns `Err({ type: "REJECTED", ... })` instead of exhausting attempts:

```ts
const policy = retry.fixed({
  maxAttempts: 5,
  delay: ms(100),
  shouldRetry: (error) => {
    // Don't retry 4xx errors — they won't get better.
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      return false;
    }
    return true;
  },
});
```

---

## Outcomes

```ts
type RetryError =
  | { type: "EXHAUSTED"; attempts: number; lastError: unknown }
  | { type: "REJECTED"; attempts: number; error: unknown }
  | { type: "ABORTED"; attempts: number; lastError: unknown };
```

- **EXHAUSTED** — `maxAttempts` all threw, with the last error attached
- **REJECTED** — `shouldRetry` returned `false`; the predicate said stop
- **ABORTED** — an `AbortSignal` aborted during an inter-attempt wait

Every failure mode is a typed value. No `throw` escapes `runWithRetry` except rethrows you explicitly trigger.

---

## Cancellation

Pass an `AbortSignal` to cancel mid-retry:

```ts
const controller = new AbortController();

setTimeout(() => controller.abort(), 5_000);

const result = await runWithRetry(
  async () => flakyOperation(),
  retry.exponential({ maxAttempts: 10, initialDelay: ms(500) }),
  clock,
  { signal: controller.signal },
);
// If the retry wait is in progress when abort fires, the wait short-circuits
// and result is Err({ type: "ABORTED", ... }).
```

Pairs naturally with `@phyxiusjs/clock`'s `Budget`:

```ts
const budget = clock.timeout(ms(30_000));
const result = await runWithRetry(fn, policy, clock, { signal: budget.signal });
budget.release();
```

The retry loop will abort if the overall budget runs out.

---

## Deterministic testing

```ts
import { createControlledClock, ms } from "@phyxiusjs/clock";

const clock = createControlledClock();
const fn = vi.fn(async () => {
  throw new Error("fail");
});

const promise = runWithRetry(fn, retry.fixed({ maxAttempts: 3, delay: ms(100) }), clock);

// Attempt 1 runs immediately (no preceding delay).
await Promise.resolve();
expect(fn).toHaveBeenCalledTimes(1);

// Advance past the first retry delay.
clock.advanceBy(ms(100));
await clock.flush();
expect(fn).toHaveBeenCalledTimes(2);

// And the second.
clock.advanceBy(ms(100));
await clock.flush();

const result = await promise;
// result is Err({ type: "EXHAUSTED", attempts: 3, lastError: ... })
```

No real time passes. No flaky backoff tests.

---

## API

```ts
interface RetryPolicy {
  maxAttempts: number;
  delay(attempt: number): Millis; // 1-based; delay(1) === 0
  shouldRetry?(error: unknown, attempt: number): boolean;
}

const retry: {
  none(): RetryPolicy;
  fixed(options: { maxAttempts; delay; shouldRetry? }): RetryPolicy;
  exponential(options: { maxAttempts; initialDelay; maxDelay?; factor?; jitter?; shouldRetry? }): RetryPolicy;
};

function runWithRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  clock: Clock,
  options?: { signal?: AbortSignal },
): Promise<Result<T, RetryError>>;
```

---

## What this does NOT do

- **No circuit breaker.** That's `@phyxiusjs/circuit-breaker` — use them together when you want "retry a few times, then fail fast." The retry policy retries; the circuit breaker decides whether to try at all.
- **No jitter types other than multiplicative.** `jitter: 0.2` means `delay * (1 ± 0.2)`. No full-random, no decorrelated jitter. If you need those, the policy interface is open enough to implement custom `delay`.
- **No per-error backoff overrides.** The policy's `delay` takes attempt number, not the error. If you need error-aware delays, inspect the error in `shouldRetry` and use multiple calls.

---

## What you get

- **Policies as values** you can build, pass, and reason about.
- **Clock-driven waits** — deterministic under `createControlledClock`.
- **AbortSignal integration** — cancel mid-retry without racing against timers.
- **Structured outcomes** — every failure is a named, typed value.

A retry is a decision. This library makes that decision a thing you hold, not a pattern you copy-paste.

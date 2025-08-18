# Clock

Make time explicit, testable, and observable.

Real systems deal with NTP corrections, leap seconds, DST shifts, VM migrations, system sleep, and clock drift. Your code often assumes time is a straight line. It is not.

Clock does not prevent those jumps. It makes them visible, gives you a linear timeline for measuring durations, and lets you test how your code behaves when the clock moves in surprising ways. Think of it as a seatbelt for time.

Two implementations, one interface:

- System clock for production use, with wall time and monotonic time.
- Controlled clock for tests, with instant jumps and simulated anomalies.

---

## Why time can be flaky

### External synchronization and adjustments

- **NTP corrections**: containers inherit the host’s time, so any host NTP adjustment propagates inside.
- **Daylight Saving Time (DST)**: changes the local representation and can affect apps that do not stick to UTC.
- **Manual host clock changes**: rare in production but possible during maintenance.
- **Cloud provider host adjustments**: the underlying VM host can receive a time correction from the provider’s infrastructure.

### Virtualization and orchestration factors

- **Host and guest clock desynchronization**: especially if NTP is disabled or drift is significant.
- **Paused and resumed containers or nodes**: clock jumps when resuming after suspension.
- **Live migration between hosts**: in Kubernetes or cloud-managed environments, pods or VMs may be migrated to hosts with slightly different clocks.

### System-level quirks and anomalies

- **Leap seconds**: occasionally inserted or removed from UTC and can cause a repeated second or a time step if the kernel does not smear or handle it smoothly.
- **Kernel or container runtime bugs**: rare, but timekeeping code can misbehave under certain workloads.

---

## The Problem

You know that flaky test you have? The one that passes most of the time but fails “randomly”? This may be why.

```ts
// Schedule an auction to end in 60 seconds
const endAt = Date.now() + 60_000;

setTimeout(() => {
  if (Date.now() >= endAt) {
    closeAuction();
  }
}, 60_000);
```

This works until the clock moves.

- Forward jump: NTP correction, leap second mishandling, VM migration. Your auction ends early.
- Backward jump: system sleep, manual clock adjustment. Your auction ends late or never closes.

In tests, the same problem hides in plain sight:

```ts
it("should close the auction after 1 minute", async () => {
  const auction = new Auction();
  auction.start();

  await new Promise((resolve) => setTimeout(resolve, 60_000));
  expect(auction.isClosed()).toBe(true);
});
```

This passes until some unrelated test, slow CI run, or host-level clock adjustment shifts the wall clock in the middle of execution. The test becomes “sometimes red, sometimes green,” and you never trust it again.

---

## Clock helps you with this

### Example 1 — Measuring elapsed time without wall clock drift

```ts
const start = clock.now();
await clock.sleep(ms(500));
const end = clock.now();

const elapsed = end.monoMs - start.monoMs; // immune to NTP/DST jumps
```

### Example 2 — Simulating an NTP correction in tests

```ts
const deadline = { wallMs: clock.now().wallMs + 5_000 };
const wait = clock.deadline(deadline);

clock.jumpWallTime(clock.now().wallMs - 10_000);
clock.advanceBy(ms(5_000));
await wait; // emits time:deadline:err
```

### Example 3 — Deterministic intervals in tests

```ts
const ticks: number[] = [];
clock.interval(ms(100), () => ticks.push(clock.now().monoMs));
clock.advanceBy(ms(350));
// ticks: [100, 200, 300]
```

### Example 4 — Observing missed deadlines in production

```ts
const clock = createSystemClock({ emit: console.log });
await clock.deadline({ wallMs: Date.now() + 1000 });
// See drift and event logs
```

---

## Clock does NOT help you with this

### Example 1 — Time zone conversions

```ts
// Not Clock's job:
new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
```

### Example 2 — Calculating calendar days between two dates

```ts
// Not Clock's job — DST-aware day math needs a date library
const days = differenceInDays(dateA, dateB);
```

### Example 3 — Parsing or formatting dates

```ts
// Not Clock's job:
format(new Date(), "yyyy-MM-dd");
```

### Example 4 — Retrospective math on arbitrary timestamps

```ts
// If you only have two Date objects from the past:
const delta = dateB.getTime() - dateA.getTime(); // wall time only
```

---

## Why not just use Jest’s fake timers?

Jest’s fake timers replace the native timer functions with a mocked scheduler so you can skip waits. They cannot:

- Distinguish between wall time and monotonic time.
- Model real-world anomalies like NTP jumps, leap seconds, or DST shifts.
- Advance one clock while keeping another steady.
- Simulate time moving backwards.
- Emit structured events for observability in production.

If you use only Jest’s timers, you can verify “it fires after X milliseconds” in a perfect, isolated world. The moment you need to know how your code reacts when the system clock changes mid-flight, you are out of luck.

Even if tests are all you care about, `ControlledClock` helps prevent flakiness by:

- Simulating wall time jumps without affecting monotonic progression.
- Preserving deterministic interval cadence under catch-up.
- Allowing independent control over deadlines and elapsed time.
- Matching production semantics exactly, so your tests are not lying to you.

---

## What this is not

Clock is not a date manipulation library. It does not parse, format, or do arithmetic on calendar dates. It is not a time zone converter. It does not replace libraries like date-fns, Luxon, or Moment.

Clock is focused on representing “now” in two forms — wall time and monotonic time — and giving you precise control and observability over how that “now” changes in real systems and tests.

If you want to know what time it is in Tokyo next Friday, use a date library. If you want to know exactly when “now” changes and how your code behaves when it does, use Clock.

---

## Installation

```bash
npm install @phyxius/clock
```

---

## What you get

- Time you can reason about: wall time for scheduling and monotonic time for measuring.
- Time you can test: jump to any moment instantly, simulate anomalies, and verify behavior.
- Time that works in production: structured events for clear observability of timer behavior and drift.

Clock does not fix time. It gives you two different references to make the use very explicit, while also enabling truly deterministic testing. Everything else builds on that foundation.

# @phyxiusjs/circuit-breaker

## 0.4.0

### Minor Changes

- ce429f2: `Instant.monoMs` is now `MonoMs`, a branded type distinct from `Millis` — a monotonic clock reading can no longer be assigned where a duration is expected, or constructed from a bare number, anywhere outside `@phyxiusjs/clock` itself.

  `@phyxiusjs/circuit-breaker`'s 0.3.0 changeset fixed the symptom: `CircuitOpenError` now speaks durations, never instants, after a monotonic `willRetryAfter` rendered as an epoch produced a phantom multi-hour penalty during the 2026-08-01 vendor outage. This closes the class the symptom came from. Before this, `monoMs` was plain `number` — the same type as every duration in the system — so a clock reading and an elapsed time were interchangeable to the compiler and distinguishable only by a variable name. Raw `+`/`-` on two `MonoMs` values still compiles (TypeScript doesn't check brands on arithmetic operators), but the result is a bare `number` with the brand stripped, and that no longer satisfies `Millis` or `MonoMs` at the next assignment — the leak surfaces there instead of riding along as a mistyped duration.

  Three named helpers (`elapsedSince`, `deadlineFrom`, `hasPassed`, all in `@phyxiusjs/clock`) replace the raw arithmetic. Every call site in this repo that read `clock.now().monoMs` and did math on it by hand now goes through them instead: `@phyxiusjs/circuit-breaker`'s admission classification and refusal durations, `@phyxiusjs/handler`'s invocation timing and drain-timeout deadline, `@phyxiusjs/drain`'s backoff deadline and flush timing, `@phyxiusjs/db`'s query and transaction timing, `@phyxiusjs/resource`'s acquire/release timing, `@phyxiusjs/strategy`'s primary/shadow timing, `@phyxiusjs/temporal`'s throttle window, and `@phyxiusjs/scheduler`'s `every()` tick. Some of these were caught by the compiler (a `MonoMs` landing on an `Instant`-typed return); most weren't, because the field on the receiving end was already a plain `number` (`durationMs`, mainly) and a stripped `number` assigns to `number` without complaint — those were found by auditing every `.monoMs` read, not by the type checker.

  Not breaking for ordinary consumers: reading `clock.now().monoMs` and handing it to another Phyxius API (`clock.sleep`, `clock.timeout`, the new helpers) is unaffected. It breaks code that hand-built an `Instant`-shaped object with a bare number in the `monoMs` slot instead of getting one from `clock.now()` — get one from a real clock (a `ControlledClock` at a known time, for tests) instead.

### Patch Changes

- Updated dependencies [ce429f2]
  - @phyxiusjs/clock@0.3.0
  - @phyxiusjs/atom@0.2.1
  - @phyxiusjs/fp@0.2.1

## 0.3.0

### Minor Changes

- 9553db8: The half-open probe holds a LEASE (`probeTimeout`, default `resetTimeout`), not the slot forever.

  The contract used to admit exactly one probe — ever. A probe whose call never settled (a hung socket with no deadline of its own) held the half-open slot eternally, and every subsequent caller short-circuited "circuit open" while the vendor sat provably healthy: eternal half-open was representable, so during the 2026-08-02 DeepSeek incident it got represented, for hours.

  `classify` now treats a probe older than its lease as dethroned: the slot becomes claimable, the next caller probes, and a recovered vendor closes the circuit. The incumbent is never cancelled — its late settlement lands as ordinary evidence (a late success closes the circuit; a late failure after recovery counts as one diluted closed-state failure, no reopen spiral). `CircuitSnapshot` gains `probeStartedAt`, and a lease reclaim emits `circuit:half-open` again so every admitted probe is visible to watchers.

  The incident is the test: a never-settling probe, a clock stepped past the lease, a successor closing the circuit on the recovered vendor.

- 9553db8: `CircuitOpenError` speaks in durations, never instants: `openedAt` / `willRetryAfter` → `openForMs` / `retryInMs`, both relative to the refusal's own moment.

  The old fields were instants from the breaker's clock — monotonic and process-local, meaningless anywhere else — under a name that read as a duration. During the 2026-08-01 vendor outage, a monotonic `willRetryAfter` rendered as an epoch produced a phantom multi-hour penalty in the middle of a real incident. Durations carry their own frame: nothing to misread, nothing to convert.

  Consumers are corrected by construction: the http adapter's `Retry-After` and the queue adapter's redelivery `delayMs` now carry the window's _remainder_ at refusal time — both previously sent the full window length regardless of how much had elapsed.

  Breaking (0.x minor): any code reading `error.openedAt` / `error.willRetryAfter` must switch to `error.openForMs` / `error.retryInMs`.

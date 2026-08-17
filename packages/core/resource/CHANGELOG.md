# @phyxiusjs/resource

## 0.3.0

### Minor Changes

- ce429f2: `Instant.monoMs` is now `MonoMs`, a branded type distinct from `Millis` — a monotonic clock reading can no longer be assigned where a duration is expected, or constructed from a bare number, anywhere outside `@phyxiusjs/clock` itself.

  `@phyxiusjs/circuit-breaker`'s 0.3.0 changeset fixed the symptom: `CircuitOpenError` now speaks durations, never instants, after a monotonic `willRetryAfter` rendered as an epoch produced a phantom multi-hour penalty during the 2026-08-01 vendor outage. This closes the class the symptom came from. Before this, `monoMs` was plain `number` — the same type as every duration in the system — so a clock reading and an elapsed time were interchangeable to the compiler and distinguishable only by a variable name. Raw `+`/`-` on two `MonoMs` values still compiles (TypeScript doesn't check brands on arithmetic operators), but the result is a bare `number` with the brand stripped, and that no longer satisfies `Millis` or `MonoMs` at the next assignment — the leak surfaces there instead of riding along as a mistyped duration.

  Three named helpers (`elapsedSince`, `deadlineFrom`, `hasPassed`, all in `@phyxiusjs/clock`) replace the raw arithmetic. Every call site in this repo that read `clock.now().monoMs` and did math on it by hand now goes through them instead: `@phyxiusjs/circuit-breaker`'s admission classification and refusal durations, `@phyxiusjs/handler`'s invocation timing and drain-timeout deadline, `@phyxiusjs/drain`'s backoff deadline and flush timing, `@phyxiusjs/db`'s query and transaction timing, `@phyxiusjs/resource`'s acquire/release timing, `@phyxiusjs/strategy`'s primary/shadow timing, `@phyxiusjs/temporal`'s throttle window, and `@phyxiusjs/scheduler`'s `every()` tick. Some of these were caught by the compiler (a `MonoMs` landing on an `Instant`-typed return); most weren't, because the field on the receiving end was already a plain `number` (`durationMs`, mainly) and a stripped `number` assigns to `number` without complaint — those were found by auditing every `.monoMs` read, not by the type checker.

  Not breaking for ordinary consumers: reading `clock.now().monoMs` and handing it to another Phyxius API (`clock.sleep`, `clock.timeout`, the new helpers) is unaffected. It breaks code that hand-built an `Instant`-shaped object with a bare number in the `monoMs` slot instead of getting one from `clock.now()` — get one from a real clock (a `ControlledClock` at a known time, for tests) instead.

### Patch Changes

- Updated dependencies [ce429f2]
  - @phyxiusjs/clock@0.3.0

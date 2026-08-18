# @phyxiusjs/drain

## 0.4.0

### Minor Changes

- 6c6fafd: Close two shutdown paths that did less than they reported

  `drain.stop()` promised a final drain and could deliver nothing. `force`
  bypasses a backoff hold but never a live write, so a `stop()` that raced an
  in-flight flush was classified as "skip", and every entry buffered during that
  write was dropped without a word. Shutdown now waits for the write already in
  the sink, drains every batch rather than one, and reports `remaining` as what
  it could not deliver instead of what it happened to be holding when it began.
  The old value meant a clean shutdown still announced a non-zero remainder.

  `Supervisor` decided restarts through a boolean, so "not restarting" could not
  say which of three things it was, and two of them emitted nothing at all. The
  sharpest case: shutdown landing inside a restart's backoff sleep retired the
  child on a decision that said restart, after the restart budget had already
  been spent. `RestartDeclined` names the three reasons, the budget case keeps
  its existing `supervisor:giveup` event unchanged, and the other two now emit
  `supervisor:restart:abandoned`. `ProcessEvent`'s own contract already required
  this: a state transition a consumer would care about MUST produce an event.

  `createMemoryStateStore` now composes `@phyxiusjs/atom` instead of a hand-written
  compare over a bare `let`. The atom was already a declared dependency of the
  package and imported by nothing. `StateStore` stays async and `Result`-returning
  because durable state must outlive its process and a race has to name its winner;
  the atom implements the store, it cannot be the interface.

  Follow-up from Preston's review of this PR: the memory state store keeps the
  atom's default reference equality. A kind-based `equals` looked right, but in
  `createAtom` that predicate decides the CAS _and_ whether `swap` treats the
  write as a change, so a same-kind transition carrying a new payload was read
  as "nothing changed", the commit was skipped, and `trySet` returned `ok` over a
  stale value. A silent false success, in the store belonging to the package
  whose subject is that silence must not read as success. The kind comparison the
  contract wants already happens in `trySet`, before the CAS.

## 0.3.0

### Minor Changes

- ce429f2: `Instant.monoMs` is now `MonoMs`, a branded type distinct from `Millis` — a monotonic clock reading can no longer be assigned where a duration is expected, or constructed from a bare number, anywhere outside `@phyxiusjs/clock` itself.

  `@phyxiusjs/circuit-breaker`'s 0.3.0 changeset fixed the symptom: `CircuitOpenError` now speaks durations, never instants, after a monotonic `willRetryAfter` rendered as an epoch produced a phantom multi-hour penalty during the 2026-08-01 vendor outage. This closes the class the symptom came from. Before this, `monoMs` was plain `number` — the same type as every duration in the system — so a clock reading and an elapsed time were interchangeable to the compiler and distinguishable only by a variable name. Raw `+`/`-` on two `MonoMs` values still compiles (TypeScript doesn't check brands on arithmetic operators), but the result is a bare `number` with the brand stripped, and that no longer satisfies `Millis` or `MonoMs` at the next assignment — the leak surfaces there instead of riding along as a mistyped duration.

  Three named helpers (`elapsedSince`, `deadlineFrom`, `hasPassed`, all in `@phyxiusjs/clock`) replace the raw arithmetic. Every call site in this repo that read `clock.now().monoMs` and did math on it by hand now goes through them instead: `@phyxiusjs/circuit-breaker`'s admission classification and refusal durations, `@phyxiusjs/handler`'s invocation timing and drain-timeout deadline, `@phyxiusjs/drain`'s backoff deadline and flush timing, `@phyxiusjs/db`'s query and transaction timing, `@phyxiusjs/resource`'s acquire/release timing, `@phyxiusjs/strategy`'s primary/shadow timing, `@phyxiusjs/temporal`'s throttle window, and `@phyxiusjs/scheduler`'s `every()` tick. Some of these were caught by the compiler (a `MonoMs` landing on an `Instant`-typed return); most weren't, because the field on the receiving end was already a plain `number` (`durationMs`, mainly) and a stripped `number` assigns to `number` without complaint — those were found by auditing every `.monoMs` read, not by the type checker.

  Not breaking for ordinary consumers: reading `clock.now().monoMs` and handing it to another Phyxius API (`clock.sleep`, `clock.timeout`, the new helpers) is unaffected. It breaks code that hand-built an `Instant`-shaped object with a bare number in the `monoMs` slot instead of getting one from `clock.now()` — get one from a real clock (a `ControlledClock` at a known time, for tests) instead.

### Patch Changes

- Updated dependencies [ce429f2]
  - @phyxiusjs/clock@0.3.0
  - @phyxiusjs/journal@0.2.1

## 0.1.0

### Minor Changes

- Initial release of @phyxiusjs/drain — journal log export with pluggable sinks (stdout, OTLP HTTP, file, composite). Subscribes to a journal, batches entries, and flushes to any OTLP-compatible backend.

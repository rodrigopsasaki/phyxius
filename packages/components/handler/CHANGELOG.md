# @phyxiusjs/handler

## 1.0.0

### Minor Changes

- cede0df: `CircuitOpenError` speaks in durations, never instants: `openedAt` / `willRetryAfter` → `openForMs` / `retryInMs`, both relative to the refusal's own moment.

  The old fields were instants from the breaker's clock — monotonic and process-local, meaningless anywhere else — under a name that read as a duration. During the 2026-08-01 vendor outage, a monotonic `willRetryAfter` rendered as an epoch produced a phantom multi-hour penalty in the middle of a real incident. Durations carry their own frame: nothing to misread, nothing to convert.

  Consumers are corrected by construction: the http adapter's `Retry-After` and the queue adapter's redelivery `delayMs` now carry the window's _remainder_ at refusal time — both previously sent the full window length regardless of how much had elapsed.

  Breaking (0.x minor): any code reading `error.openedAt` / `error.willRetryAfter` must switch to `error.openForMs` / `error.retryInMs`.

### Patch Changes

- Updated dependencies [61bf059]
- Updated dependencies [cede0df]
  - @phyxiusjs/circuit-breaker@1.0.0
  - @phyxiusjs/context@1.0.0
  - @phyxiusjs/observe@1.0.0
  - @phyxiusjs/atom@1.0.0
  - @phyxiusjs/clock@1.0.0
  - @phyxiusjs/journal@1.0.0
  - @phyxiusjs/process@1.0.0
  - @phyxiusjs/fp@1.0.0
  - @phyxiusjs/retry@1.0.0
  - @phyxiusjs/validate@1.0.0

# @phyxiusjs/circuit-breaker

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

# @phyxiusjs/http

## 0.3.1

### Patch Changes

- b4c12b4: `matchRoute` (exported from `matcher.ts`, re-exported at the package root) resolved a candidate entry's PATH by temporarily overriding that entry's own declared `method` with the REQUESTED method before calling `matchPattern` — which made `matchPattern`'s own method check trivially pass for every entry whose path shape matched, regardless of which HTTP method it was actually registered for. Two routes sharing a path under different methods (`DELETE /orders/:id` and `GET /orders/:id`) meant whichever route happened to be checked first, by specificity/insertion order, won for EVERY method: a `GET` request could silently invoke the `DELETE` handler.

  `createHttpAdapter`'s own runtime dispatch (`index.ts`'s `dispatch()`) never called `matchRoute` — it re-implements the same walk directly, correctly, which is why this shipped invisibly. `matchRoute` is still part of the package's public surface (re-exported from the root), so any consumer calling it directly for their own routing logic was exposed to this.

  Fixed by checking each entry's real method against the request first, and — only when that fails — separately checking the path shape alone (via the entry's own method, so the check is path-only in effect) to distinguish a genuine 404 from a 405. No behavior change for the common case (one method per path); a shared path across methods now resolves to the actually-matching method's route.

- Updated dependencies [ce429f2]
  - @phyxiusjs/handler@0.4.0
  - @phyxiusjs/fp@0.2.1

## 0.3.0

### Minor Changes

- 9553db8: `CircuitOpenError` speaks in durations, never instants: `openedAt` / `willRetryAfter` → `openForMs` / `retryInMs`, both relative to the refusal's own moment.

  The old fields were instants from the breaker's clock — monotonic and process-local, meaningless anywhere else — under a name that read as a duration. During the 2026-08-01 vendor outage, a monotonic `willRetryAfter` rendered as an epoch produced a phantom multi-hour penalty in the middle of a real incident. Durations carry their own frame: nothing to misread, nothing to convert.

  Consumers are corrected by construction: the http adapter's `Retry-After` and the queue adapter's redelivery `delayMs` now carry the window's _remainder_ at refusal time — both previously sent the full window length regardless of how much had elapsed.

  Breaking (0.x minor): any code reading `error.openedAt` / `error.willRetryAfter` must switch to `error.openForMs` / `error.retryInMs`.

### Patch Changes

- Updated dependencies [9553db8]
  - @phyxiusjs/handler@0.3.0

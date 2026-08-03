---
"@phyxiusjs/http": patch
---

`matchRoute` (exported from `matcher.ts`, re-exported at the package root) resolved a candidate entry's PATH by temporarily overriding that entry's own declared `method` with the REQUESTED method before calling `matchPattern` — which made `matchPattern`'s own method check trivially pass for every entry whose path shape matched, regardless of which HTTP method it was actually registered for. Two routes sharing a path under different methods (`DELETE /orders/:id` and `GET /orders/:id`) meant whichever route happened to be checked first, by specificity/insertion order, won for EVERY method: a `GET` request could silently invoke the `DELETE` handler.

`createHttpAdapter`'s own runtime dispatch (`index.ts`'s `dispatch()`) never called `matchRoute` — it re-implements the same walk directly, correctly, which is why this shipped invisibly. `matchRoute` is still part of the package's public surface (re-exported from the root), so any consumer calling it directly for their own routing logic was exposed to this.

Fixed by checking each entry's real method against the request first, and — only when that fails — separately checking the path shape alone (via the entry's own method, so the check is path-only in effect) to distinguish a genuine 404 from a 405. No behavior change for the common case (one method per path); a shared path across methods now resolves to the actually-matching method's route.

import { bracket, make, of } from "./core.js";
import { parallel, sequence } from "./compose.js";

export type { Acquire, Release, Resource, ResourceEvent, ResourceOptions, UseFn } from "./types.js";

export { make, of, bracket } from "./core.js";
export { parallel, sequence } from "./compose.js";

/**
 * Namespace object grouping the resource constructors. Mirrors the
 * ergonomic shape of `retry`, `cb`, `schedule`, and `observe` — use
 * `resource.make(...)` and `resource.parallel([...])` at call sites.
 */
export const resource = {
  make,
  of,
  bracket,
  parallel,
  sequence,
} as const;

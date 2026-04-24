import type { HandlerEvent } from "@phyxiusjs/handler";

import type { FrameworkConfig } from "./config-schema.js";

/**
 * FNV-1a 32-bit hash of a string, normalized to [0, 1). Deterministic
 * across processes — the same `invocationId` hashes to the same value
 * on every node in the fleet. This is what makes sampling coherent: a
 * request that's logged on one instance is logged on all, and vice
 * versa, so you never get half-a-trace in your logs.
 */
export function hashToRatio(s: string): number {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

/**
 * Pure sampling decision — given a HandlerEvent and the current logging
 * config, should this event be written to the log sink?
 *
 * Extracted as a standalone function so it's trivially testable and
 * so the framework's drain filter can call it without any framework
 * state. The config is passed in every call rather than read from a
 * closure, matching the strategy discipline.
 */
export function shouldLog(event: HandlerEvent, config: FrameworkConfig["observability"]): boolean {
  if (event.outcome === "failure" && config.log_sampling.log_all_failures) {
    return true;
  }
  return hashToRatio(event.invocationId) < config.log_sampling.ratio_of_successful_requests;
}

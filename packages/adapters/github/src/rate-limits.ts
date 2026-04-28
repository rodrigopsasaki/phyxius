/**
 * Rate-limit accounting for GitHub.
 *
 * GitHub returns rate-limit headers on every response (REST and
 * GraphQL alike):
 *
 *   X-RateLimit-Limit:     5000
 *   X-RateLimit-Remaining: 4999
 *   X-RateLimit-Reset:     1372700873          (Unix seconds)
 *   X-RateLimit-Used:      1
 *   X-RateLimit-Resource:  core                (which budget this charged)
 *
 * Each resource has an independent budget. We model the resources a
 * real consumer hits often enough that visibility matters; everything
 * else is logged as observed-but-unmodeled and ignored.
 *
 * The tracker is in-memory by default. For multi-process deployments
 * supply a custom tracker backed by Redis / a shared store; the
 * `RateLimitTracker` interface is the contract.
 */

import type { RateLimitBudget, RateLimitResource, RateLimitTracker } from "./types.js";

const RECOGNIZED_RESOURCES: ReadonlySet<RateLimitResource> = new Set([
  "core",
  "search",
  "graphql",
  "code_search",
  "integration_manifest",
  "code_scanning_upload",
]);

/**
 * Build a default in-memory tracker. Constructed once per
 * `GithubConfig`; shared across all operations on that config.
 */
export function createRateLimitTracker(): RateLimitTracker {
  const budgets = new Map<RateLimitResource, RateLimitBudget>();

  function observe(resource: RateLimitResource, headers: Headers, nowMs: number): void {
    // Prefer the resource the response actually charged against (the
    // X-RateLimit-Resource header) over the operation's claim about
    // which resource it expected. They almost always agree, but
    // GitHub can re-route a query (e.g., complex search via GraphQL)
    // and the header is authoritative.
    const observedResource = readResource(headers) ?? resource;
    if (!RECOGNIZED_RESOURCES.has(observedResource)) {
      // Unmodeled resource — ignore. We could log here but the
      // transport layer will surface it via observe.fields anyway.
      return;
    }

    const limit = readNumber(headers, "x-ratelimit-limit");
    const remaining = readNumber(headers, "x-ratelimit-remaining");
    const reset = readNumber(headers, "x-ratelimit-reset");
    const used = readNumber(headers, "x-ratelimit-used");

    if (limit === undefined || remaining === undefined || reset === undefined) {
      // Without the trio (limit/remaining/reset), the snapshot is
      // useless — drop it rather than store a half-formed budget.
      return;
    }

    const next: RateLimitBudget = {
      resource: observedResource,
      limit,
      remaining,
      resetMs: reset * 1000,
      used: used ?? Math.max(0, limit - remaining),
      observedAt: nowMs,
    };

    // Last-write-wins on observedAt. Two near-simultaneous responses
    // for the same resource will see the later observedAt, which
    // reflects the more recent server-side state.
    const prev = budgets.get(observedResource);
    if (prev === undefined || next.observedAt >= prev.observedAt) {
      budgets.set(observedResource, next);
    }
  }

  function budget(resource: RateLimitResource): RateLimitBudget | undefined {
    return budgets.get(resource);
  }

  function isExhausted(resource: RateLimitResource, nowMs: number): boolean {
    const b = budgets.get(resource);
    if (b === undefined) return false;
    if (b.remaining > 0) return false;
    // Remaining is 0 — but the window may have rolled over since the
    // snapshot was taken. If reset has passed, the budget is fresh
    // again from the server's point of view; trust the rollover.
    return b.resetMs > nowMs;
  }

  return { observe, budget, isExhausted };
}

// ── Header parsing ──────────────────────────────────────────────────────────

function readResource(headers: Headers): RateLimitResource | undefined {
  const v = headers.get("x-ratelimit-resource");
  if (v === null) return undefined;
  // Cast through the recognized set — anything outside is flagged by
  // the caller, not silently rewritten.
  return v as RateLimitResource;
}

function readNumber(headers: Headers, name: string): number | undefined {
  const v = headers.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

import { describe, expect, it } from "vitest";

import { createRateLimitTracker } from "../src/rate-limits.js";

function headers(input: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(input)) h.set(k, v);
  return h;
}

describe("createRateLimitTracker", () => {
  it("starts with no budgets", () => {
    const t = createRateLimitTracker();
    expect(t.budget("core")).toBeUndefined();
    expect(t.isExhausted("core", Date.now())).toBe(false);
  });

  it("records a budget from response headers", () => {
    const t = createRateLimitTracker();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    t.observe(
      "core",
      headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": String(reset),
        "x-ratelimit-used": "1",
      }),
      Date.now(),
    );
    const b = t.budget("core");
    expect(b).toBeDefined();
    expect(b?.limit).toBe(5000);
    expect(b?.remaining).toBe(4999);
    expect(b?.used).toBe(1);
    expect(b?.resetMs).toBe(reset * 1000);
  });

  it("prefers X-RateLimit-Resource header over caller-supplied resource", () => {
    const t = createRateLimitTracker();
    const reset = Math.floor(Date.now() / 1000) + 60;
    t.observe(
      "core",
      headers({
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": "29",
        "x-ratelimit-reset": String(reset),
        "x-ratelimit-resource": "search",
      }),
      Date.now(),
    );
    expect(t.budget("core")).toBeUndefined();
    expect(t.budget("search")?.limit).toBe(30);
  });

  it("ignores incomplete header bundles (no reset)", () => {
    const t = createRateLimitTracker();
    t.observe(
      "core",
      headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
      }),
      Date.now(),
    );
    expect(t.budget("core")).toBeUndefined();
  });

  it("reports exhausted when remaining is 0 and reset is in the future", () => {
    const t = createRateLimitTracker();
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 60;
    t.observe(
      "core",
      headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      }),
      now,
    );
    expect(t.isExhausted("core", now)).toBe(true);
  });

  it("reports not-exhausted once the reset window has rolled over", () => {
    const t = createRateLimitTracker();
    const past = Date.now() - 120_000;
    const reset = Math.floor(past / 1000) + 60; // resets 60s after observation
    t.observe(
      "core",
      headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      }),
      past,
    );
    // Now is well past reset
    expect(t.isExhausted("core", Date.now())).toBe(false);
  });

  it("ignores unmodeled resource names", () => {
    const t = createRateLimitTracker();
    t.observe(
      "core",
      headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "9999999999",
        "x-ratelimit-resource": "fictional-bucket",
      }),
      Date.now(),
    );
    expect(t.budget("core")).toBeUndefined();
  });

  it("last-write-wins on observedAt", () => {
    const t = createRateLimitTracker();
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 3600;
    t.observe(
      "core",
      headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "100",
        "x-ratelimit-reset": String(reset),
      }),
      now - 1000,
    );
    t.observe(
      "core",
      headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "50",
        "x-ratelimit-reset": String(reset),
      }),
      now,
    );
    expect(t.budget("core")?.remaining).toBe(50);
  });
});

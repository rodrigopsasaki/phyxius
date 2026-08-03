import { describe, expect, it } from "vitest";

import { hashToRatio, shouldLog } from "../src/sampling.js";
import { frameworkConfigSchema } from "../src/config-schema.js";
import type { HandlerEvent } from "@phyxiusjs/handler";
import type { Instant } from "@phyxiusjs/clock";

// ── Fixtures ──────────────────────────────────────────────────────────────

function event(overrides: Partial<HandlerEvent>): HandlerEvent {
  // Fixture instant, not a clock reading — `as Instant` is the sanctioned
  // escape hatch for test fixtures (see @phyxiusjs/clock's MonoMs docs).
  const instant = { wallMs: 0, monoMs: 0 } as Instant;
  return {
    name: "x",
    invocationId: "inv-default",
    source: "test",
    startedAt: instant,
    completedAt: instant,
    durationMs: 1,
    attempts: 1,
    outcome: "success",
    observed: {},
    ...overrides,
  };
}

// ── hashToRatio ──────────────────────────────────────────────────────────

describe("hashToRatio", () => {
  it("returns values in [0, 1)", () => {
    for (let i = 0; i < 1000; i++) {
      const r = hashToRatio(`inv-${i}`);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  it("is deterministic — same input always produces same output", () => {
    for (let i = 0; i < 100; i++) {
      const s = `id-${i}`;
      expect(hashToRatio(s)).toBe(hashToRatio(s));
    }
  });

  it("produces roughly uniform distribution over a sample", () => {
    // Histogram into 10 buckets; each should have ~100 of 1000 samples.
    const buckets = new Array(10).fill(0) as number[];
    for (let i = 0; i < 1000; i++) {
      const bucket = Math.floor(hashToRatio(`sample-${i}`) * 10);
      buckets[bucket]! += 1;
    }
    // Very lax uniformity check — each bucket should have at least 50
    // (would be ~100 with perfect uniformity). This catches pathological
    // clustering, not small deviations.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(50);
    }
  });

  it("distinguishes distinct strings (handles near-collisions)", () => {
    const a = hashToRatio("inv-123");
    const b = hashToRatio("inv-124");
    expect(a).not.toBe(b);
  });
});

// ── shouldLog ─────────────────────────────────────────────────────────────

const defaultObservability = frameworkConfigSchema.parse({}).observability;

describe("shouldLog", () => {
  it("logs all successes at ratio 1.0", () => {
    for (let i = 0; i < 100; i++) {
      expect(shouldLog(event({ invocationId: `s-${i}` }), defaultObservability)).toBe(true);
    }
  });

  it("logs no successes at ratio 0.0 — failures still logged", () => {
    const obs = {
      ...defaultObservability,
      log_sampling: { ratio_of_successful_requests: 0.0, log_all_failures: true },
    };
    for (let i = 0; i < 100; i++) {
      expect(shouldLog(event({ invocationId: `s-${i}` }), obs)).toBe(false);
    }
    // But failures still fire.
    expect(shouldLog(event({ invocationId: "f-1", outcome: "failure" }), obs)).toBe(true);
  });

  it("log_all_failures=false drops failures too (spend paranoia)", () => {
    const obs = {
      ...defaultObservability,
      log_sampling: { ratio_of_successful_requests: 0.0, log_all_failures: false },
    };
    expect(shouldLog(event({ invocationId: "f-1", outcome: "failure" }), obs)).toBe(false);
  });

  it("sampling is deterministic per invocationId", () => {
    const obs = {
      ...defaultObservability,
      log_sampling: { ratio_of_successful_requests: 0.5, log_all_failures: false },
    };
    const e = event({ invocationId: "stable-id" });
    const first = shouldLog(e, obs);
    for (let i = 0; i < 10; i++) {
      expect(shouldLog(e, obs)).toBe(first);
    }
  });

  it("at ratio 0.3, roughly 30% of successes are sampled", () => {
    const obs = {
      ...defaultObservability,
      log_sampling: { ratio_of_successful_requests: 0.3, log_all_failures: false },
    };
    let logged = 0;
    for (let i = 0; i < 10_000; i++) {
      if (shouldLog(event({ invocationId: `s-${i}` }), obs)) logged += 1;
    }
    // Very lax — we just want to confirm we're in the neighborhood.
    expect(logged).toBeGreaterThan(2500);
    expect(logged).toBeLessThan(3500);
  });
});

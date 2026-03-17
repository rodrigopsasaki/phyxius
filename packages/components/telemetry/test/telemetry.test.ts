import { describe, it, expect, beforeEach } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import type { Instant } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import type { HandlerEvent } from "@phyxiusjs/handler";
import { createTelemetry, type Telemetry } from "../src/index.js";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<HandlerEvent> = {}): HandlerEvent {
  const now = clock.now();
  return {
    handlerName: "test.handler",
    executionId: `exec-${Math.random().toString(36).slice(2)}`,
    startedAt: now,
    completedAt: now,
    durationMs: 100,
    attempts: 1,
    outcome: "success",
    source: "test",
    correlationId: "corr-1",
    observed: {},
    ...overrides,
  };
}

let clock: ReturnType<typeof createSystemClock>;

describe("Telemetry", () => {
  let journal: Journal<HandlerEvent>;
  let telemetry: Telemetry;

  beforeEach(() => {
    clock = createSystemClock();
    journal = new Journal({ clock });
    telemetry = createTelemetry({ journal, clock });
  });

  // ── getLatency ──────────────────────────────────────────────────────────

  describe("getLatency()", () => {
    it("returns zeros when journal is empty", () => {
      const stats = telemetry.getLatency();

      expect(stats.count).toBe(0);
      expect(stats.p50).toBe(0);
      expect(stats.p95).toBe(0);
      expect(stats.p99).toBe(0);
      expect(stats.max).toBe(0);
      expect(stats.min).toBe(0);
    });

    it("computes correct percentiles from journal entries", () => {
      // Insert 100 events with durationMs from 1 to 100
      for (let i = 1; i <= 100; i++) {
        journal.append(makeEvent({ durationMs: i }));
      }

      const stats = telemetry.getLatency();

      expect(stats.count).toBe(100);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
      expect(stats.p50).toBe(50);
      expect(stats.p95).toBe(95);
      expect(stats.p99).toBe(99);
    });

    it("filters by handlerName when provided", () => {
      journal.append(makeEvent({ handlerName: "fast", durationMs: 10 }));
      journal.append(makeEvent({ handlerName: "slow", durationMs: 500 }));
      journal.append(makeEvent({ handlerName: "fast", durationMs: 20 }));

      const stats = telemetry.getLatency({ handlerName: "fast" });

      expect(stats.count).toBe(2);
      expect(stats.max).toBe(20);
      expect(stats.min).toBe(10);
    });

    it("filters by since when provided", () => {
      const early = clock.now();
      journal.append(makeEvent({ durationMs: 10, completedAt: early }));

      // Advance time a bit
      const late: Instant = { wallMs: early.wallMs + 1000, monoMs: early.monoMs + 1000 };
      journal.append(makeEvent({ durationMs: 50, completedAt: late }));

      const midpoint: Instant = {
        wallMs: early.wallMs + 500,
        monoMs: early.monoMs + 500,
      };
      const stats = telemetry.getLatency({ since: midpoint });

      expect(stats.count).toBe(1);
      expect(stats.p50).toBe(50);
    });
  });

  // ── getErrorRate ──────────────────────────────────────────────────────────

  describe("getErrorRate()", () => {
    it("returns zero rate when journal is empty", () => {
      const stats = telemetry.getErrorRate();

      expect(stats.total).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.rate).toBe(0);
    });

    it("computes correct error rate", () => {
      journal.append(makeEvent({ outcome: "success" }));
      journal.append(makeEvent({ outcome: "failure" }));
      journal.append(makeEvent({ outcome: "success" }));
      journal.append(makeEvent({ outcome: "failure" }));

      const stats = telemetry.getErrorRate();

      expect(stats.total).toBe(4);
      expect(stats.failed).toBe(2);
      expect(stats.rate).toBe(0.5);
    });

    it("filters by handlerName", () => {
      journal.append(makeEvent({ handlerName: "a", outcome: "failure" }));
      journal.append(makeEvent({ handlerName: "b", outcome: "success" }));
      journal.append(makeEvent({ handlerName: "a", outcome: "failure" }));

      const stats = telemetry.getErrorRate({ handlerName: "a" });

      expect(stats.total).toBe(2);
      expect(stats.failed).toBe(2);
      expect(stats.rate).toBe(1);
    });
  });

  // ── getSlowest ──────────────────────────────────────────────────────────

  describe("getSlowest()", () => {
    it("returns the slowest events sorted by duration descending", () => {
      journal.append(makeEvent({ executionId: "fast", durationMs: 10 }));
      journal.append(makeEvent({ executionId: "medium", durationMs: 100 }));
      journal.append(makeEvent({ executionId: "slow", durationMs: 500 }));
      journal.append(makeEvent({ executionId: "very-slow", durationMs: 1000 }));

      const slowest = telemetry.getSlowest({ limit: 2 });

      expect(slowest).toHaveLength(2);
      expect(slowest[0]?.executionId).toBe("very-slow");
      expect(slowest[1]?.executionId).toBe("slow");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        journal.append(makeEvent({ durationMs: i * 10 }));
      }

      const slowest = telemetry.getSlowest({ limit: 3 });

      expect(slowest).toHaveLength(3);
    });
  });

  // ── getErrors ───────────────────────────────────────────────────────────

  describe("getErrors()", () => {
    it("returns only failure events, most recent first", () => {
      const t1: Instant = { wallMs: 1000, monoMs: 1000 };
      const t2: Instant = { wallMs: 2000, monoMs: 2000 };
      const t3: Instant = { wallMs: 3000, monoMs: 3000 };

      journal.append(makeEvent({ executionId: "err-1", outcome: "failure", completedAt: t1 }));
      journal.append(makeEvent({ outcome: "success", completedAt: t2 }));
      journal.append(makeEvent({ executionId: "err-2", outcome: "failure", completedAt: t3 }));

      const errors = telemetry.getErrors({ limit: 10 });

      expect(errors).toHaveLength(2);
      expect(errors[0]?.executionId).toBe("err-2");
      expect(errors[1]?.executionId).toBe("err-1");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        journal.append(makeEvent({ outcome: "failure" }));
      }

      const errors = telemetry.getErrors({ limit: 3 });

      expect(errors).toHaveLength(3);
    });
  });

  // ── getHandlerStats ────────────────────────────────────────────────────

  describe("getHandlerStats()", () => {
    it("returns empty array when journal is empty", () => {
      const stats = telemetry.getHandlerStats();

      expect(stats).toHaveLength(0);
    });

    it("groups stats by handlerName", () => {
      journal.append(makeEvent({ handlerName: "a", durationMs: 10 }));
      journal.append(makeEvent({ handlerName: "a", durationMs: 20 }));
      journal.append(makeEvent({ handlerName: "b", durationMs: 100 }));
      journal.append(
        makeEvent({
          handlerName: "b",
          durationMs: 200,
          outcome: "failure",
        }),
      );

      const stats = telemetry.getHandlerStats();

      expect(stats).toHaveLength(2);

      const handlerA = stats.find((s) => s.handlerName === "a");
      expect(handlerA).toBeDefined();
      expect(handlerA?.totalRequests).toBe(2);
      expect(handlerA?.errorRate).toBe(0);

      const handlerB = stats.find((s) => s.handlerName === "b");
      expect(handlerB).toBeDefined();
      expect(handlerB?.totalRequests).toBe(2);
      expect(handlerB?.errorRate).toBe(0.5);
    });

    it("sorts by totalRequests descending", () => {
      journal.append(makeEvent({ handlerName: "few" }));
      journal.append(makeEvent({ handlerName: "many" }));
      journal.append(makeEvent({ handlerName: "many" }));
      journal.append(makeEvent({ handlerName: "many" }));

      const stats = telemetry.getHandlerStats();

      expect(stats[0]?.handlerName).toBe("many");
      expect(stats[1]?.handlerName).toBe("few");
    });
  });

  // ── getRetryStats ──────────────────────────────────────────────────────

  describe("getRetryStats()", () => {
    it("returns empty array when journal is empty", () => {
      const stats = telemetry.getRetryStats();

      expect(stats).toHaveLength(0);
    });

    it("computes total retries and average attempts", () => {
      journal.append(makeEvent({ handlerName: "retrier", attempts: 3 }));
      journal.append(makeEvent({ handlerName: "retrier", attempts: 2 }));
      journal.append(makeEvent({ handlerName: "retrier", attempts: 1 }));
      journal.append(makeEvent({ handlerName: "no-retries", attempts: 1 }));

      const stats = telemetry.getRetryStats();

      const retrier = stats.find((s) => s.handlerName === "retrier");
      expect(retrier).toBeDefined();
      // totalRetries = (3-1) + (2-1) + (1-1) = 3
      expect(retrier?.totalRetries).toBe(3);
      // avgAttempts = (3+2+1) / 3 = 2
      expect(retrier?.avgAttempts).toBe(2);

      const noRetries = stats.find((s) => s.handlerName === "no-retries");
      expect(noRetries).toBeDefined();
      expect(noRetries?.totalRetries).toBe(0);
      expect(noRetries?.avgAttempts).toBe(1);
    });

    it("sorts by totalRetries descending", () => {
      journal.append(makeEvent({ handlerName: "low", attempts: 1 }));
      journal.append(makeEvent({ handlerName: "high", attempts: 5 }));

      const stats = telemetry.getRetryStats();

      expect(stats[0]?.handlerName).toBe("high");
      expect(stats[1]?.handlerName).toBe("low");
    });
  });
});

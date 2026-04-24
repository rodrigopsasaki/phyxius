import { describe, expect, it } from "vitest";

import { createControlledClock } from "@phyxiusjs/clock";
import type { HandlerEvent } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";

import { createStats } from "../src/stats.js";
import type { StatsEvent } from "../src/types.js";

// ── Test helpers ───────────────────────────────────────────────────────────

function setup() {
  const clock = createControlledClock({ initialTime: 0 });
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 10_000 });
  const events: StatsEvent[] = [];
  return { clock, journal, events };
}

/** Build a HandlerEvent with only the fields stats cares about. */
function handlerEvent(name: string, durationMs: number, outcome: "success" | "failure" = "success"): HandlerEvent {
  const now = { wallMs: 0, monoMs: 0 };
  const base: HandlerEvent = {
    name,
    invocationId: `inv-${Math.random().toString(36).slice(2)}`,
    source: "test",
    startedAt: now,
    completedAt: now,
    durationMs,
    attempts: 1,
    outcome,
    observed: {},
  };
  return base;
}

// ── Basic snapshotting ─────────────────────────────────────────────────────

describe("createStats — snapshots", () => {
  it("returns null for a handler that hasn't emitted any events", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock });

    expect(stats.snapshot("never-invoked")).toBeNull();

    stats.stop();
  });

  it("records the first event and produces a meaningful snapshot", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock });

    journal.append(handlerEvent("order.process", 42));

    const snap = stats.snapshot("order.process");
    expect(snap).not.toBeNull();
    if (snap) {
      expect(snap.name).toBe("order.process");
      expect(snap.lifetimeCount).toBe(1);
      expect(snap.lifetimeFailures).toBe(0);
      expect(snap.windowSize).toBe(1);
      expect(snap.errorRate).toBe(0);
      expect(snap.p50Ms).toBe(42);
      expect(snap.p95Ms).toBe(42);
      expect(snap.p99Ms).toBe(42);
      expect(snap.minMs).toBe(42);
      expect(snap.maxMs).toBe(42);
      expect(snap.meanMs).toBe(42);
    }

    stats.stop();
  });

  it("tracks percentiles accurately over 100 samples", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock });

    // 90 fast, 10 slow
    for (let i = 1; i <= 90; i++) journal.append(handlerEvent("svc", i));
    for (let i = 0; i < 10; i++) journal.append(handlerEvent("svc", 500 + i * 100));

    const snap = stats.snapshot("svc");
    expect(snap).not.toBeNull();
    if (snap) {
      expect(snap.windowSize).toBe(100);
      expect(snap.p50Ms).toBeLessThanOrEqual(100);
      expect(snap.p95Ms).toBeGreaterThan(500);
      expect(snap.errorRate).toBe(0);
    }

    stats.stop();
  });

  it("tracks failures separately in lifetimeFailures and errorRate", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock });

    for (let i = 0; i < 8; i++) journal.append(handlerEvent("svc", 10, "success"));
    for (let i = 0; i < 2; i++) journal.append(handlerEvent("svc", 20, "failure"));

    const snap = stats.snapshot("svc");
    expect(snap).not.toBeNull();
    if (snap) {
      expect(snap.lifetimeCount).toBe(10);
      expect(snap.lifetimeFailures).toBe(2);
      expect(snap.errorRate).toBe(0.2);
    }

    stats.stop();
  });
});

// ── Ring buffer semantics ─────────────────────────────────────────────────

describe("createStats — ring buffer", () => {
  it("windowSize caps the sample set; older samples are dropped", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock, windowSize: 5 });

    // 10 events with ascending durations. Last 5 should be in the window.
    for (let i = 1; i <= 10; i++) journal.append(handlerEvent("svc", i));

    const snap = stats.snapshot("svc");
    expect(snap).not.toBeNull();
    if (snap) {
      expect(snap.lifetimeCount).toBe(10);
      expect(snap.windowSize).toBe(5);
      // Window contains 6..10 only.
      expect(snap.minMs).toBe(6);
      expect(snap.maxMs).toBe(10);
      expect(snap.meanMs).toBe(8);
    }

    stats.stop();
  });

  it("error rate reflects the current window, not all time", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock, windowSize: 5 });

    // 5 failures, then 5 successes. Window contains only the successes.
    for (let i = 0; i < 5; i++) journal.append(handlerEvent("svc", 10, "failure"));
    for (let i = 0; i < 5; i++) journal.append(handlerEvent("svc", 10, "success"));

    const snap = stats.snapshot("svc");
    if (snap) {
      expect(snap.lifetimeFailures).toBe(5); // total
      expect(snap.errorRate).toBe(0); // but current window has zero failures
    }

    stats.stop();
  });

  it("rejects windowSize <= 0 at construction", () => {
    const { clock, journal } = setup();
    expect(() => createStats({ journal, clock, windowSize: 0 })).toThrow(/windowSize/);
    expect(() => createStats({ journal, clock, windowSize: -1 })).toThrow(/windowSize/);
  });
});

// ── Multiple handlers ─────────────────────────────────────────────────────

describe("createStats — multiple handlers", () => {
  it("maintains independent stats per handler name", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock });

    journal.append(handlerEvent("fast", 5));
    journal.append(handlerEvent("slow", 500));
    journal.append(handlerEvent("fast", 6));
    journal.append(handlerEvent("slow", 600));

    const fast = stats.snapshot("fast");
    const slow = stats.snapshot("slow");
    expect(fast?.lifetimeCount).toBe(2);
    expect(slow?.lifetimeCount).toBe(2);
    expect(fast?.meanMs).toBe(5.5);
    expect(slow?.meanMs).toBe(550);

    stats.stop();
  });

  it("snapshotAll returns entries for all handlers with events", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock });

    journal.append(handlerEvent("a", 1));
    journal.append(handlerEvent("b", 2));
    journal.append(handlerEvent("c", 3));

    const all = stats.snapshotAll();
    expect(all).toHaveLength(3);
    const names = all.map((s) => s.name).sort();
    expect(names).toEqual(["a", "b", "c"]);

    stats.stop();
  });
});

// ── Threshold alerts ──────────────────────────────────────────────────────

describe("createStats — thresholds", () => {
  it("emits stats:threshold-breached when errorRate crosses the limit", () => {
    const { clock, journal, events } = setup();
    const stats = createStats({
      journal,
      clock,
      windowSize: 10,
      thresholds: { "flaky.svc": { errorRate: 0.1 } },
      emit: (e) => events.push(e),
    });

    // 9 successes, 1 failure → errorRate = 0.1, NOT greater than 0.1.
    for (let i = 0; i < 9; i++) journal.append(handlerEvent("flaky.svc", 10, "success"));
    journal.append(handlerEvent("flaky.svc", 10, "failure"));

    expect(events.filter((e) => e.type === "stats:threshold-breached")).toHaveLength(0);

    // Second failure → errorRate = 2/10 = 0.2 > 0.1 → breach.
    journal.append(handlerEvent("flaky.svc", 10, "failure"));

    const breaches = events.filter((e) => e.type === "stats:threshold-breached");
    expect(breaches).toHaveLength(1);
    if (breaches[0]?.type === "stats:threshold-breached") {
      expect(breaches[0].field).toBe("errorRate");
      expect(breaches[0].handler).toBe("flaky.svc");
      expect(breaches[0].limit).toBe(0.1);
    }

    stats.stop();
  });

  it("emits stats:threshold-recovered when the value drops back below the limit", () => {
    const { clock, journal, events } = setup();
    const stats = createStats({
      journal,
      clock,
      windowSize: 10,
      thresholds: { svc: { errorRate: 0.3 } },
      emit: (e) => events.push(e),
    });

    // Fill window with 4 failures + 6 successes → errorRate 0.4 (breach).
    for (let i = 0; i < 4; i++) journal.append(handlerEvent("svc", 10, "failure"));
    for (let i = 0; i < 6; i++) journal.append(handlerEvent("svc", 10, "success"));

    const breachesAfterInit = events.filter((e) => e.type === "stats:threshold-breached");
    expect(breachesAfterInit).toHaveLength(1);

    // Push 10 successes, evicting failures from the ring. errorRate → 0.
    for (let i = 0; i < 10; i++) journal.append(handlerEvent("svc", 10, "success"));

    const recoveries = events.filter((e) => e.type === "stats:threshold-recovered");
    expect(recoveries).toHaveLength(1);
    if (recoveries[0]?.type === "stats:threshold-recovered") {
      expect(recoveries[0].field).toBe("errorRate");
    }

    stats.stop();
  });

  it("alerts are edge-triggered — one event per state change, not per update", () => {
    const { clock, journal, events } = setup();
    const stats = createStats({
      journal,
      clock,
      windowSize: 5,
      thresholds: { svc: { errorRate: 0.0 } },
      emit: (e) => events.push(e),
    });

    // Breach on first failure (errorRate > 0).
    journal.append(handlerEvent("svc", 10, "failure"));
    expect(events.filter((e) => e.type === "stats:threshold-breached")).toHaveLength(1);

    // More failures — same breach state, no new events.
    journal.append(handlerEvent("svc", 10, "failure"));
    journal.append(handlerEvent("svc", 10, "failure"));
    expect(events.filter((e) => e.type === "stats:threshold-breached")).toHaveLength(1);

    stats.stop();
  });

  it("evaluates p50 / p95 / p99 thresholds independently per field", () => {
    const { clock, journal, events } = setup();
    const stats = createStats({
      journal,
      clock,
      windowSize: 10,
      thresholds: { svc: { p95Ms: 50, p99Ms: 200 } },
      emit: (e) => events.push(e),
    });

    // Normal samples (p95 = 10, p99 = 10). No breach yet.
    for (let i = 0; i < 10; i++) journal.append(handlerEvent("svc", 10));
    expect(events).toHaveLength(0);

    // Introduce outliers — push the p95 and p99 over their limits.
    for (let i = 0; i < 10; i++) journal.append(handlerEvent("svc", 1000));

    const breachFields = events
      .filter((e) => e.type === "stats:threshold-breached")
      .map((e) => (e.type === "stats:threshold-breached" ? e.field : ""));

    expect(breachFields).toContain("p95Ms");
    expect(breachFields).toContain("p99Ms");

    stats.stop();
  });

  it("handlers without a threshold entry are not checked", () => {
    const { clock, journal, events } = setup();
    const stats = createStats({
      journal,
      clock,
      thresholds: { tracked: { errorRate: 0.0 } },
      emit: (e) => events.push(e),
    });

    // Push failures on an *untracked* handler — no alerts should fire.
    for (let i = 0; i < 10; i++) journal.append(handlerEvent("untracked", 10, "failure"));
    expect(events).toHaveLength(0);

    // But tracking the tracked one works.
    journal.append(handlerEvent("tracked", 10, "failure"));
    expect(events.filter((e) => e.type === "stats:threshold-breached")).toHaveLength(1);

    stats.stop();
  });
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

describe("createStats — lifecycle", () => {
  it("stops observing new events after stop() is called", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock });

    journal.append(handlerEvent("svc", 10));
    stats.stop();
    journal.append(handlerEvent("svc", 20));

    const snap = stats.snapshot("svc");
    if (snap) {
      expect(snap.lifetimeCount).toBe(1); // only the event before stop counted
    }
  });

  it("stop() is idempotent", () => {
    const { clock, journal } = setup();
    const stats = createStats({ journal, clock });

    stats.stop();
    stats.stop();
    stats.stop();
  });
});

import { describe, expect, it } from "vitest";

import { ms } from "@phyxiusjs/clock";
import type { Instant } from "@phyxiusjs/clock";

import { at, every, never, schedule } from "../src/schedule.js";

function instant(wallMs: number, monoMs = wallMs): Instant {
  return { wallMs, monoMs };
}

describe("schedule.every", () => {
  it("computes next tick by adding interval", () => {
    const s = every(ms(100));
    const next = s.nextTick(instant(0));
    expect(next).toEqual({ wallMs: 100, monoMs: 100 });
  });

  it("is stateless — same input yields same output", () => {
    const s = every(ms(250));
    expect(s.nextTick(instant(1000))).toEqual({ wallMs: 1250, monoMs: 1250 });
    expect(s.nextTick(instant(1000))).toEqual({ wallMs: 1250, monoMs: 1250 });
  });

  it("rejects zero or negative intervals at construction time", () => {
    expect(() => every(0 as never)).toThrow(/must be > 0/);
    expect(() => every(-1 as never)).toThrow(/must be > 0/);
  });
});

describe("schedule.at", () => {
  it("fires once at a future instant", () => {
    const target = instant(5000);
    const s = at(target);
    expect(s.nextTick(instant(1000))).toEqual(target);
  });

  it("exhausts after one fire (stateful one-shot)", () => {
    const target = instant(5000);
    const s = at(target);
    expect(s.nextTick(instant(1000))).toEqual(target);
    expect(s.nextTick(instant(5001))).toBeNull();
  });

  it("returns null immediately if the target is already in the past", () => {
    const s = at(instant(100));
    expect(s.nextTick(instant(500))).toBeNull();
  });
});

describe("schedule.never", () => {
  it("always returns null", () => {
    const s = never();
    expect(s.nextTick(instant(0))).toBeNull();
    expect(s.nextTick(instant(1_000_000))).toBeNull();
  });
});

describe("schedule namespace", () => {
  it("exposes every, at, never", () => {
    expect(schedule.every).toBe(every);
    expect(schedule.at).toBe(at);
    expect(schedule.never).toBe(never);
  });
});

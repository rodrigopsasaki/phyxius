import { getEventListeners } from "node:events";
import { describe, it, expect } from "vitest";
import { createControlledClock } from "../src/controlled-clock.js";
import { sleepOrAbort } from "../src/sleep-or-abort.js";
import type { Millis } from "../src/types.js";

describe("sleepOrAbort", () => {
  it("resolves false when the sleep completes before any abort", async () => {
    const clock = createControlledClock();
    const controller = new AbortController();

    let resolved: boolean | undefined;
    const promise = sleepOrAbort(clock, 100 as Millis, controller.signal).then((aborted) => {
      resolved = aborted;
    });

    expect(resolved).toBeUndefined();

    clock.advanceBy(100 as Millis);
    await promise;

    expect(resolved).toBe(false);
  });

  it("resolves true when the signal aborts before the sleep completes", async () => {
    const clock = createControlledClock();
    const controller = new AbortController();

    const promise = sleepOrAbort(clock, 1000 as Millis, controller.signal);

    controller.abort();

    await expect(promise).resolves.toBe(true);
  });

  it("resolves true immediately when the signal is already aborted on entry", async () => {
    const clock = createControlledClock();
    const controller = new AbortController();
    controller.abort();

    const before = clock.getPendingTimerCount();
    const result = await sleepOrAbort(clock, 1000 as Millis, controller.signal);

    expect(result).toBe(true);
    // Already-aborted is a fast path — it never even sets up a timer.
    expect(clock.getPendingTimerCount()).toBe(before);
  });

  it("never rejects, regardless of which side wins", async () => {
    const clock = createControlledClock();

    const winByCompletion = new AbortController();
    const completes = sleepOrAbort(clock, 50 as Millis, winByCompletion.signal);
    clock.advanceBy(50 as Millis);
    await expect(completes).resolves.toBe(false);

    const winByAbort = new AbortController();
    const aborts = sleepOrAbort(clock, 50 as Millis, winByAbort.signal);
    winByAbort.abort();
    await expect(aborts).resolves.toBe(true);
  });

  it("removes its abort listener once the sleep wins, leaving no listener leak", async () => {
    const clock = createControlledClock();
    const controller = new AbortController();

    const promise = sleepOrAbort(clock, 100 as Millis, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    clock.advanceBy(100 as Millis);
    await promise;

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("with no signal, sleeps and resolves false without registering a listener", async () => {
    const clock = createControlledClock();

    const promise = sleepOrAbort(clock, 100 as Millis);
    clock.advanceBy(100 as Millis);

    await expect(promise).resolves.toBe(false);
  });
});

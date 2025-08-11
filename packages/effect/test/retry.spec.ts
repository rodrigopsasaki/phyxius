/* eslint-disable no-console */
import { describe, it, expect } from "vitest";
import { effect } from "../src/index.js";
import type { RetryPolicy } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Retry", () => {
  it("should fail twice then succeed", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let attempts = 0;

    const eventuallySuccessfulEffect = effect(async () => {
      attempts++;
      console.log(`=== Attempt ${attempts} started at time ${clock.now().monoMs} ===`);
      if (attempts < 3) {
        console.log(`Attempt ${attempts} will fail`);
        return { _tag: "Err", error: `failure-${attempts}` };
      }
      console.log(`Attempt ${attempts} will succeed`);
      return { _tag: "Ok", value: "success" };
    });

    const retryPolicy: RetryPolicy = {
      maxAttempts: 3,
      baseDelayMs: 100,
      backoffFactor: 1, // No exponential backoff for simplicity
    };

    console.log("Starting retry...");
    const resultPromise = eventuallySuccessfulEffect.retry(retryPolicy).unsafeRunPromise({ clock });

    console.log("Waiting for first attempt...");
    await new Promise((resolve) => setImmediate(resolve));

    console.log("First attempt should have failed, advancing clock by 100ms...");
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    console.log("Second attempt should have failed, advancing clock by 100ms...");
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    console.log("Third attempt should succeed, waiting for result...");
    const result = await resultPromise;

    expect(result).toEqual({ _tag: "Ok", value: "success" });
    expect(attempts).toBe(3);
  });

  it("should work with exponential backoff", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let attempts = 0;

    const eventuallySuccessfulEffect = effect(async () => {
      attempts++;
      console.log(`=== Attempt ${attempts} started at time ${clock.now().monoMs} ===`);
      if (attempts < 3) {
        console.log(`Attempt ${attempts} will fail`);
        return { _tag: "Err", error: `failure-${attempts}` };
      }
      console.log(`Attempt ${attempts} will succeed`);
      return { _tag: "Ok", value: "success" };
    });

    const retryPolicy: RetryPolicy = {
      maxAttempts: 3,
      baseDelayMs: 100,
      backoffFactor: 2, // Exponential backoff: 100ms, 200ms
    };

    console.log("Starting retry with exponential backoff...");
    const resultPromise = eventuallySuccessfulEffect.retry(retryPolicy).unsafeRunPromise({ clock });

    console.log("Waiting for first attempt...");
    await new Promise((resolve) => setImmediate(resolve));

    console.log("First attempt failed, should sleep 100ms (baseDelay * 2^0)");
    clock.advanceBy(ms(100));
    await new Promise((resolve) => setImmediate(resolve));

    console.log("Second attempt failed, should sleep 200ms (baseDelay * 2^1)");
    clock.advanceBy(ms(200));
    await new Promise((resolve) => setImmediate(resolve));

    console.log("Third attempt should succeed...");
    const result = await resultPromise;

    expect(result).toEqual({ _tag: "Ok", value: "success" });
    expect(attempts).toBe(3);
  });
});

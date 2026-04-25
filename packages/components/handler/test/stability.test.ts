import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ms } from "@phyxiusjs/clock";

import { cb, defineHandler, retry, stability, type StabilityPolicy } from "../src/index.js";

// `stability.policy` is a thin freezer with a typed shape — the value
// of these tests is locking the contract that makes the named-policy
// pattern work: identity-preserving, frozen, spread-compatible with
// `defineHandler`.

describe("stability.policy", () => {
  function makePolicy(overrides: Partial<StabilityPolicy> = {}): StabilityPolicy {
    return {
      timeout: ms(2_000),
      concurrency: { max: 50, queueSize: 200, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      ...overrides,
    };
  }

  it("returns the policy with the same field values", () => {
    const input = makePolicy();
    const policy = stability.policy(input);

    expect(policy.timeout).toBe(input.timeout);
    expect(policy.concurrency).toEqual(input.concurrency);
    expect(policy.retry).toBe(input.retry);
    expect(policy.circuitBreaker).toBe(input.circuitBreaker);
  });

  it("freezes the returned object — accidental mutation throws in strict mode", () => {
    const policy = stability.policy(makePolicy());
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("two policy values are independent — mutation of one doesn't bleed into the other", () => {
    const a = stability.policy(makePolicy({ timeout: ms(1_000) }));
    const b = stability.policy(makePolicy({ timeout: ms(5_000) }));

    expect(a.timeout).toBe(1_000);
    expect(b.timeout).toBe(5_000);
  });

  it("spreads cleanly into a defineHandler call — the no-non-decision rule still holds at the type level", () => {
    // The point of this test isn't runtime behavior; it's that the
    // call typechecks. defineHandler still requires every stability
    // field, but they're satisfied via the spread rather than written
    // out per-handler.
    const interactiveHttp = stability.policy(makePolicy());

    const spec = defineHandler({
      ...interactiveHttp,
      name: "test.lookup",
      input: z.object({ id: z.string() }),
      output: z.object({ found: z.boolean() }),
      fields: {} as never,
      run: async ({ id }) => ({ found: id.length > 0 }),
    });

    expect(spec.name).toBe("test.lookup");
    expect(spec.timeout).toBe(2_000);
  });

  it("a per-handler override takes precedence over the spread policy", () => {
    // Explicit override after the spread is the ergonomic escape hatch
    // for "this one handler is the same archetype but needs a longer
    // timeout." Still explicit. Still legible.
    const interactiveHttp = stability.policy(makePolicy({ timeout: ms(2_000) }));

    const spec = defineHandler({
      ...interactiveHttp,
      timeout: ms(8_000),
      name: "test.slow-lookup",
      input: z.object({ id: z.string() }),
      output: z.object({ found: z.boolean() }),
      fields: {} as never,
      run: async () => ({ found: true }),
    });

    expect(spec.timeout).toBe(8_000);
  });
});

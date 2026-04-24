import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { cb, retry, spawn, type HandlerEvent } from "@phyxiusjs/handler";
import { isErr, isOk } from "@phyxiusjs/fp";

import { ConnectorFailure, defineConnector, isConnectorFailure, type ConnectorError } from "../src/index.js";

// These tests are the real proof that "ConnectorSpec extends HandlerSpec"
// is the right shape: every test goes through the handler's `spawn`, runs
// through the handler's retry loop, and ends up in the handler's journal
// — no connector-specific plumbing needed. The defineConnector wrapper is
// invisible to everything downstream except the retry predicate and the
// output cause.

describe("defineConnector", () => {
  function makeRuntime() {
    const clock = createControlledClock({ initialTime: 0 });
    const journal = new Journal<HandlerEvent>({ clock });
    return { clock, journal };
  }

  function makeFields() {
    return observe.fields({
      provider: observe.field<string>(),
    });
  }

  it("wraps thrown values via mapError into ConnectorFailure", async () => {
    const fields = makeFields();
    const spec = defineConnector({
      name: "test.unauth",
      provider: "stripe",
      input: z.object({}),
      output: z.object({}),
      fields,
      timeout: ms(1000),
      concurrency: { max: 1, queueSize: 1, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      mapError: (cause): ConnectorError => ({ type: "UNAUTHORIZED", cause }),
      run: async () => {
        throw new Error("stripe 401");
      },
    });

    const { clock, journal } = makeRuntime();
    const handler = await spawn(spec, { clock, journal });
    const result = await handler.invoke({});

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.type === "HANDLER_ERROR") {
      expect(isConnectorFailure(result.error.cause)).toBe(true);
      if (isConnectorFailure(result.error.cause)) {
        expect(result.error.cause.provider).toBe("stripe");
        expect(result.error.cause.error.type).toBe("UNAUTHORIZED");
      }
    }

    await handler.stop();
  });

  it("passes successful runs through unchanged", async () => {
    const fields = makeFields();
    const spec = defineConnector({
      name: "test.ok",
      provider: "slack",
      input: z.object({ msg: z.string() }),
      output: z.object({ ts: z.string() }),
      fields,
      timeout: ms(1000),
      concurrency: { max: 1, queueSize: 1, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      mapError: (cause): ConnectorError => ({ type: "PROVIDER_ERROR", cause }),
      run: async ({ msg }) => ({ ts: `echo:${msg}` }),
    });

    const { clock, journal } = makeRuntime();
    const handler = await spawn(spec, { clock, journal });
    const result = await handler.invoke({ msg: "hello" });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({ ts: "echo:hello" });
    }

    await handler.stop();
  });

  it("is idempotent — nested defineConnector does NOT double-wrap", async () => {
    // The innermost provider's identity is what callers want to see on a
    // failure. If an inner connector already produced a ConnectorFailure,
    // the outer one must not shadow it.
    const fields = makeFields();

    const innerSpec = defineConnector({
      name: "test.inner",
      provider: "inner-provider",
      input: z.object({}),
      output: z.object({}),
      fields,
      timeout: ms(1000),
      concurrency: { max: 1, queueSize: 1, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      mapError: (cause): ConnectorError => ({ type: "RATE_LIMITED", cause }),
      run: async () => {
        throw new Error("inner failure");
      },
    });

    const outerSpec = defineConnector({
      name: "test.outer",
      provider: "outer-provider",
      input: z.object({}),
      output: z.object({}),
      fields,
      timeout: ms(1000),
      concurrency: { max: 1, queueSize: 1, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      // This mapError must NEVER be invoked — the inner already produced
      // a ConnectorFailure, so the outer's wrapping is skipped.
      mapError: (): ConnectorError => ({
        type: "PROVIDER_ERROR",
        cause: new Error("outer should not see this"),
      }),
      run: async () => {
        // Simulate a composed connector: outer calls inner's run. We
        // inline the throw to keep the test runtime-free — the point is
        // that a ConnectorFailure thrown from inside an outer's run is
        // re-thrown unchanged.
        throw new ConnectorFailure("inner-provider", { type: "RATE_LIMITED", cause: "x" });
      },
    });

    const { clock, journal } = makeRuntime();
    const handler = await spawn(outerSpec, { clock, journal });
    const result = await handler.invoke({});

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.type === "HANDLER_ERROR" && isConnectorFailure(result.error.cause)) {
      // Inner identity preserved.
      expect(result.error.cause.provider).toBe("inner-provider");
      expect(result.error.cause.error.type).toBe("RATE_LIMITED");
    }

    await handler.stop();

    // Silence unused-var if inner was imported only for the intent.
    void innerSpec;
  });

  it("retry predicates can narrow on isConnectorFailure and match variants", async () => {
    // The payoff: the retry policy reads the typed error vocabulary, not
    // some provider-specific slug. Any connector that implements mapError
    // correctly gets this retry behavior for free.
    const fields = makeFields();

    let attempts = 0;
    const spec = defineConnector({
      name: "test.retries",
      provider: "http",
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      fields,
      timeout: ms(5000),
      concurrency: { max: 1, queueSize: 1, backpressure: "reject" },
      retry: retry.fixed({
        maxAttempts: 3,
        delay: ms(0),
        shouldRetry: (cause) => {
          if (!isConnectorFailure(cause)) return false;
          const { type } = cause.error;
          return type === "RATE_LIMITED" || type === "PROVIDER_ERROR";
        },
      }),
      circuitBreaker: cb.none(),
      mapError: (cause): ConnectorError => ({ type: "RATE_LIMITED", cause }),
      run: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("throttled");
        return { ok: true as const };
      },
    });

    const { clock, journal } = makeRuntime();
    const handler = await spawn(spec, { clock, journal });
    const result = await handler.invoke({});

    expect(attempts).toBe(3);
    expect(isOk(result)).toBe(true);

    await handler.stop();
  });

  it("declined retries (e.g. UNAUTHORIZED) fail fast without retry", async () => {
    const fields = makeFields();

    let attempts = 0;
    const spec = defineConnector({
      name: "test.no-retry",
      provider: "http",
      input: z.object({}),
      output: z.object({}),
      fields,
      timeout: ms(5000),
      concurrency: { max: 1, queueSize: 1, backpressure: "reject" },
      retry: retry.fixed({
        maxAttempts: 5,
        delay: ms(0),
        shouldRetry: (cause) => {
          if (!isConnectorFailure(cause)) return false;
          // UNAUTHORIZED is not in the retryable set — we give up immediately.
          return cause.error.type !== "UNAUTHORIZED";
        },
      }),
      circuitBreaker: cb.none(),
      mapError: (cause): ConnectorError => ({ type: "UNAUTHORIZED", cause }),
      run: async () => {
        attempts += 1;
        throw new Error("bad creds");
      },
    });

    const { clock, journal } = makeRuntime();
    const handler = await spawn(spec, { clock, journal });
    const result = await handler.invoke({});

    expect(attempts).toBe(1); // one try, no retries — surface to caller.
    expect(isErr(result)).toBe(true);

    await handler.stop();
  });

  it("produces a standard HandlerEvent — same journal shape as any handler", async () => {
    const fields = makeFields();
    const spec = defineConnector({
      name: "test.journal",
      provider: "openai",
      input: z.object({}),
      output: z.object({}),
      fields,
      timeout: ms(1000),
      concurrency: { max: 1, queueSize: 1, backpressure: "reject" },
      retry: retry.none(),
      circuitBreaker: cb.none(),
      mapError: (cause): ConnectorError => ({ type: "PROVIDER_ERROR", cause }),
      run: async (_, __) => {
        fields.provider.set("openai");
        return {};
      },
    });

    const { clock, journal } = makeRuntime();
    const handler = await spawn(spec, { clock, journal });
    await handler.invoke({});

    const { entries } = journal.getSnapshot();
    expect(entries.length).toBe(1);
    expect(entries[0]?.data.name).toBe("test.journal");
    expect(entries[0]?.data.outcome).toBe("success");
    expect(entries[0]?.data.observed).toMatchObject({ provider: "openai" });

    await handler.stop();
  });
});

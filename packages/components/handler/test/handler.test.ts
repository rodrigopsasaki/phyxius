import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { isOk, isErr } from "@phyxiusjs/fp";
import { defineHandler, spawn, retry, cb, type HandlerEvent, type HandlerRuntime } from "../src/index.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function setup() {
  const clock = createControlledClock({ initialTime: 0 });
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 100 });
  const runtime: HandlerRuntime = { clock, journal };
  return { clock, journal, runtime };
}

const echoFields = observe.fields({
  echoed: observe.field<string>(),
});

// Baseline handler: validates input, returns it doubled, declares all stability.
const doubleSchema = defineHandler({
  name: "double",
  input: z.object({ value: z.number() }),
  output: z.object({ doubled: z.number() }),
  fields: echoFields,
  timeout: ms(1000),
  concurrency: { max: 2, queueSize: 10, backpressure: "reject" },
  retry: retry.none(),
  circuitBreaker: cb.none(),
  run: async ({ value }) => ({ doubled: value * 2 }),
});

describe("@phyxiusjs/handler", () => {
  describe("defineHandler", () => {
    it("should return the spec unchanged (pure data)", () => {
      expect(doubleSchema.name).toBe("double");
    });

    it("should reject invalid concurrency", () => {
      expect(() =>
        defineHandler({
          ...doubleSchema,
          concurrency: { max: 0, queueSize: 10, backpressure: "reject" },
        }),
      ).toThrow(/concurrency\.max/);
    });

    it("should reject negative timeout", () => {
      expect(() => defineHandler({ ...doubleSchema, timeout: -1 as never })).toThrow(/timeout/);
    });
  });

  describe("happy path", () => {
    it("should validate input, run, validate output, return Ok", async () => {
      const { runtime, journal } = setup();
      const handler = await spawn(doubleSchema, runtime);

      const result = await handler.invoke({ value: 7 });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toEqual({ doubled: 14 });

      // One journal entry, outcome success.
      const snap = journal.getSnapshot();
      expect(snap.entries).toHaveLength(1);
      expect(snap.entries[0]?.data.outcome).toBe("success");
      expect(snap.entries[0]?.data.name).toBe("double");
      expect(snap.entries[0]?.data.attempts).toBe(1);

      await handler.stop();
    });

    it("should capture caller-written observe fields on the journal entry", async () => {
      const { runtime, journal } = setup();
      const fields = observe.fields({
        userId: observe.field<string>(),
        foo: observe.field<string>(),
      });

      const h = defineHandler({
        name: "observer",
        input: z.object({ u: z.string() }),
        output: z.object({ ok: z.boolean() }),
        fields,
        timeout: ms(1000),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        run: async ({ u }) => {
          fields.userId.set(u);
          fields.foo.set("bar");
          return { ok: true };
        },
      });

      const handler = await spawn(h, runtime);
      await handler.invoke({ u: "alice" });

      const entry = journal.getSnapshot().entries[0];
      expect(entry?.data.observed).toMatchObject({ userId: "alice", foo: "bar" });

      await handler.stop();
    });

    it("should carry correlationId + source + meta on the entry", async () => {
      const { runtime, journal } = setup();
      const handler = await spawn(doubleSchema, runtime);

      await handler.invoke(
        { value: 1 },
        { correlationId: "req-123", source: "http", context: { method: "POST", path: "/x" } },
      );

      const entry = journal.getSnapshot().entries[0]?.data;
      expect(entry?.correlationId).toBe("req-123");
      expect(entry?.source).toBe("http");
      expect(entry?.meta).toMatchObject({ method: "POST", path: "/x" });

      await handler.stop();
    });
  });

  describe("VALIDATION_ERROR (input)", () => {
    it("should return VALIDATION_ERROR with target 'input'", async () => {
      const { runtime, journal } = setup();
      const handler = await spawn(doubleSchema, runtime);

      // Wrong shape — Zod will reject
      const result = await handler.invoke({ value: "not-a-number" } as never);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.type).toBe("VALIDATION_ERROR");
        if (result.error.type === "VALIDATION_ERROR") {
          expect(result.error.target).toBe("input");
          expect(result.error.error.issues.length).toBeGreaterThan(0);
        }
      }

      const entry = journal.getSnapshot().entries[0]?.data;
      expect(entry?.outcome).toBe("failure");
      expect(entry?.error?.type).toBe("VALIDATION_ERROR");

      await handler.stop();
    });
  });

  describe("VALIDATION_ERROR (output)", () => {
    it("should return VALIDATION_ERROR with target 'output'", async () => {
      const { runtime } = setup();

      const lyingHandler = defineHandler({
        name: "lies",
        input: z.object({ x: z.number() }),
        output: z.object({ doubled: z.number() }),
        fields: echoFields,
        timeout: ms(1000),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        run: async () => ({ doubled: "not a number" }) as never,
      });

      const handler = await spawn(lyingHandler, runtime);
      const result = await handler.invoke({ x: 1 });

      expect(isErr(result)).toBe(true);
      if (isErr(result) && result.error.type === "VALIDATION_ERROR") {
        expect(result.error.target).toBe("output");
      }

      await handler.stop();
    });
  });

  describe("HANDLER_ERROR", () => {
    it("should capture thrown errors as HANDLER_ERROR", async () => {
      const { runtime, journal } = setup();

      const throwing = defineHandler({
        name: "throws",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(1000),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        run: async () => {
          throw new Error("boom");
        },
      });

      const handler = await spawn(throwing, runtime);
      const result = await handler.invoke({});

      expect(isErr(result)).toBe(true);
      if (isErr(result) && result.error.type === "HANDLER_ERROR") {
        expect((result.error.cause as Error).message).toBe("boom");
      }

      const entry = journal.getSnapshot().entries[0]?.data;
      expect(entry?.error?.type).toBe("HANDLER_ERROR");
      expect(entry?.error?.message).toBe("boom");

      await handler.stop();
    });
  });

  describe("TIMEOUT", () => {
    it("should return TIMEOUT when run exceeds budget (abort-aware body)", async () => {
      const { runtime, journal, clock } = setup();

      const slow = defineHandler({
        name: "slow",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(100),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        run: async (_input, { clock: c, signal }) => {
          // Wait for the budget to abort.
          return new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
            void c.sleep(ms(10_000));
          });
        },
      });

      const handler = await spawn(slow, runtime);
      const pending = handler.invoke({});

      // Let the scope open and budget register its timer.
      await Promise.resolve();
      await Promise.resolve();

      clock.advanceBy(ms(100));
      await clock.flush();
      await new Promise((r) => setImmediate(r));

      const result = await pending;
      // The invocation's own Result always classifies as TIMEOUT — the
      // per-attempt race against the budget (see raceAttempt in handler.ts)
      // settles the invocation itself before the body's own abort handling
      // can ever turn its rejection into the invocation's answer.
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.type).toBe("TIMEOUT");

      // The body's own rejection (from its `signal` listener) still lands,
      // but only as the orphan-settlement for the attempt that lost the
      // race — never as this invocation's own outcome. Look the entry up
      // by name rather than by array position: whether the primary entry or
      // the orphan entry is journaled first is unconstrained microtask
      // ordering (both fire off the same abort tick), not a signal either
      // way.
      const entry = journal.getSnapshot().entries.find((e) => e.data.name === "slow")?.data;
      expect(entry?.outcome).toBe("failure");
      expect(entry?.error?.type).toBe("TIMEOUT");

      await handler.stop();
    });

    it("should settle TIMEOUT at the deadline for a non-cooperative body that never settles", async () => {
      const { runtime, journal, clock } = setup();

      const wedged = defineHandler({
        name: "wedged",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(100),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        // Never resolves, never rejects, and completely ignores `signal` —
        // the non-cooperative body the bug report describes (a wedged
        // socket, a hung query).
        run: () => new Promise<never>(() => {}),
      });

      const handler = await spawn(wedged, runtime);
      const pending = handler.invoke({});

      await Promise.resolve();
      await Promise.resolve();

      clock.advanceBy(ms(100));
      await clock.flush();

      const result = await pending;
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.type).toBe("TIMEOUT");

      const entry = journal.getSnapshot().entries[0]?.data;
      expect(entry?.name).toBe("wedged");
      expect(entry?.outcome).toBe("failure");
      expect(entry?.error?.type).toBe("TIMEOUT");

      await handler.stop();
    });

    it("should free the concurrency slot at timeout so a subsequent invoke is admitted", async () => {
      const { runtime, clock } = setup();

      const wedged = defineHandler({
        name: "wedged",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(100),
        concurrency: { max: 1, queueSize: 0, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        run: () => new Promise<never>(() => {}),
      });

      const handler = await spawn(wedged, runtime);
      const first = handler.invoke({});

      await Promise.resolve();
      await Promise.resolve();

      // Capacity is max(1) + queueSize(0) = 1 — a second invoke right now
      // would be rejected while the first is still active.
      const busyMetrics = handler.getMetrics();
      expect(busyMetrics.activeCount).toBe(1);

      clock.advanceBy(ms(100));
      await clock.flush();

      const firstResult = await first;
      expect(isErr(firstResult)).toBe(true);
      if (isErr(firstResult)) expect(firstResult.error.type).toBe("TIMEOUT");

      // The slot must be free now — the abandoned body is still running in
      // the background, but it no longer holds a concurrency slot.
      expect(handler.getMetrics().activeCount).toBe(0);

      const second = handler.invoke({});
      await Promise.resolve();
      await Promise.resolve();

      // Admitted, not BACKPRESSURE_REJECT — proves the slot was actually
      // freed, not just eventually garbage-collected.
      expect(handler.getMetrics().activeCount).toBe(1);

      clock.advanceBy(ms(100));
      await clock.flush();

      const secondResult = await second;
      expect(isErr(secondResult)).toBe(true);
      if (isErr(secondResult)) expect(secondResult.error.type).toBe("TIMEOUT");

      await handler.stop();
    });

    it("should journal an orphan-settlement event when the abandoned body eventually settles, without double-decrementing activeCount", async () => {
      const { runtime, journal, clock } = setup();

      const wedged = defineHandler({
        name: "wedged",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(100),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        // Ignores the signal, but eventually settles on its own — a slow
        // downstream call that isn't wired to `signal`, not a truly
        // eternal hang.
        run: async (_input, { clock: c }) => {
          await c.sleep(ms(10_000));
          throw new Error("finally gave up");
        },
      });

      const handler = await spawn(wedged, runtime);
      const pending = handler.invoke({});

      await Promise.resolve();
      await Promise.resolve();

      clock.advanceBy(ms(100));
      await clock.flush();

      const result = await pending;
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.type).toBe("TIMEOUT");

      // Only the invocation's own entry so far — the orphan hasn't settled.
      expect(journal.getSnapshot().entries).toHaveLength(1);
      expect(handler.getMetrics().activeCount).toBe(0);

      // Let the abandoned body's own sleep fire and throw.
      clock.advanceBy(ms(10_000));
      await clock.flush();
      await new Promise((r) => setImmediate(r));

      const {entries} = journal.getSnapshot();
      expect(entries).toHaveLength(2);

      const orphanEntry = entries[1]?.data;
      expect(orphanEntry?.name).toBe("wedged.orphan-settlement");
      expect(orphanEntry?.invocationId).toBe(entries[0]?.data.invocationId);
      expect(orphanEntry?.source).toBe("internal");
      expect(orphanEntry?.outcome).toBe("failure");
      expect(orphanEntry?.error?.message).toBe("finally gave up");

      // The orphan settling must never touch activeCount again.
      expect(handler.getMetrics().activeCount).toBe(0);

      await handler.stop();
    });
  });

  describe("retry", () => {
    it("should retry on failure and succeed", async () => {
      const { runtime, journal, clock } = setup();

      let attempts = 0;
      const flaky = defineHandler({
        name: "flaky",
        input: z.any(),
        output: z.object({ attempt: z.number() }),
        fields: echoFields,
        timeout: ms(5000),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.fixed({ maxAttempts: 3, delay: ms(10) }),
        circuitBreaker: cb.none(),
        run: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`fail #${attempts}`);
          return { attempt: attempts };
        },
      });

      const handler = await spawn(flaky, runtime);
      const pending = handler.invoke({});

      // Advance the clock past each retry delay.
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        clock.advanceBy(ms(10));
        await clock.flush();
      }

      const result = await pending;

      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toEqual({ attempt: 3 });

      const entry = journal.getSnapshot().entries[0]?.data;
      expect(entry?.attempts).toBe(3);

      await handler.stop();
    });

    it("should return RETRY_EXHAUSTED when all attempts fail", async () => {
      const { runtime, clock } = setup();

      const alwaysFails = defineHandler({
        name: "alwaysFails",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(5000),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.fixed({ maxAttempts: 2, delay: ms(10) }),
        circuitBreaker: cb.none(),
        run: async () => {
          throw new Error("always");
        },
      });

      const handler = await spawn(alwaysFails, runtime);
      const pending = handler.invoke({});

      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        clock.advanceBy(ms(10));
        await clock.flush();
      }

      const result = await pending;
      expect(isErr(result)).toBe(true);
      if (isErr(result) && result.error.type === "RETRY_EXHAUSTED") {
        expect(result.error.attempts).toBe(2);
      }

      await handler.stop();
    });

    it("should classify a budget expiry on the final attempt as TIMEOUT, not RETRY_EXHAUSTED or HANDLER_ERROR", async () => {
      const { runtime, journal, clock } = setup();

      let attempt = 0;
      const flakyThenWedged = defineHandler({
        name: "flakyThenWedged",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(50),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.fixed({ maxAttempts: 2, delay: ms(10) }),
        circuitBreaker: cb.none(),
        run: async (_input, { clock: c }) => {
          attempt += 1;
          if (attempt === 1) throw new Error("first attempt fails fast");
          // Final attempt: ignores `signal` entirely and eventually throws
          // long after the budget will have expired.
          await c.sleep(ms(10_000));
          throw new Error("late failure — never reaches the caller");
        },
      });

      const handler = await spawn(flakyThenWedged, runtime);
      const pending = handler.invoke({});

      // Let attempt 1 run to completion (it fails synchronously) and
      // register the inter-attempt retry-delay timer before advancing the
      // clock — otherwise a same-tick advance can sweep past a timer that
      // hasn't been registered yet, skipping straight to the budget
      // deadline without attempt 2 ever starting.
      await clock.flush();
      await Promise.resolve();

      // Fire the 10ms retry delay — this starts attempt 2.
      clock.advanceBy(ms(10));
      await clock.flush();
      await Promise.resolve();

      // Let attempt 2 register its own race against the budget (and its
      // own 10s sleep) before advancing further.
      await clock.flush();
      await Promise.resolve();

      // Advance past the remaining budget (50ms total) while attempt 2 is
      // in flight — this expires the budget mid-attempt on the LAST
      // allowed attempt, exercising the EXHAUSTED+BudgetExpiredThrown path.
      clock.advanceBy(ms(40));
      await clock.flush();
      await new Promise((r) => setImmediate(r));

      const result = await pending;
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.type).toBe("TIMEOUT");

      const entry = journal.getSnapshot().entries[0]?.data;
      expect(entry?.error?.type).toBe("TIMEOUT");

      // The orphaned final attempt eventually throws — confirm it's
      // reported as an orphan, not folded back into the invocation result.
      clock.advanceBy(ms(10_000));
      await clock.flush();
      await new Promise((r) => setImmediate(r));

      const orphanEntry = journal.getSnapshot().entries[1]?.data;
      expect(orphanEntry?.name).toBe("flakyThenWedged.orphan-settlement");
      expect(orphanEntry?.outcome).toBe("failure");

      await handler.stop();
    });
  });

  describe("circuit breaker", () => {
    it("should short-circuit with CIRCUIT_OPEN after consecutive failures", async () => {
      const { runtime } = setup();

      const failing = defineHandler({
        name: "cb-fail",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(1000),
        concurrency: { max: 1, queueSize: 5, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.policy({ failureThreshold: 2, resetTimeout: ms(10_000) }),
        run: async () => {
          throw new Error("downstream down");
        },
      });

      const handler = await spawn(failing, runtime);

      // First two failures feed the breaker.
      await handler.invoke({});
      await handler.invoke({});

      // Third call is short-circuited.
      const third = await handler.invoke({});
      expect(isErr(third)).toBe(true);
      if (isErr(third)) expect(third.error.type).toBe("CIRCUIT_OPEN");

      expect(handler.getMetrics().circuitState).toBe("open");

      await handler.stop();
    });

    it("should report 'disabled' circuit state when using cb.none()", async () => {
      const { runtime } = setup();
      const handler = await spawn(doubleSchema, runtime);

      expect(handler.getMetrics().circuitState).toBe("disabled");

      await handler.stop();
    });
  });

  describe("concurrency + backpressure", () => {
    it("should BACKPRESSURE_REJECT when queue is full", async () => {
      const { runtime, clock } = setup();

      const slow = defineHandler({
        name: "slow",
        input: z.any(),
        output: z.any(),
        fields: echoFields,
        timeout: ms(10_000),
        concurrency: { max: 1, queueSize: 1, backpressure: "reject" },
        retry: retry.none(),
        circuitBreaker: cb.none(),
        run: async ({ clock: c }) => {
          await c.sleep(ms(1000));
          return {};
        },
      });

      const handler = await spawn(slow, runtime);

      // Fire three — capacity is max(1) + queueSize(1) = 2. The third rejects.
      const p1 = handler.invoke({});
      const p2 = handler.invoke({});
      const p3 = handler.invoke({});

      // Let the first one start executing.
      await Promise.resolve();
      await Promise.resolve();

      const r3 = await p3;
      expect(isErr(r3)).toBe(true);
      if (isErr(r3)) expect(r3.error.type).toBe("BACKPRESSURE_REJECT");

      // Drain the others so the handler can stop cleanly.
      clock.advanceBy(ms(1000));
      await clock.flush();
      await p1;
      clock.advanceBy(ms(1000));
      await clock.flush();
      await p2;

      await handler.stop();
    });
  });

  describe("HANDLER_NOT_RUNNING", () => {
    it("should reject invocations after stop", async () => {
      const { runtime } = setup();
      const handler = await spawn(doubleSchema, runtime);

      await handler.stop();

      const result = await handler.invoke({ value: 1 });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.type).toBe("HANDLER_NOT_RUNNING");
    });
  });

  describe("metrics", () => {
    it("should track total invocations, successes, failures", async () => {
      const { runtime } = setup();
      const handler = await spawn(doubleSchema, runtime);

      await handler.invoke({ value: 1 });
      await handler.invoke({ value: 2 });
      await handler.invoke({ value: "bad" } as never); // validation fails

      const m = handler.getMetrics();
      expect(m.totalInvocations).toBe(3);
      expect(m.totalSuccesses).toBe(2);
      expect(m.totalFailures).toBe(1);

      await handler.stop();
    });
  });

  describe("one journal entry per invocation, shape-stable across outcomes", () => {
    it("should always produce exactly one entry, success or failure", async () => {
      const { runtime, journal } = setup();
      const handler = await spawn(doubleSchema, runtime);

      await handler.invoke({ value: 1 });
      await handler.invoke({ value: "bad" } as never);
      await handler.invoke({ value: 2 });

      const { entries } = journal.getSnapshot();
      expect(entries).toHaveLength(3);
      for (const e of entries) {
        expect(e.data).toHaveProperty("name", "double");
        expect(e.data).toHaveProperty("invocationId");
        expect(e.data).toHaveProperty("startedAt");
        expect(e.data).toHaveProperty("durationMs");
        expect(e.data).toHaveProperty("attempts");
        expect(e.data).toHaveProperty("outcome");
      }

      await handler.stop();
    });
  });
});

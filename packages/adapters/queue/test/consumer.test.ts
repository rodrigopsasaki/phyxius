import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createSystemClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import {
  cb,
  defineHandler,
  retry,
  spawn,
  type HandlerEvent,
  type HandlerRuntime,
  type RunningHandler,
} from "@phyxiusjs/handler";

import { createQueueConsumer } from "../src/consumer.js";
import { createMemorySource } from "../src/memory-source.js";
import type { MessageSource, QueueMessage } from "../src/types.js";

// ── Test helpers ───────────────────────────────────────────────────────────

function setupHandlerRuntime() {
  // Real system clock for handler runtime — the handler spawns timers that
  // need to actually fire. The queue consumer's own timing uses a system
  // clock too; the memory source can use either.
  const clock = createSystemClock();
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 1000 });
  const runtime: HandlerRuntime = { clock, journal };
  return { clock, journal, runtime };
}

const orderFields = observe.fields({
  customerId: observe.field<string>(),
  amount: observe.number(),
});

function makeOrderSpec(behavior: { fail?: "throw" | "timeout" | "none"; delayMs?: number }) {
  return defineHandler({
    name: "order.process",
    input: z.object({ customerId: z.string().min(1), amount: z.number().positive() }),
    output: z.object({ chargeId: z.string(), amount: z.number() }),
    fields: orderFields,

    timeout: ms(1_000),
    concurrency: { max: 4, queueSize: 10, backpressure: "reject" },
    retry: retry.none(),
    circuitBreaker: cb.none(),

    run: async ({ customerId, amount }, { clock }) => {
      orderFields.customerId.set(customerId);
      orderFields.amount.set(amount);
      if (behavior.delayMs) {
        await clock.sleep(ms(behavior.delayMs));
      }
      if (behavior.fail === "throw") {
        throw new Error("intentional handler failure");
      }
      return { chargeId: `ch_${customerId}`, amount };
    },
  });
}

// Wait helper — polls for a predicate instead of sleeping on a fixed deadline.
async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createQueueConsumer", () => {
  it("pulls a message, invokes the handler, acks on success", async () => {
    const { runtime, journal } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({}), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      clock: runtime.clock,
    });

    await consumer.start();
    source.enqueue({ body: { customerId: "alice", amount: 99.99 } });

    await waitUntil(() => source.getAckHistory().length === 1);

    // Transport-stable journal entry — same shape as HTTP.
    const {entries} = journal.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.source).toBe("queue");
    expect(entries[0]?.data.outcome).toBe("success");
    expect(entries[0]?.data.observed).toMatchObject({ customerId: "alice", amount: 99.99 });

    // correlationId defaults to the message ID when no header is set.
    expect(entries[0]?.data.correlationId).toMatch(/^msg-/);

    await consumer.stop();
    await handler.stop();
  });

  it("uses x-correlation-id header when present, falling back to message ID otherwise", async () => {
    const { runtime, journal } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({}), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      clock: runtime.clock,
    });

    await consumer.start();
    source.enqueue({
      body: { customerId: "alice", amount: 1 },
      headers: { "x-correlation-id": "trace-upstream-123" },
    });

    await waitUntil(() => source.getAckHistory().length === 1);

    const {entries} = journal.getSnapshot();
    expect(entries[0]?.data.correlationId).toBe("trace-upstream-123");

    await consumer.stop();
    await handler.stop();
  });

  it("dead-letters on input VALIDATION_ERROR — default encoder", async () => {
    const { runtime, journal } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({}), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      clock: runtime.clock,
    });

    await consumer.start();
    // amount: -1 fails Zod's .positive()
    source.enqueue({ body: { customerId: "bob", amount: -1 } });

    await waitUntil(() => source.getDeadLettered().length === 1);

    expect(source.getDeadLettered()[0]?.cause).toBe("validation:input");
    expect(source.getAckHistory()).toHaveLength(0);

    // The journal records the failure the same way HTTP would.
    const {entries} = journal.getSnapshot();
    expect(entries[0]?.data.outcome).toBe("failure");
    expect(entries[0]?.data.error?.type).toBe("VALIDATION_ERROR");

    await consumer.stop();
    await handler.stop();
  });

  // Per-variant HandlerError → QueueOutcome mapping is exhaustively covered
  // in encode.test.ts. Here we prove the retry-nack path runs end-to-end
  // against a real handler without infinite-looping — we use a custom
  // source that discards retried messages instead of redelivering them, so
  // the test reaches its assertion after exactly one cycle.
  it("retries on HANDLER_ERROR (run threw) — nacked via retry reason", async () => {
    const { runtime } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({ fail: "throw" }), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    // Wrap nack so retried messages are recorded but not redelivered.
    const recordedNacks: { messageId: string; reason: { type: string; cause?: string } }[] = [];
    const recordingSource: MessageSource = {
      receive: (signal) => source.receive(signal),
      ack: (msg) => source.ack(msg),
      nack: async (msg, reason) => {
        recordedNacks.push({ messageId: msg.id, reason });
        // Swallow — don't requeue.
      },
      close: () => source.close?.() ?? Promise.resolve(),
    };

    const consumer = createQueueConsumer({
      source: recordingSource,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      clock: runtime.clock,
    });

    await consumer.start();
    source.enqueue({ body: { customerId: "dave", amount: 1 } });

    await waitUntil(() => recordedNacks.length >= 1);

    expect(recordedNacks[0]?.reason.type).toBe("retry");
    expect(recordedNacks[0]?.reason.cause).toBe("handler_error");

    await consumer.stop();
    await handler.stop();
  });

  it("dead-letters when decode throws", async () => {
    const { runtime } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({}), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const events: unknown[] = [];
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: () => {
        throw new Error("decode exploded");
      },
      clock: runtime.clock,
      emit: (e) => events.push(e),
    });

    await consumer.start();
    source.enqueue({ body: "anything" });

    await waitUntil(() => source.getDeadLettered().length === 1);

    expect(source.getDeadLettered()[0]?.cause).toBe("decode_error");
    // A decode_error event was emitted for operational visibility.
    expect(
      events.some(
        (e): e is { type: string } =>
          typeof e === "object" && e !== null && "type" in e && e.type === "queue:decode_error",
      ),
    ).toBe(true);

    await consumer.stop();
    await handler.stop();
  });

  it("respects the route-level onResult override", async () => {
    const { runtime } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({ fail: "throw" }), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    // Override: on any handler error, DLQ immediately instead of retrying.
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      onResult: (result) => {
        if (result._tag === "Ok") return { action: "ack" };
        return { action: "nack", reason: { type: "dead-letter", cause: "custom_policy" } };
      },
      clock: runtime.clock,
    });

    await consumer.start();
    source.enqueue({ body: { customerId: "eve", amount: 1 } });

    await waitUntil(() => source.getDeadLettered().length === 1);

    expect(source.getDeadLettered()[0]?.cause).toBe("custom_policy");

    await consumer.stop();
    await handler.stop();
  });

  it("processes messages serially when maxConcurrent=1 (default)", async () => {
    const { runtime } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({ delayMs: 30 }), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      clock: runtime.clock,
    });

    await consumer.start();

    for (let i = 0; i < 3; i++) {
      source.enqueue({ body: { customerId: `c${i}`, amount: 1 } });
    }

    // At any moment, getInFlight() on the consumer must be <= 1.
    const samples: number[] = [];
    const sampleInterval = setInterval(() => samples.push(consumer.getInFlight()), 5);

    await waitUntil(() => source.getAckHistory().length === 3);
    clearInterval(sampleInterval);

    expect(Math.max(...samples)).toBeLessThanOrEqual(1);

    await consumer.stop();
    await handler.stop();
  });

  it("processes messages in parallel when maxConcurrent > 1", async () => {
    const { runtime } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({ delayMs: 30 }), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      maxConcurrent: 3,
      clock: runtime.clock,
    });

    await consumer.start();

    for (let i = 0; i < 5; i++) {
      source.enqueue({ body: { customerId: `c${i}`, amount: 1 } });
    }

    // Sample inFlight to see parallelism actually happens.
    const samples: number[] = [];
    const sampleInterval = setInterval(() => samples.push(consumer.getInFlight()), 5);

    await waitUntil(() => source.getAckHistory().length === 5);
    clearInterval(sampleInterval);

    expect(Math.max(...samples)).toBeGreaterThan(1);

    await consumer.stop();
    await handler.stop();
  });

  it("graceful stop drains in-flight work before resolving", async () => {
    const { runtime } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({ delayMs: 30 }), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      maxConcurrent: 2,
      clock: runtime.clock,
    });

    await consumer.start();
    source.enqueue({ body: { customerId: "a", amount: 1 } });
    source.enqueue({ body: { customerId: "b", amount: 1 } });

    // Let both messages be pulled in-flight.
    await waitUntil(() => consumer.getInFlight() === 2);

    await consumer.stop();

    // Both must have settled by the time stop resolves.
    expect(consumer.getStatus()).toBe("stopped");
    expect(source.getAckHistory().length + source.getNackHistory().length).toBe(2);

    await handler.stop();
  });

  it("stop() is idempotent", async () => {
    const { runtime } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({}), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body,
      clock: runtime.clock,
    });

    await consumer.start();
    await Promise.all([consumer.stop(), consumer.stop(), consumer.stop()]);
    expect(consumer.getStatus()).toBe("stopped");

    await handler.stop();
  });

  it("rejects maxConcurrent < 1 at construction", () => {
    const clock = createSystemClock();
    const source = createMemorySource({ clock });
    expect(() =>
      createQueueConsumer({
        source,
        handler: {} as RunningHandler<unknown, unknown>,
        decode: () => null,
        clock,
        maxConcurrent: 0,
      }),
    ).toThrow(/maxConcurrent/);
  });

  it("journal entries match HTTP's shape exactly — transport-stable", async () => {
    const { runtime, journal } = setupHandlerRuntime();
    const handler = await spawn(makeOrderSpec({}), runtime);

    const source = createMemorySource({ clock: runtime.clock });
    const consumer = createQueueConsumer({
      source,
      handler,
      decode: (msg) => msg.body as { customerId: string; amount: number },
      clock: runtime.clock,
    });

    await consumer.start();
    source.enqueue({ body: { customerId: "z", amount: 42 } });
    await waitUntil(() => source.getAckHistory().length === 1);

    const entry = journal.getSnapshot().entries[0]!;

    // Every HandlerEvent field that matters for observability parity.
    expect(entry.data).toMatchObject({
      name: "order.process",
      source: "queue",
      outcome: "success",
      attempts: 1,
    });
    expect(entry.data.invocationId).toMatch(/^inv-/);
    expect(typeof entry.data.durationMs).toBe("number");
    expect(entry.data.observed).toMatchObject({ customerId: "z", amount: 42 });

    await consumer.stop();
    await handler.stop();
  });
});

// ── Type-level sanity check ────────────────────────────────────────────────

describe("MessageSource", () => {
  it("is structurally compatible with custom implementations", () => {
    // A hand-rolled source must be assignable to MessageSource. This is a
    // compile-time guarantee — if it ever breaks, broker adapters will stop
    // being drop-in.
    const handRolled: MessageSource = {
      receive: vi.fn<() => Promise<QueueMessage | null>>().mockResolvedValue(null),
      ack: vi.fn<(m: QueueMessage) => Promise<void>>().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
    };
    expect(handRolled).toBeDefined();
  });
});

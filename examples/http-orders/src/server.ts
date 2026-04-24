/**
 * End-to-end Phyxius demo: HTTP adapter → handler → journal → stdout drain.
 *
 * One process, one handler, one supervisor-managed lifecycle. Every request
 * produces exactly one `HandlerEvent` on stdout, regardless of outcome. Try:
 *
 *   curl -s -X POST http://localhost:3000/orders \
 *     -H 'content-type: application/json' \
 *     -H 'x-correlation-id: req-alice-1' \
 *     -d '{"customerId":"alice","amount":99.99}'
 *
 *   curl -s http://localhost:3000/orders/abc123
 *
 *   curl -s -X POST http://localhost:3000/orders \
 *     -H 'content-type: application/json' \
 *     -d '{"customerId":"bob","amount":-1}'     # 400 VALIDATION_ERROR
 */

import { createServer } from "node:http";
import { z } from "zod";

import { createSystemClock, formatIso, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { observe } from "@phyxiusjs/observe";
import { cb, defineHandler, retry, spawn, type HandlerEvent } from "@phyxiusjs/handler";
import { createHttpAdapter } from "@phyxiusjs/http";
import { createDrain, stdoutSink } from "@phyxiusjs/drain";

// ── Observability schema ──────────────────────────────────────────────────

const orderFields = observe.fields({
  customerId: observe.field<string>(),
  amount: observe.number(),
  chargeId: observe.field<string>(),
});

const lookupFields = observe.fields({
  orderId: observe.field<string>(),
});

// ── Handlers ──────────────────────────────────────────────────────────────

const processOrder = defineHandler({
  name: "order.process",
  input: z.object({
    customerId: z.string().min(1),
    amount: z.number().positive(),
  }),
  output: z.object({
    chargeId: z.string(),
    amount: z.number(),
  }),
  fields: orderFields,

  timeout: ms(5_000),
  concurrency: { max: 20, queueSize: 100, backpressure: "reject" },
  retry: retry.exponential({ maxAttempts: 3, initialDelay: ms(200) }),
  circuitBreaker: cb.policy({ failureThreshold: 10, resetTimeout: ms(30_000) }),

  run: async ({ customerId, amount }) => {
    // Simulate a charge. In a real system this would hit Stripe, etc.
    orderFields.customerId.set(customerId);
    orderFields.amount.set(amount);
    const chargeId = `ch_${Math.random().toString(36).slice(2, 10)}`;
    orderFields.chargeId.set(chargeId);
    return { chargeId, amount };
  },
});

const getOrder = defineHandler({
  name: "order.lookup",
  input: z.object({ orderId: z.string().min(1) }),
  output: z.object({
    orderId: z.string(),
    status: z.string(),
    createdAt: z.string(),
  }),
  fields: lookupFields,

  timeout: ms(2_000),
  concurrency: { max: 50, queueSize: 200, backpressure: "reject" },
  retry: retry.none(),
  circuitBreaker: cb.none(),

  run: async ({ orderId }, { clock }) => {
    lookupFields.orderId.set(orderId);
    return {
      orderId,
      status: "processed",
      createdAt: formatIso(clock.now()),
    };
  },
});

// ── Wire everything up ────────────────────────────────────────────────────

async function main() {
  const clock = createSystemClock();
  const journal = new Journal<HandlerEvent>({ clock, maxEntries: 10_000 });

  // Stream every journal entry to stdout as a JSON line.
  const drain = createDrain<HandlerEvent>({
    journal,
    sink: stdoutSink<HandlerEvent>(),
    clock,
    batchSize: 1, // one-line-per-request for demo readability
    flushIntervalMs: ms(1_000),
  });

  const processHandler = await spawn(processOrder, { clock, journal });
  const lookupHandler = await spawn(getOrder, { clock, journal });

  const adapter = createHttpAdapter({
    routes: [
      {
        method: "POST",
        path: "/orders",
        handler: processHandler,
        decode: (req) => req.body as { customerId: string; amount: number },
      },
      {
        method: "GET",
        path: "/orders/:id",
        handler: lookupHandler,
        decode: (req) => ({ orderId: req.params["id"] ?? "" }),
      },
    ],
  });

  const server = createServer(adapter.listener);
  const port = Number(process.env["PORT"] ?? 3000);

  await new Promise<void>((resolve) => server.listen(port, resolve));
   
  console.error(`[http-orders] listening on http://localhost:${port}`);
   
  console.error(`[http-orders] journal events → stdout (JSON lines)`);

  // ── Graceful shutdown ──────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
     
    console.error(`[http-orders] received ${signal}, draining…`);

    // 1. Stop accepting new connections. In-flight requests continue.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    // 2. Stop handlers — drains active invocations up to drainTimeoutMs.
    await Promise.all([
      processHandler.stop({ drainTimeoutMs: ms(10_000) }),
      lookupHandler.stop({ drainTimeoutMs: ms(10_000) }),
    ]);

    // 3. Flush the drain so no journal entries are lost.
    await drain.stop();

     
    console.error(`[http-orders] clean exit`);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
   
  console.error("[http-orders] fatal:", err);
  process.exit(1);
});

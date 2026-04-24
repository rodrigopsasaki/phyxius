import { describe, expect, it } from "vitest";

import { createControlledClock, ms } from "@phyxiusjs/clock";

import { createMemorySource } from "../src/memory-source.js";

function setup() {
  const clock = createControlledClock({ initialTime: 0 });
  const source = createMemorySource({ clock });
  return { clock, source };
}

describe("createMemorySource", () => {
  it("delivers an enqueued message to a waiting receive()", async () => {
    const { source } = setup();

    const receivePromise = source.receive();
    source.enqueue({ body: { v: 1 } });

    const msg = await receivePromise;
    expect(msg?.body).toEqual({ v: 1 });
    expect(msg?.id).toMatch(/^msg-/);
    expect(source.getInFlight()).toHaveLength(1);
  });

  it("delivers a pre-enqueued message immediately", async () => {
    const { source } = setup();

    source.enqueue({ body: "first" });
    const msg = await source.receive();

    expect(msg?.body).toBe("first");
  });

  it("ack clears in-flight and appends to history", async () => {
    const { source } = setup();
    source.enqueue({ body: "hi" });
    const msg = (await source.receive())!;

    await source.ack(msg);

    expect(source.getInFlight()).toHaveLength(0);
    expect(source.getAckHistory()).toHaveLength(1);
    expect(source.getAckHistory()[0]?.id).toBe(msg.id);
  });

  it("nack dead-letter records cause and does not requeue", async () => {
    const { source } = setup();
    source.enqueue({ body: "bad" });
    const msg = (await source.receive())!;

    await source.nack(msg, { type: "dead-letter", cause: "validation:input" });

    expect(source.getInFlight()).toHaveLength(0);
    expect(source.getDeadLettered()).toHaveLength(1);
    expect(source.getDeadLettered()[0]?.cause).toBe("validation:input");
    expect(source.getPending()).toHaveLength(0);
  });

  it("nack requeue-now puts the message back and increments delivery count", async () => {
    const { source } = setup();
    source.enqueue({ body: "try-again" });
    const msg = (await source.receive())!;
    expect(msg.deliveryCount).toBe(1);

    await source.nack(msg, { type: "requeue-now" });

    const again = await source.receive();
    expect(again?.body).toBe("try-again");
    expect(again?.deliveryCount).toBe(2);
  });

  it("nack retry without delay requeues immediately", async () => {
    const { source } = setup();
    source.enqueue({ body: "x" });
    const msg = (await source.receive())!;

    await source.nack(msg, { type: "retry" });

    const again = await source.receive();
    expect(again?.body).toBe("x");
    expect(again?.deliveryCount).toBe(2);
  });

  it("nack retry with delay honors the injected clock", async () => {
    const { clock, source } = setup();
    source.enqueue({ body: "slow" });
    const msg = (await source.receive())!;

    await source.nack(msg, { type: "retry", delayMs: ms(500) });

    // Nothing pending yet — the requeue is scheduled on the clock.
    expect(source.getPending()).toHaveLength(0);

    // Still nothing before the deadline.
    await clock.advanceBy(ms(400));
    await clock.flush();
    expect(source.getPending()).toHaveLength(0);

    // Cross the deadline — the requeue lands.
    await clock.advanceBy(ms(200));
    await clock.flush();
    expect(source.getPending()).toHaveLength(1);
    expect(source.getPending()[0]?.body).toBe("slow");
  });

  it("receive() resolves with null when the abort signal fires", async () => {
    const { source } = setup();
    const controller = new AbortController();

    const receivePromise = source.receive(controller.signal);
    controller.abort();

    await expect(receivePromise).resolves.toBeNull();
  });

  it("close() wakes a blocked receive() with null", async () => {
    const { source } = setup();
    const receivePromise = source.receive();

    await source.close?.();

    await expect(receivePromise).resolves.toBeNull();
  });

  it("tracks full nack history for assertions", async () => {
    const { source } = setup();
    source.enqueue({ body: "a" });
    const m1 = (await source.receive())!;
    await source.nack(m1, { type: "retry", cause: "timeout:1000ms" });

    const m2 = (await source.receive())!;
    await source.nack(m2, { type: "dead-letter", cause: "retry_exhausted:3" });

    const history = source.getNackHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.reason.type).toBe("retry");
    expect(history[1]?.reason.type).toBe("dead-letter");
  });
});

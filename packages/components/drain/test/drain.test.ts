import { describe, it, expect } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { createDrain } from "../src/drain.js";
import type { Sink, DrainEntry, DrainEvent } from "../src/types.js";

interface TestData {
  msg: string;
}

function createTestSink(): Sink<TestData> & { written: DrainEntry<TestData>[][] } {
  const written: DrainEntry<TestData>[][] = [];
  return {
    written,
    async write(entries) {
      written.push([...entries]);
    },
  };
}

describe("createDrain", () => {
  it("should flush entries to sink on manual flush", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
    });

    journal.append({ msg: "hello" });
    journal.append({ msg: "world" });

    await drain.flush();

    expect(sink.written.length).toBe(1);
    expect(sink.written[0]).toHaveLength(2);
    expect(sink.written[0]?.[0]?.data.msg).toBe("hello");
    expect(sink.written[0]?.[1]?.data.msg).toBe("world");

    await drain.stop();
  });

  it("should auto-flush when buffer reaches batchSize", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 2,
      flushIntervalMs: ms(60000),
    });

    journal.append({ msg: "one" });
    journal.append({ msg: "two" });

    // Give the async flush a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(sink.written.length).toBe(1);
    expect(sink.written[0]).toHaveLength(2);

    await drain.stop();
  });

  it("should flush remaining entries on stop", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
    });

    journal.append({ msg: "pending" });

    await drain.stop();

    expect(sink.written.length).toBe(1);
    expect(sink.written[0]?.[0]?.data.msg).toBe("pending");
  });

  it("should not accept entries after stop", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
    });

    await drain.stop();

    // Append after stop — should not reach the sink
    journal.append({ msg: "after-stop" });
    await drain.flush();

    // Only the stop flush (which was empty)
    expect(sink.written.length).toBe(0);
  });

  it("should preserve entry metadata from journal", async () => {
    const clock = createControlledClock({ initialTime: 5000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
    });

    journal.append({ msg: "test" });
    await drain.flush();

    const entry = sink.written[0]?.[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    expect(entry.sequence).toBe(0);
    expect(entry.timestamp.wallMs).toBe(5000);
    expect(entry.id).toBeDefined();
    expect(entry.data.msg).toBe("test");

    await drain.stop();
  });

  it("should emit drain:flush events", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();
    const events: DrainEvent[] = [];

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
      emit: (event) => events.push(event),
    });

    journal.append({ msg: "test" });
    await drain.flush();

    const flushEvent = events.find((e) => e.type === "drain:flush");
    expect(flushEvent).toBeDefined();
    if (flushEvent?.type === "drain:flush") {
      expect(flushEvent.count).toBe(1);
    }

    await drain.stop();
  });

  it("should emit drain:error when sink throws", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const events: DrainEvent[] = [];

    const failingSink: Sink<TestData> = {
      async write() {
        throw new Error("sink failure");
      },
    };

    const drain = createDrain({
      journal,
      sink: failingSink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
      emit: (event) => events.push(event),
    });

    journal.append({ msg: "test" });
    await drain.flush();

    const errorEvent = events.find((e) => e.type === "drain:error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "drain:error") {
      expect(errorEvent.error).toBeInstanceOf(Error);
    }

    await drain.stop();
  });

  it("should emit drain:stop event", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();
    const events: DrainEvent[] = [];

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
      emit: (event) => events.push(event),
    });

    await drain.stop();

    const stopEvent = events.find((e) => e.type === "drain:stop");
    expect(stopEvent).toBeDefined();
    if (stopEvent?.type === "drain:stop") {
      expect(stopEvent.remaining).toBe(0);
    }
  });

  it("should handle multiple flushes without data loss", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
    });

    journal.append({ msg: "batch-1a" });
    journal.append({ msg: "batch-1b" });
    await drain.flush();

    journal.append({ msg: "batch-2a" });
    await drain.flush();

    expect(sink.written.length).toBe(2);
    expect(sink.written[0]).toHaveLength(2);
    expect(sink.written[1]).toHaveLength(1);

    const allMessages = sink.written.flatMap((batch) => batch.map((e) => e.data.msg));
    expect(allMessages).toEqual(["batch-1a", "batch-1b", "batch-2a"]);

    await drain.stop();
  });

  it("should not flush when buffer is empty", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60000),
    });

    await drain.flush();
    await drain.flush();

    expect(sink.written.length).toBe(0);

    await drain.stop();
  });

  // ── New behaviors after refactor ──────────────────────────────────────────

  it("should re-queue on sink failure so transient errors don't lose data", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const events: DrainEvent[] = [];

    let failNextWrite = true;
    const flakySink: Sink<TestData> = {
      async write(entries) {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("transient");
        }
        writes.push([...entries]);
      },
    };
    const writes: DrainEntry<TestData>[][] = [];

    const drain = createDrain({
      journal,
      sink: flakySink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(60_000),
      emit: (e) => events.push(e),
    });

    journal.append({ msg: "a" });
    journal.append({ msg: "b" });

    // First flush — sink throws; batch is re-queued.
    await drain.flush();
    const errEvent = events.find((e) => e.type === "drain:error");
    expect(errEvent).toBeDefined();
    if (errEvent?.type === "drain:error") {
      expect(errEvent.requeued).toBe(2);
    }
    expect(writes).toHaveLength(0);

    // Second flush — sink recovers; the same batch is delivered.
    await drain.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(2);
    expect(writes[0]?.[0]?.data.msg).toBe("a");
    expect(writes[0]?.[1]?.data.msg).toBe("b");

    await drain.stop();
  });

  it("should drop_oldest when buffer reaches maxBufferSize (sink stuck)", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const events: DrainEvent[] = [];

    // A sink whose write never resolves — models a stuck or very slow sink.
    // This is the only realistic way the buffer fills past the cap: if the
    // sink kept up, the sync splice would empty the buffer between appends.
    const stuckSink: Sink<TestData> = {
      write: () => new Promise<void>(() => {}),
    };

    // Drain is created for its journal subscription side-effect; we don't
    // call methods on it directly in this test — the overflow events are
    // what we observe.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const drain = createDrain({
      journal,
      sink: stuckSink,
      clock,
      batchSize: 3,
      maxBufferSize: 5,
      overflow: "drop_oldest",
      flushIntervalMs: ms(60_000),
      emit: (e) => events.push(e),
    });

    // First 3 appends trigger a flush — batch of [1..3] is spliced out and
    // the sink write hangs, holding `flushing=true`.
    journal.append({ msg: "1" });
    journal.append({ msg: "2" });
    journal.append({ msg: "3" });

    // Subsequent appends accumulate in the buffer (flush is stuck).
    journal.append({ msg: "4" });
    journal.append({ msg: "5" });
    journal.append({ msg: "6" });
    journal.append({ msg: "7" });
    journal.append({ msg: "8" }); // buffer now at maxBufferSize (5)
    journal.append({ msg: "9" }); // overflow — evicts "4"
    journal.append({ msg: "10" }); // overflow — evicts "5"

    const overflowEvents = events.filter((e) => e.type === "drain:overflow");
    expect(overflowEvents.length).toBe(2);
    expect(overflowEvents[0]?.type === "drain:overflow" && overflowEvents[0]?.policy).toBe("drop_oldest");
  });

  it("should drop new entries under 'error' overflow policy (sink stuck)", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const events: DrainEvent[] = [];

    const stuckSink: Sink<TestData> = {
      write: () => new Promise<void>(() => {}),
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const drain = createDrain({
      journal,
      sink: stuckSink,
      clock,
      batchSize: 3,
      maxBufferSize: 5,
      overflow: "error",
      flushIntervalMs: ms(60_000),
      emit: (e) => events.push(e),
    });

    // First 3 trigger flush → hangs. Buffer stays empty until re-fill.
    journal.append({ msg: "1" });
    journal.append({ msg: "2" });
    journal.append({ msg: "3" });

    journal.append({ msg: "4" });
    journal.append({ msg: "5" });
    journal.append({ msg: "6" });
    journal.append({ msg: "7" });
    journal.append({ msg: "8" }); // buffer now full
    journal.append({ msg: "9" }); // rejected
    journal.append({ msg: "10" }); // rejected

    const overflowEvents = events.filter((e) => e.type === "drain:overflow");
    expect(overflowEvents.length).toBe(2);
    expect(overflowEvents[0]?.type === "drain:overflow" && overflowEvents[0]?.policy).toBe("error");
  });

  it("should use the injected Clock for periodic flush scheduling", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 100,
      flushIntervalMs: ms(1_000),
    });

    journal.append({ msg: "tick" });
    expect(sink.written).toHaveLength(0); // not yet flushed

    // Advance the controlled clock past the interval — the Clock-driven
    // loop picks up the entry without any real setTimeout.
    clock.advanceBy(ms(1_000));
    await clock.flush();
    // Give the async flush body one microtask cycle to settle.
    await new Promise((r) => setImmediate(r));

    expect(sink.written).toHaveLength(1);
    expect(sink.written[0]?.[0]?.data.msg).toBe("tick");

    await drain.stop();
  });

  it("should reject invalid size configuration at construction", () => {
    const clock = createControlledClock({ initialTime: 0 });
    const journal = new Journal<TestData>({ clock });
    const sink = createTestSink();

    expect(() => createDrain({ journal, sink, clock, batchSize: 0 })).toThrow(/batchSize/);

    expect(() => createDrain({ journal, sink, clock, maxBufferSize: 0 })).toThrow(/maxBufferSize/);

    expect(() => createDrain({ journal, sink, clock, batchSize: 100, maxBufferSize: 10 })).toThrow(
      /batchSize.*maxBufferSize/,
    );
  });
});

import { describe, it, expect } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { createDrain } from "../src/drain.js";
import type { Sink, DrainEntry } from "../src/types.js";

interface TestData {
  msg: string;
}

/**
 * A sink whose first write blocks until released — the only way to hold the
 * drain in its `flushing` state across a `stop()` call.
 */
function createBlockingSink(): Sink<TestData> & {
  written: DrainEntry<TestData>[][];
  release: () => void;
} {
  const written: DrainEntry<TestData>[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;

  return {
    written,
    release: () => release(),
    async write(entries) {
      if (first) {
        first = false;
        await gate;
      }
      written.push([...entries]);
    },
  };
}

describe("drain stop() under an in-flight flush", () => {
  it("does not lose buffered entries when stop races a flush", async () => {
    const clock = createControlledClock({ initialTime: 1000 });
    const journal = new Journal<TestData>({ clock });
    const sink = createBlockingSink();

    const drain = createDrain({
      journal,
      sink,
      clock,
      batchSize: 1,
      flushIntervalMs: ms(60_000),
    });

    // First entry starts a flush that blocks inside the sink.
    journal.append({ msg: "first" });
    const inFlight = drain.flush();
    await Promise.resolve();

    // Second entry lands while that flush is still in-flight.
    journal.append({ msg: "second" });

    // Shutdown races the in-flight flush.
    const stopping = drain.stop();
    sink.release();
    await Promise.all([inFlight, stopping]);

    const delivered = sink.written.flat().map((e) => e.data.msg);
    expect(delivered).toContain("first");
    expect(delivered).toContain("second");
  });
});

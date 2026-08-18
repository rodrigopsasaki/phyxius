import { describe, it, expect } from "vitest";
import { createSystemClock } from "@phyxiusjs/clock";
import { Supervisor } from "../src/index.js";
import type { ProcessSpec } from "../src/index.js";

interface TestEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Event-driven rather than sleep-driven on purpose. A fixed delay here would
 * be load-bearing — it has to outlast failure → decide → backoff — and a
 * loaded runner that missed the window would pass this test by never observing
 * the failure at all, which is the worst way for a test about silent drops to
 * go green.
 */
function eventWaiter(): {
  emit: (event: unknown) => void;
  events: unknown[];
  waitFor: (type: string) => Promise<void>;
} {
  const events: unknown[] = [];
  const waiting = new Map<string, () => void>();

  return {
    events,
    emit: (event: unknown) => {
      events.push(event);
      const { type } = event as TestEvent;
      waiting.get(type)?.();
      waiting.delete(type);
    },
    waitFor: (type: string) =>
      new Promise<void>((resolve) => {
        if (events.some((e) => (e as TestEvent).type === type)) return resolve();
        waiting.set(type, resolve);
      }),
  };
}

describe("Supervisor — a restart abandoned mid-backoff", () => {
  it("records the abandonment instead of dropping it silently", async () => {
    const clock = createSystemClock();
    const watcher = eventWaiter();

    const spec: ProcessSpec<unknown> = {
      name: "doomed",
      handle: () => {
        throw new Error("boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: {
        type: "one-for-one",
        maxRestarts: { count: 3, within: 10_000 as never },
        // Long enough that shutdown lands inside the backoff rather than after it.
        backoff: { initial: 300 as never, max: 300 as never, factor: 1 },
      },
    });

    const process = await supervisor.spawn(spec);
    await process.send({ type: "test" });

    // `supervisor:restart` fires in getRestartDelay, immediately before the
    // backoff sleep — so once it is visible the restart is decided and its
    // budget is already spent.
    await watcher.waitFor("supervisor:restart");
    await supervisor.stop();
    await watcher.waitFor("supervisor:restart:abandoned");

    const restarted = watcher.events.filter((e) => (e as TestEvent).type === "supervisor:child:restarted");
    expect(restarted).toHaveLength(0); // the restart genuinely did not happen

    const abandoned = watcher.events.filter((e) => (e as TestEvent).type === "supervisor:restart:abandoned");
    expect(abandoned).toHaveLength(1);
    expect((abandoned[0] as TestEvent).because).toBe("supervisor-stopping");
  });
});

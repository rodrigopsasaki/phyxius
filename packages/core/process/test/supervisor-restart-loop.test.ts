import { describe, it, expect } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Supervisor } from "../src/index.js";
import type { ProcessRef, ProcessSpec } from "../src/index.js";
import { eventWaiter } from "./event-waiter.js";

/** A child that throws on every message it is sent. */
function crashingChild(): ProcessSpec<unknown> {
  return {
    name: "always-crashes",
    handle: () => {
      throw new Error("boom");
    },
  };
}

const fastBackoff = { initial: ms(5), max: ms(5), factor: 1 };

describe("Supervisor: what the restart loop does with the failures it meets", () => {
  it("restarts a child that fails from inside its own child:restarted handler", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const spawned: ProcessRef<unknown>[] = [];
    const supervisor = new Supervisor({
      clock,
      emit: (event) => {
        watcher.emit(event);
        // The handler reaches the replacement the moment it is installed, and
        // what it sends crashes it: a failure signalled synchronously from
        // inside the restart that just finished.
        if (event.type === "supervisor:child:restarted" && watcher.countOf(event.type) === 1) {
          void spawned[0]?.send({ type: "poke-from-handler" });
        }
      },
      strategy: { type: "one-for-one", maxRestarts: { count: 5, within: ms(10_000) }, backoff: fastBackoff },
    });

    const ref = await supervisor.spawn(crashingChild());
    spawned.push(ref);
    await ref.send({ type: "poke" });

    await watcher.waitForCount("supervisor:restart", 1);
    clock.advanceBy(ms(5));
    await watcher.waitForCount("supervisor:child:restarted", 1);
    await clock.flush();

    // The crash inside the handler is decided like any other: a second restart
    // is scheduled, rather than the child left `failed` with no event at all.
    expect(watcher.countOf("supervisor:restart")).toBe(2);

    clock.advanceBy(ms(5));
    await watcher.waitForCount("supervisor:child:restarted", 2);

    expect(ref.status()).toBe("running");
    expect(supervisor.getRestartCount(ref.id)).toBe(2);

    await supervisor.stop();
  });
});

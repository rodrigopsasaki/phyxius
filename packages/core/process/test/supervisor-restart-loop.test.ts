import { describe, it, expect, vi } from "vitest";
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
  it("keeps a child stopped through its ref stopped: a stop during backoff is not undone", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    let inits = 0;
    const spec: ProcessSpec<unknown> = {
      name: "stopped-in-backoff",
      init: () => {
        inits++;
      },
      handle: () => {
        throw new Error("boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: { type: "one-for-one", maxRestarts: { count: 5, within: ms(10_000) }, backoff: fastBackoff },
    });

    const ref = await supervisor.spawn(spec);
    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:restart", 1);

    // The child has crashed and its restart is asleep in backoff. The caller
    // stops it now, through the only ref it holds.
    await ref.stop();
    expect(ref.status()).toBe("stopped");

    clock.advanceBy(ms(5));
    await watcher.waitForCount("supervisor:restart:abandoned", 1);

    // The loop wakes to a slot that was retired under it: it does not re-init,
    // does not revive the child, and says why it walked away.
    expect(inits).toBe(1);
    expect(watcher.countOf("supervisor:child:restarted")).toBe(0);
    expect(watcher.events.find((e) => e.type === "supervisor:restart:abandoned")?.because).toBe("child-stopped");
    expect(ref.status()).toBe("stopped");
    expect(supervisor.getChildren()).toHaveLength(0);

    await supervisor.stop();
  });

  it("does not restart a child whose own stop failed", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    let inits = 0;
    const spec: ProcessSpec<unknown> = {
      name: "fails-to-stop",
      init: () => {
        inits++;
      },
      handle: () => {},
      onStop: () => {
        throw new Error("stop boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: { type: "one-for-one", maxRestarts: { count: 5, within: ms(10_000) }, backoff: fastBackoff },
    });

    const ref = await supervisor.spawn(spec);

    // `onStop` throwing is reported as `process:fail`, the same event a crash
    // is. A child the caller chose to stop is not a crash to be restarted.
    await expect(ref.stop()).rejects.toThrow("stop boom");
    await clock.flush();

    expect(watcher.countOf("supervisor:restart")).toBe(0);
    expect(inits).toBe(1);
    expect(supervisor.getChildren()).toHaveLength(0);

    await supervisor.stop();
  });

  it.each([
    {
      stoppedBy: "supervisor.stop()",
      because: "supervisor-stopping",
      stop: (supervisor: Supervisor, _ref: ProcessRef<unknown>) => supervisor.stop(),
    },
    {
      stoppedBy: "ref.stop()",
      because: "child-stopped",
      stop: (_supervisor: Supervisor, ref: ProcessRef<unknown>) => ref.stop(),
    },
  ])(
    "leaves no running replacement behind when $stoppedBy lands while a re-init is in flight",
    async ({ because, stop }) => {
      const clock = createControlledClock();
      const watcher = eventWaiter();

      let inits = 0;
      let releaseInit: () => void = () => {};
      const initGate = new Promise<void>((resolve) => {
        releaseInit = resolve;
      });
      const stoppedIncarnations: number[] = [];

      const spec: ProcessSpec<unknown, { incarnation: number }> = {
        name: "slow-reinit",
        init: async () => {
          const incarnation = ++inits;
          if (incarnation > 1) await initGate; // every re-init is slow
          return { incarnation };
        },
        handle: () => {
          throw new Error("boom");
        },
        onStop: (state) => {
          stoppedIncarnations.push(state.incarnation);
        },
      };

      const supervisor = new Supervisor({
        clock,
        emit: watcher.emit,
        strategy: { type: "one-for-one", maxRestarts: { count: 5, within: ms(10_000) }, backoff: fastBackoff },
      });

      const ref = await supervisor.spawn(spec);
      await ref.send({ type: "poke" });
      await watcher.waitForCount("supervisor:restart", 1);
      clock.advanceBy(ms(5));
      await vi.waitFor(() => expect(inits).toBe(2)); // the replacement is now starting

      await stop(supervisor, ref);

      // The replacement finishes starting only now, after the stop it raced.
      releaseInit();
      await watcher.waitForCount("supervisor:restart:abandoned", 1);

      expect(watcher.events.find((e) => e.type === "supervisor:restart:abandoned")?.because).toBe(because);
      expect(watcher.countOf("supervisor:child:restarted")).toBe(0);
      // Incarnation 2 came up after the stop and was stopped again, not left running.
      expect(stoppedIncarnations).toContain(2);
      expect(supervisor.getChildren()).toHaveLength(0);

      await supervisor.stop();
    },
  );
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Supervisor } from "../src/index.js";
import type { ProcessSpec, ProcessEvent } from "../src/index.js";

/**
 * Event-driven rather than sleep-driven, same rationale as
 * supervisor-abandoned-restart.test.ts. Unlike that file's `eventWaiter`,
 * this one waits for the Nth occurrence of a type rather than the first.
 * Every scenario here drives several restarts of the *same* event type, and
 * "has this type ever fired" would resolve immediately on the second wait,
 * before the second restart it's meant to observe has even happened.
 */
function eventWaiter(): {
  emit: (event: ProcessEvent) => void;
  events: ProcessEvent[];
  waitForCount: (type: string, count: number) => Promise<void>;
  countOf: (type: string) => number;
} {
  const events: ProcessEvent[] = [];
  const watchers: Array<{ type: string; count: number; resolve: () => void }> = [];

  const countOf = (type: string) => events.filter((e) => e.type === type).length;

  return {
    events,
    countOf,
    emit: (event: ProcessEvent) => {
      events.push(event);
      for (const watcher of [...watchers]) {
        if (countOf(watcher.type) >= watcher.count) {
          watchers.splice(watchers.indexOf(watcher), 1);
          watcher.resolve();
        }
      }
    },
    waitForCount: (type: string, count: number) =>
      new Promise<void>((resolve) => {
        if (countOf(type) >= count) return resolve();
        watchers.push({ type, count, resolve });
      }),
  };
}

describe("Supervisor: restart budget and backoff follow the supervised child", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives up after maxRestarts.count restarts within the window, with one giveup event", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const spec: ProcessSpec<unknown> = {
      name: "always-crashes",
      handle: () => {
        throw new Error("boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: {
        type: "one-for-one",
        maxRestarts: { count: 3, within: ms(10_000) },
        backoff: { initial: ms(5), max: ms(5), factor: 1 },
      },
    });

    const ref = await supervisor.spawn(spec);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await ref.send({ type: "poke" });
      await watcher.waitForCount("supervisor:restart", attempt);
      clock.advanceBy(ms(5));
      await watcher.waitForCount("supervisor:child:restarted", attempt);
    }

    expect(supervisor.getRestartCount(ref.id)).toBe(3);

    // A 4th failure exhausts the budget: declined synchronously, no backoff to advance past.
    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:giveup", 1);

    expect(watcher.countOf("supervisor:child:restarted")).toBe(3);
    expect(watcher.countOf("supervisor:giveup")).toBe(1);

    const giveup = watcher.events.find((e) => e.type === "supervisor:giveup");
    expect(giveup?.attempts).toBe(3);

    expect(supervisor.getChildren()).toHaveLength(0);

    await supervisor.stop();
  });

  it("backoff delays follow initial*factor^n up to max and relax as restarts leave the window", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const spec: ProcessSpec<unknown> = {
      name: "always-crashes",
      handle: () => {
        throw new Error("boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: {
        type: "one-for-one",
        // Generous budget: this test is about delay shape, not giving up.
        maxRestarts: { count: 100, within: ms(2_000) },
        backoff: { initial: ms(10), max: ms(80), factor: 2 },
      },
    });

    const ref = await supervisor.spawn(spec);

    const expectedDelays = [10, 20, 40, 80]; // initial * factor^(n-1), capped at max on the 4th
    for (const [i, expectedDelay] of expectedDelays.entries()) {
      const attempt = i + 1;
      await ref.send({ type: "poke" });
      await watcher.waitForCount("supervisor:restart", attempt);

      const restartEvent = watcher.events.filter((e) => e.type === "supervisor:restart").at(-1);
      expect(restartEvent?.attempt).toBe(attempt);
      expect(restartEvent?.delayMs).toBe(expectedDelay);

      clock.advanceBy(ms(expectedDelay));
      await watcher.waitForCount("supervisor:child:restarted", attempt);
    }

    // Let far more time pass than `within` without any further failures.
    // The window should age out entirely.
    clock.advanceBy(ms(5_000));

    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:restart", 5);

    const relaxedEvent = watcher.events.filter((e) => e.type === "supervisor:restart").at(-1);
    expect(relaxedEvent?.attempt).toBe(1); // window reset, back to a fresh budget
    expect(relaxedEvent?.delayMs).toBe(10); // back to the initial delay, not a continuation of the curve

    clock.advanceBy(ms(10));
    await watcher.waitForCount("supervisor:child:restarted", 5);

    await supervisor.stop();
  });

  it("the restart window follows the supervised child across incarnations", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const spec: ProcessSpec<unknown> = {
      name: "always-crashes",
      handle: () => {
        throw new Error("boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: {
        type: "one-for-one",
        maxRestarts: { count: 5, within: ms(10_000) },
        backoff: { initial: ms(5), max: ms(5), factor: 1 },
      },
    });

    const ref = await supervisor.spawn(spec);
    const originalRefId = ref.id;

    for (let attempt = 1; attempt <= 3; attempt++) {
      await ref.send({ type: "poke" });
      await watcher.waitForCount("supervisor:restart", attempt);
      clock.advanceBy(ms(5));
      await watcher.waitForCount("supervisor:child:restarted", attempt);
    }

    // The caller's address for the child never changes...
    expect(ref.id).toBe(originalRefId);
    expect(supervisor.getRestartCount(ref.id)).toBe(3);

    // ...even though every incarnation underneath it got a genuinely fresh id:
    // restart N's "old" is the very incarnation restart N-1 just created as
    // "new" (they chain), and none of the four incarnations along the way
    // (original + 3 replacements) ever equals the slot's own stable address.
    const restarted = watcher.events.filter((e) => e.type === "supervisor:child:restarted");
    expect(restarted).toHaveLength(3);

    expect(restarted[1]?.oldProcessId).toBe(restarted[0]?.newProcessId);
    expect(restarted[2]?.oldProcessId).toBe(restarted[1]?.newProcessId);

    const incarnationIds = [restarted[0]?.oldProcessId, ...restarted.map((e) => e.newProcessId)];
    expect(new Set(incarnationIds).size).toBe(4); // the original incarnation plus 3 distinct replacements
    for (const incarnationId of incarnationIds) {
      expect(incarnationId).not.toBe(originalRefId);
    }

    // The window accumulated (1, 2, 3), rather than resetting to 1 each time
    // a fresh incarnation id looked up an empty window.
    const attempts = watcher.events.filter((e) => e.type === "supervisor:restart").map((e) => e.attempt);
    expect(attempts).toEqual([1, 2, 3]);

    await supervisor.stop();
  });

  it("a failed re-init counts against the budget and is retried with backoff until the budget is spent, then gives up", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    let initCalls = 0;
    const spec: ProcessSpec<unknown> = {
      name: "reinit-flaky",
      init: () => {
        initCalls++;
        if (initCalls > 1) {
          throw new Error("re-init boom");
        }
      },
      handle: () => {
        throw new Error("boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: {
        type: "one-for-one",
        maxRestarts: { count: 3, within: ms(10_000) },
        backoff: { initial: ms(5), max: ms(5), factor: 1 },
      },
    });

    const ref = await supervisor.spawn(spec);
    expect(initCalls).toBe(1);

    await ref.send({ type: "poke" });

    for (let attempt = 1; attempt <= 3; attempt++) {
      await watcher.waitForCount("supervisor:restart", attempt);
      clock.advanceBy(ms(5));
      await watcher.waitForCount("supervisor:restart:failed", attempt);
    }

    await watcher.waitForCount("supervisor:giveup", 1);

    // 1 successful init (the original spawn) + 3 failed re-inits.
    expect(initCalls).toBe(4);
    expect(watcher.countOf("supervisor:restart:failed")).toBe(3);
    expect(watcher.countOf("supervisor:child:restarted")).toBe(0); // none of the retries ever actually came up
    expect(watcher.countOf("supervisor:giveup")).toBe(1);

    const giveup = watcher.events.find((e) => e.type === "supervisor:giveup");
    expect(giveup?.attempts).toBe(3);

    // No incarnation ever came up, so the supervisor never counts a restart:
    // only a *successful* re-spawn bumps this counter.
    expect(supervisor.getRestartCount(ref.id)).toBe(0);
    expect(supervisor.getChildren()).toHaveLength(0);

    await supervisor.stop();
  });

  it("the ref returned by spawn keeps addressing the current incarnation after a restart", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    let handleCalls = 0;
    const spec: ProcessSpec<{ type: string }> = {
      name: "fails-once",
      handle: () => {
        handleCalls++;
        if (handleCalls === 1) {
          throw new Error("boom");
        }
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: {
        type: "one-for-one",
        maxRestarts: { count: 3, within: ms(10_000) },
        backoff: { initial: ms(5), max: ms(5), factor: 1 },
      },
    });

    const ref = await supervisor.spawn(spec);
    const originalRefId = ref.id;

    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:restart", 1);
    clock.advanceBy(ms(5));
    await watcher.waitForCount("supervisor:child:restarted", 1);

    // Same object, same address, and (the actual bug) no longer reporting
    // the dead incarnation's "failed" status.
    expect(ref.id).toBe(originalRefId);
    expect(ref.status()).toBe("running");
    expect(supervisor.getChildren()).toHaveLength(1);
    expect(supervisor.getChildren()[0]).toBe(ref);

    // And it truly addresses the live incarnation, not a stale one: this
    // message reaches the new process's mailbox and is handled.
    const sent = await ref.send({ type: "poke-again" });
    expect(sent).toBe(true);
    await vi.waitFor(() => expect(handleCalls).toBe(2));

    // stop()'s own internal drain loop polls via clock.sleep(1) until the
    // pump notices the mailbox is empty; on a controlled clock that poll
    // needs an explicit advance to resolve, same as any other backoff sleep.
    const stopping = supervisor.stop();
    clock.advanceBy(ms(1));
    await stopping;
  });

  it("jitter is deterministic: no Math.random", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be called; jitter must come from an injected source");
    });

    const spec: ProcessSpec<unknown> = {
      name: "always-crashes",
      handle: () => {
        throw new Error("boom");
      },
    };

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      random: () => 0.75, // deterministic, injected, never Math.random
      strategy: {
        type: "one-for-one",
        backoff: { initial: ms(20), max: ms(20), factor: 1, jitter: 50 },
      },
    });

    const ref = await supervisor.spawn(spec);

    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:restart", 1);

    expect(randomSpy).not.toHaveBeenCalled();

    const restartEvent = watcher.events.find((e) => e.type === "supervisor:restart");
    // jitterAmount = 20 * (50/100) = 10; delta = (0.75 - 0.5) * 2 * 10 = 5; delay = 20 + 5 = 25.
    // Deterministic and reproducible because it's a fixed function, not Math.random.
    expect(restartEvent?.delayMs).toBe(25);

    clock.advanceBy(ms(25));
    await watcher.waitForCount("supervisor:child:restarted", 1);

    await supervisor.stop();
  });

  it("a strategy with real jitter does not typecheck without an injected random source", () => {
    const clock = createControlledClock();

    // @ts-expect-error — backoff.jitter is a nonzero magnitude, so the
    // constructor overload that accepts this strategy also requires
    // `random`. Omitting it is a compile error, not a Math.random fallback.
    new Supervisor({
      clock,
      strategy: {
        type: "one-for-one",
        backoff: { initial: ms(20), max: ms(20), factor: 1, jitter: 50 },
      },
    });
  });
});

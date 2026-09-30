import { describe, it, expect, vi, afterEach } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Supervisor } from "../src/index.js";
import type { ProcessSpec, SupervisionStrategy } from "../src/index.js";
import { eventWaiter } from "./event-waiter.js";

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

  it("jitter pinned to 0 needs no injected random and restarts normally", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const spec: ProcessSpec<unknown> = {
      name: "always-crashes",
      handle: () => {
        throw new Error("boom");
      },
    };

    // No `random`: `jitter: 0` is an explicit "off", so computing the delay
    // must not reach for a source of randomness the caller did not inject.
    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: {
        type: "one-for-one",
        maxRestarts: { count: 3, within: ms(10_000) },
        backoff: { initial: ms(5), max: ms(5), factor: 1, jitter: 0 },
      },
    });

    const ref = await supervisor.spawn(spec);
    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:restart", 1);

    const restartEvent = watcher.events.find((e) => e.type === "supervisor:restart");
    expect(restartEvent?.delayMs).toBe(5);

    clock.advanceBy(ms(5));
    await watcher.waitForCount("supervisor:child:restarted", 1);

    expect(watcher.countOf("supervisor:restart:failed")).toBe(0);
    expect(ref.status()).toBe("running");

    await supervisor.stop();
  });

  it("jitter in a SupervisionStrategy-typed value, without random, is refused at construction", () => {
    const clock = createControlledClock();

    // The type says only `jitter?: number`, so this compiles: the constructor's
    // types cannot see the jitter in it. The refusal is here instead, at
    // construction and by name, not on the first restart of a crashing child.
    const strategy: SupervisionStrategy = {
      type: "one-for-one",
      backoff: { initial: ms(20), max: ms(20), factor: 1, jitter: 50 },
    };

    expect(() => new Supervisor({ clock, strategy })).toThrow(/random/);
    expect(() => new Supervisor({ clock, strategy, random: () => 0.5 })).not.toThrow();
  });
});

/**
 * A child that throws on every message, supervised with no backoff, so each
 * crash is restarted the moment it is decided and the only thing moving time
 * is the test. The window's own arithmetic is what these scenarios isolate.
 */
function crashingChild(): ProcessSpec<unknown> {
  return {
    name: "always-crashes",
    handle: () => {
      throw new Error("boom");
    },
  };
}

describe("Supervisor: the restart window slides on monotonic time", () => {
  it("counts restarts inside the trailing window, so a burst straddling an old start cannot double the budget", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: { type: "one-for-one", maxRestarts: { count: 3, within: ms(10_000) } },
    });

    const ref = await supervisor.spawn(crashingChild());

    // Crashes at 0, 9000, 10001 and 10002 ms. The one at 0 has left the
    // window by 10001, so the trailing window holds {9000, 10001, 10002}:
    // exactly `count`, and all four restarts are granted.
    const crashAt = [0, 9_000, 10_001, 10_002];
    for (const [i, at] of crashAt.entries()) {
      clock.advanceTo(at);
      await ref.send({ type: "poke" });
      await watcher.waitForCount("supervisor:child:restarted", i + 1);
    }

    // The fifth crash, at 10003, finds three restarts inside the last 10s.
    // A window that restarts from scratch once it "expires" (tumbling) would
    // have opened a fresh one at 10001 and granted this a fifth restart.
    clock.advanceTo(10_003);
    await ref.send({ type: "poke" });
    await clock.flush();

    expect(watcher.countOf("supervisor:child:restarted")).toBe(4);
    expect(watcher.countOf("supervisor:giveup")).toBe(1);
    expect(watcher.events.find((e) => e.type === "supervisor:giveup")?.attempts).toBe(3);
    expect(supervisor.getChildren()).toHaveLength(0);

    await supervisor.stop();
  });

  it("backoff attempt counts the restarts still inside the trailing window", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: {
        type: "one-for-one",
        maxRestarts: { count: 100, within: ms(10_000) },
        backoff: { initial: ms(1), max: ms(1_000), factor: 2 },
      },
    });

    const ref = await supervisor.spawn(crashingChild());

    // Crashes at 0, 5000 and 10500. By the third, the first has left the
    // window but the second has not: the curve relaxes by one step, it does
    // not start over (attempt 2, not 1).
    const crashAt = [0, 5_000, 10_500];
    for (const [i, at] of crashAt.entries()) {
      clock.advanceTo(at);
      await ref.send({ type: "poke" });
      await watcher.waitForCount("supervisor:restart", i + 1);
      const restart = watcher.events.filter((e) => e.type === "supervisor:restart").at(-1);
      clock.advanceBy(ms(restart?.delayMs ?? 0));
      await watcher.waitForCount("supervisor:child:restarted", i + 1);
    }

    const attempts = watcher.events.filter((e) => e.type === "supervisor:restart").map((e) => e.attempt);
    expect(attempts).toEqual([1, 2, 2]);

    await supervisor.stop();
  });

  it("count 0 grants no restarts", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: { type: "one-for-one", maxRestarts: { count: 0, within: ms(10_000) } },
    });

    const ref = await supervisor.spawn(crashingChild());
    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:giveup", 1);

    expect(watcher.countOf("supervisor:child:restarted")).toBe(0);
    expect(watcher.events.find((e) => e.type === "supervisor:giveup")?.attempts).toBe(0);
    expect(supervisor.getChildren()).toHaveLength(0);

    await supervisor.stop();
  });

  it.each([
    { elapsed: 100, outcome: "still counts, so the budget is spent" },
    { elapsed: 101, outcome: "has left the window, so the restart is granted" },
  ])("a restart exactly `within` ago vs one ms older: at $elapsed ms it $outcome", async ({ elapsed }) => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: { type: "one-for-one", maxRestarts: { count: 1, within: ms(100) } },
    });

    const ref = await supervisor.spawn(crashingChild());

    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:child:restarted", 1);

    clock.advanceBy(ms(elapsed));
    await ref.send({ type: "poke" });
    await clock.flush();

    // `within` is inclusive: a restart `within` ms old is still in the window.
    expect(watcher.countOf("supervisor:giveup")).toBe(elapsed === 100 ? 1 : 0);
    expect(watcher.countOf("supervisor:child:restarted")).toBe(elapsed === 100 ? 1 : 2);

    await supervisor.stop();
  });

  it("a wall-clock jump forward does not close the window", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: { type: "one-for-one", maxRestarts: { count: 1, within: ms(100) } },
    });

    const ref = await supervisor.spawn(crashingChild());

    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:child:restarted", 1);

    // No monotonic time passes, so the window is still open. Measured on
    // `wallMs` this reads as 1,000,000 ms elapsed and grants a second restart.
    clock.jumpWallTime(1_000_000);
    await ref.send({ type: "poke" });
    await clock.flush();

    expect(watcher.countOf("supervisor:giveup")).toBe(1);
    expect(watcher.countOf("supervisor:child:restarted")).toBe(1);

    await supervisor.stop();
  });

  it("a wall-clock jump backward does not hold the window open", async () => {
    const clock = createControlledClock({ initialTime: 1_000_000 });
    const watcher = eventWaiter();

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      strategy: { type: "one-for-one", maxRestarts: { count: 1, within: ms(100) } },
    });

    const ref = await supervisor.spawn(crashingChild());

    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:child:restarted", 1);

    // 200 ms of monotonic time pass, so the window has closed. Measured on
    // `wallMs`, the backward jump reads as negative elapsed time, which clamps
    // to 0 and keeps the window open: the budget is spent when it should not be.
    clock.advanceBy(ms(200));
    clock.jumpWallTime(500_000);
    await ref.send({ type: "poke" });
    await watcher.waitForCount("supervisor:child:restarted", 2);

    expect(watcher.countOf("supervisor:giveup")).toBe(0);

    await supervisor.stop();
  });
});

/**
 * A child that comes up once and then can never be brought up again: every
 * re-init throws. Crashing it once starts the supervisor's own retry loop,
 * the one thing here that runs without a message to drive it.
 */
function unrestartableChild(): ProcessSpec<unknown> {
  let inits = 0;
  return {
    name: "unrestartable",
    init: () => {
      inits++;
      if (inits > 1) throw new Error("re-init boom");
    },
    handle: () => {
      throw new Error("boom");
    },
  };
}

describe("Supervisor: a failed re-init with no restart budget", () => {
  it("is retried with backoff that keeps growing per the curve, capped at max", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    const supervisor = new Supervisor({
      clock,
      emit: watcher.emit,
      // No `maxRestarts`: nothing here ever declares the budget spent.
      strategy: { type: "one-for-one", backoff: { initial: ms(10), max: ms(80), factor: 2 } },
    });

    const ref = await supervisor.spawn(unrestartableChild());
    await ref.send({ type: "poke" });

    const expectedDelays = [10, 20, 40, 80, 80, 80];
    for (const [i, expectedDelay] of expectedDelays.entries()) {
      const n = i + 1;
      await watcher.waitForCount("supervisor:restart", n);
      expect(watcher.events.filter((e) => e.type === "supervisor:restart").at(-1)?.delayMs).toBe(expectedDelay);
      clock.advanceBy(ms(expectedDelay));
      await watcher.waitForCount("supervisor:restart:failed", n);
    }

    // The attempt count is the slot's own, so it grows per failed re-init
    // even though there is no budget window to count them in. The seventh is
    // already decided and asleep on its capped 80 ms: the sixth failure ended
    // one wait and began the next.
    const restarts = watcher.events.filter((e) => e.type === "supervisor:restart");
    expect(restarts.map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(restarts.at(-1)?.delayMs).toBe(80);
    expect(watcher.countOf("supervisor:giveup")).toBe(0);

    // Shutdown ends the retry loop with a recorded reason, not a silent stop.
    await supervisor.stop();
    clock.advanceBy(ms(80));
    await watcher.waitForCount("supervisor:restart:abandoned", 1);
    expect(watcher.countOf("supervisor:giveup")).toBe(0);
  });

  it("never retries in the same tick, even with no backoff to pace it", async () => {
    const clock = createControlledClock();
    const watcher = eventWaiter();

    // A retry loop that never waits would starve the event loop, and on this
    // clock nothing would ever interrupt it. If the loop spins, fail the test
    // from inside it rather than hanging the run.
    const SPIN_LIMIT = 50;
    const supervisor = new Supervisor({
      clock,
      emit: (event) => {
        watcher.emit(event);
        if (event.type === "supervisor:restart:failed" && watcher.countOf(event.type) > SPIN_LIMIT) {
          throw new Error("re-init retry is spinning without yielding");
        }
      },
      strategy: { type: "one-for-one" },
    });

    const ref = await supervisor.spawn(unrestartableChild());
    await ref.send({ type: "poke" });

    await watcher.waitForCount("supervisor:restart:failed", 1);
    await clock.flush();

    // The loop is parked on the clock, waiting, rather than retrying again.
    expect(watcher.countOf("supervisor:restart:failed")).toBe(1);
    expect(clock.getPendingTimerCount()).toBe(1);

    clock.advanceBy(ms(1));
    await watcher.waitForCount("supervisor:restart:failed", 2);
    await clock.flush();
    expect(watcher.countOf("supervisor:restart:failed")).toBe(2);

    // The first restart follows the crash at once; every retry waits its 1 ms.
    const delays = watcher.events.filter((e) => e.type === "supervisor:restart").map((e) => e.delayMs);
    expect(delays).toEqual([0, 1, 1]);

    await supervisor.stop();
  });

  it.each([
    // 0 * Infinity is NaN once the curve overflows: nothing to cap, so the floor.
    { initial: 0, waitsAfterOverflow: 1 },
    // 10 * Infinity is Infinity: over the cap, so the cap.
    { initial: 10, waitsAfterOverflow: 80 },
  ])(
    "keeps waiting once the backoff curve overflows, with initial $initial: $waitsAfterOverflow ms",
    async ({ initial, waitsAfterOverflow }) => {
      const clock = createControlledClock();
      const watcher = eventWaiter();

      // `Math.pow(2, attempt - 1)` is Infinity from the 1025th attempt on. The
      // driver pays one clock advance per failure, so a retry that does not
      // wait shows up as a failure nobody paid for: throw from inside the loop
      // rather than let it spin, which on this clock nothing could interrupt.
      const FAILURES = 1_030;
      const supervisor = new Supervisor({
        clock,
        emit: (event) => {
          watcher.emit(event);
          if (event.type === "supervisor:restart:failed" && watcher.countOf(event.type) > FAILURES + 1) {
            throw new Error("re-init retry is spinning without yielding");
          }
        },
        strategy: { type: "one-for-one", backoff: { initial: ms(initial), max: ms(80), factor: 2 } },
      });

      const ref = await supervisor.spawn(unrestartableChild());
      await ref.send({ type: "poke" });

      const abandoned = watcher.waitForCount("supervisor:restart:abandoned", 1);
      for (let n = 1; n <= FAILURES; n++) {
        await watcher.waitForCount("supervisor:restart", n);
        const pending = watcher.events.filter((e) => e.type === "supervisor:restart").at(-1);
        clock.advanceBy(ms(pending?.delayMs ?? 0));
        await Promise.race([watcher.waitForCount("supervisor:restart:failed", n), abandoned]);
      }

      expect(watcher.countOf("supervisor:restart:abandoned")).toBe(0);

      const restarts = watcher.events.filter((e) => e.type === "supervisor:restart");
      const pastOverflow = restarts.filter((e) => (e.attempt ?? 0) >= 1_025);
      expect(pastOverflow.length).toBeGreaterThan(0);
      expect(pastOverflow.map((e) => e.delayMs)).toEqual(pastOverflow.map(() => waitsAfterOverflow));

      await supervisor.stop();
      clock.advanceBy(ms(80));
      await watcher.waitForCount("supervisor:restart:abandoned", 1);
    },
  );
});

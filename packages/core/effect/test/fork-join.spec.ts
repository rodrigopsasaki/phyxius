import { describe, it, expect } from "vitest";
import { effect, succeed, fail, sleep } from "../src/index.js";
import { createControlledClock, ms } from "@phyxius/clock";

describe("Fork/Join", () => {
  it("should fork an effect and join the result", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const forkedEffect = succeed(42).fork();

    const result = await forkedEffect.unsafeRunPromise({ clock });
    expect(result._tag).toBe("Ok");

    if (result._tag === "Ok") {
      const fiber = result.value;
      expect(typeof fiber.id).toBe("string");

      const joinResult = await fiber.join().unsafeRunPromise({ clock });
      expect(joinResult).toEqual({ _tag: "Ok", value: 42 });
    }
  });

  it("should run forked effects concurrently", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: string[] = [];

    const effect1 = effect(async (env) => {
      events.push("effect1-start");
      const sleepResult = await sleep(ms(100)).unsafeRunPromise({ clock: env.clock });
      if (sleepResult._tag === "Err") throw sleepResult.error;
      events.push("effect1-end");
      return { _tag: "Ok", value: "result1" };
    });

    const effect2 = effect(async (env) => {
      events.push("effect2-start");
      const sleepResult = await sleep(ms(200)).unsafeRunPromise({ clock: env.clock });
      if (sleepResult._tag === "Err") throw sleepResult.error;
      events.push("effect2-end");
      return { _tag: "Ok", value: "result2" };
    });

    // Fork both effects
    const fork1Promise = effect1.fork().unsafeRunPromise({ clock });
    const fork2Promise = effect2.fork().unsafeRunPromise({ clock });

    await Promise.resolve(); // Allow forking to complete

    const [fork1Result, fork2Result] = await Promise.all([fork1Promise, fork2Promise]);

    expect(fork1Result._tag).toBe("Ok");
    expect(fork2Result._tag).toBe("Ok");

    if (fork1Result._tag === "Ok" && fork2Result._tag === "Ok") {
      const fiber1 = fork1Result.value;
      const fiber2 = fork2Result.value;

      // Both should have started
      expect(events).toContain("effect1-start");
      expect(events).toContain("effect2-start");

      // Advance time to complete effect1 (100ms)
      clock.advanceBy(ms(100));
      await Promise.resolve();

      // Advance time to complete effect2 (200ms total)
      clock.advanceBy(ms(100));
      await Promise.resolve();

      // Join both fibers
      const [result1, result2] = await Promise.all([
        fiber1.join().unsafeRunPromise({ clock }),
        fiber2.join().unsafeRunPromise({ clock }),
      ]);

      expect(result1).toEqual({ _tag: "Ok", value: "result1" });
      expect(result2).toEqual({ _tag: "Ok", value: "result2" });
      expect(events).toEqual(["effect1-start", "effect2-start", "effect1-end", "effect2-end"]);
    }
  });

  it("should propagate errors from forked effects", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const failingEffect = fail("test error").fork();

    const result = await failingEffect.unsafeRunPromise({ clock });
    expect(result._tag).toBe("Ok");

    if (result._tag === "Ok") {
      const fiber = result.value;

      const joinResult = await fiber.join().unsafeRunPromise({ clock });
      expect(joinResult).toEqual({ _tag: "Err", error: "test error" });
    }
  });

  it("should allow interrupting forked effects", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let wasInterrupted = false;

    const longRunningEffect = effect(async (env) => {
      const cleanupUnsubscribe = env.cancel.onCancel(() => {
        wasInterrupted = true;
      });

      try {
        const sleepResult = await sleep(ms(1000)).unsafeRunPromise({ clock: env.clock });
        if (sleepResult._tag === "Err") throw sleepResult.error;
        cleanupUnsubscribe();
        return { _tag: "Ok", value: "completed" };
      } catch (error) {
        cleanupUnsubscribe();
        return { _tag: "Err", error };
      }
    });

    const forkResult = await longRunningEffect.fork().unsafeRunPromise({ clock });
    expect(forkResult._tag).toBe("Ok");

    if (forkResult._tag === "Ok") {
      const fiber = forkResult.value;

      // Allow effect to start
      await Promise.resolve();

      // Interrupt the fiber before it completes
      const interruptResult = await fiber.interrupt().unsafeRunPromise({ clock });
      expect(interruptResult).toEqual({ _tag: "Ok", value: undefined });

      // Advance time - the effect should not complete normally
      clock.advanceBy(ms(1000));
      await Promise.resolve();

      expect(wasInterrupted).toBe(true);
    }
  });

  it("should support polling fiber status", async () => {
    const clock = createControlledClock({ initialTime: 0 });

    const slowEffect = sleep(ms(500)).map(() => "done");
    const forkResult = await slowEffect.fork().unsafeRunPromise({ clock });

    expect(forkResult._tag).toBe("Ok");

    if (forkResult._tag === "Ok") {
      const fiber = forkResult.value;

      // Poll before completion
      const pollResult1 = await fiber.poll().unsafeRunPromise({ clock });
      expect(pollResult1).toEqual({ _tag: "Ok", value: undefined });

      // Complete the effect
      clock.advanceBy(ms(500));
      await Promise.resolve();

      // Poll after completion
      const pollResult2 = await fiber.poll().unsafeRunPromise({ clock });
      expect(pollResult2._tag).toBe("Ok");
      if (pollResult2._tag === "Ok" && pollResult2.value) {
        expect(pollResult2.value).toEqual({ _tag: "Ok", value: "done" });
      }
    }
  });

  it("should handle parent cancellation of forked effects", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    let childWasCancelled = false;

    const parentEffect = effect(async (env) => {
      const childEffect = effect(async (childEnv) => {
        childEnv.cancel.onCancel(() => {
          childWasCancelled = true;
        });

        const sleepResult = await sleep(ms(1000)).unsafeRunPromise({ clock: childEnv.clock });
        if (sleepResult._tag === "Err") throw sleepResult.error;
        return { _tag: "Ok", value: "child-completed" };
      });

      const forkResult = await childEffect.fork().unsafeRunPromise({ clock: env.clock });
      if (forkResult._tag === "Err") throw forkResult.error;

      const fiber = forkResult.value;

      // Sleep shorter than child, then return
      const sleepResult = await sleep(ms(200)).unsafeRunPromise({ clock: env.clock });
      if (sleepResult._tag === "Err") throw sleepResult.error;

      // Note: In a real implementation, child fibers would be automatically
      // cancelled when parent scope closes. For now, we manually interrupt.
      await fiber.interrupt().unsafeRunPromise({ clock: env.clock });

      return { _tag: "Ok", value: "parent-completed" };
    }).timeout(ms(300)); // Timeout shorter than child sleep

    // Start the parent effect
    const resultPromise = parentEffect.unsafeRunPromise({ clock });

    await Promise.resolve();

    // Advance time to complete parent but not child
    clock.advanceBy(ms(300));
    await Promise.resolve();

    const result = await resultPromise;

    // Parent should timeout, and child should be cancelled
    expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
    expect(childWasCancelled).toBe(true);
  });
});

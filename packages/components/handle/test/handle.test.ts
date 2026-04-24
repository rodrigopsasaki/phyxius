import { describe, it, expect } from "vitest";
import { createControlledClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { isOk, isErr } from "@phyxiusjs/fp";
import { observe } from "@phyxiusjs/observe";
import { createHandler } from "../src/handle.js";
import type { CanonicalLog } from "../src/types.js";

function setup(options?: { defaultTimeoutMs?: number }) {
  const clock = createControlledClock({ initialTime: 1000 });
  const journal = new Journal<CanonicalLog>({ clock });
  const handle = createHandler({
    clock,
    journal,
    defaultTimeoutMs: options?.defaultTimeoutMs !== undefined ? ms(options.defaultTimeoutMs) : undefined,
  });
  return { clock, journal, handle };
}

describe("createHandler", () => {
  it("should execute run function and return Ok result", async () => {
    const { handle } = setup();

    const { result } = await handle({
      name: "test",
      run: () => 42,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(42);
    }
  });

  it("should return async results", async () => {
    const { handle } = setup();

    const { result } = await handle({
      name: "asyncTest",
      run: async () => {
        return { data: "hello" };
      },
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({ data: "hello" });
    }
  });

  it("should capture errors as Err result", async () => {
    const { handle } = setup();

    const { result } = await handle({
      name: "failingHandler",
      run: () => {
        throw new Error("something broke");
      },
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.type).toBe("HANDLER_ERROR");
      if (result.error.type === "HANDLER_ERROR") {
        expect(result.error.cause).toBeInstanceOf(Error);
      }
    }
  });

  it("should append canonical log to journal on success", async () => {
    const { handle, journal } = setup();

    const { log } = await handle({
      name: "logTest",
      initial: { userId: "user-42" },
      run: () => "ok",
    });

    expect(journal.size()).toBe(1);
    expect(log.handlerName).toBe("logTest");
    expect(log.success).toBe(true);
    expect(log["userId"]).toBe("user-42");
    expect(typeof log.requestId).toBe("string");
    expect(typeof log.durationMs).toBe("number");
  });

  it("should append canonical log to journal on error", async () => {
    const { handle, journal } = setup();

    const { log } = await handle({
      name: "errorLogTest",
      run: () => {
        throw new Error("oops");
      },
    });

    expect(journal.size()).toBe(1);
    expect(log.success).toBe(false);
    expect(log.errorType).toBe("HANDLER_ERROR");
    expect(log.errorMessage).toBe("oops");
  });

  it("should accumulate caller-declared typed fields into the canonical log", async () => {
    const { handle } = setup();

    const fields = observe.fields({
      customField: observe.field<string>(),
      queryCount: observe.number(),
      events: observe.array<{ type: string }>(),
    });

    const { log } = await handle({
      name: "toolsTest",
      run: () => {
        fields.customField.set("hello");
        fields.queryCount.inc();
        fields.queryCount.inc();
        fields.events.push({ type: "db.query" });
        fields.events.push({ type: "cache.hit" });
        return "done";
      },
    });

    expect(log["customField"]).toBe("hello");
    expect(log["queryCount"]).toBe(2);
    expect(log["events"]).toEqual([{ type: "db.query" }, { type: "cache.hit" }]);
  });

  it("should stamp context fields from params", async () => {
    const { handle } = setup();

    const { log } = await handle({
      name: "contextTest",
      initial: { tenantId: "t-1", source: "api" },
      run: () => "ok",
    });

    expect(log["tenantId"]).toBe("t-1");
    expect(log["source"]).toBe("api");
  });

  it("should timeout when run exceeds timeoutMs", async () => {
    const { handle, clock } = setup();

    const handlePromise = handle({
      name: "slowHandler",
      timeoutMs: ms(50),
      run: async ({ clock: c }) => {
        await c.sleep(ms(200));
        return "too late";
      },
    });

    // Let the scope and the work's sleep get registered on the clock.
    await Promise.resolve();
    // Advance past the 50ms deadline — budget fires, signal aborts,
    // handle rejects the race with TimeoutError.
    clock.advanceBy(ms(50));
    await clock.flush();

    const { result, log } = await handlePromise;

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.type).toBe("TIMEOUT");
    }
    expect(log.success).toBe(false);
    expect(log.errorType).toBe("TIMEOUT");
  });

  it("should use defaultTimeoutMs when per-call timeout is not set", async () => {
    const { handle, clock } = setup({ defaultTimeoutMs: 50 });

    const handlePromise = handle({
      name: "defaultTimeout",
      run: async ({ clock: c }) => {
        await c.sleep(ms(200));
        return "too late";
      },
    });

    await Promise.resolve();
    clock.advanceBy(ms(50));
    await clock.flush();

    const { result } = await handlePromise;

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.type).toBe("TIMEOUT");
    }
  });

  it("should expose an AbortSignal that fires on timeout", async () => {
    const { handle, clock } = setup();

    let signalAborted = false;

    const handlePromise = handle({
      name: "signalCheck",
      timeoutMs: ms(50),
      run: async ({ clock: c, signal }) => {
        signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        await c.sleep(ms(200));
        return "too late";
      },
    });

    await Promise.resolve();
    clock.advanceBy(ms(50));
    await clock.flush();

    await handlePromise;

    expect(signalAborted).toBe(true);
  });

  it("should expose a never-aborting AbortSignal when no timeout is set", async () => {
    const { handle } = setup();

    let signalFromRun: AbortSignal | undefined;

    await handle({
      name: "noTimeout",
      run: ({ signal }) => {
        signalFromRun = signal;
        return "ok";
      },
    });

    expect(signalFromRun).toBeDefined();
    expect(signalFromRun?.aborted).toBe(false);
  });

  it("should not timeout when run completes quickly", async () => {
    const { handle } = setup();

    const { result } = await handle({
      name: "fastHandler",
      timeoutMs: ms(5000),
      run: () => "fast",
    });

    expect(isOk(result)).toBe(true);
  });

  it("should isolate concurrent handler invocations", async () => {
    const { handle, journal } = setup();

    const fields = observe.fields({
      handler: observe.field<string>(),
    });

    const [r1, r2] = await Promise.all([
      handle({
        name: "handler-a",
        initial: { userId: "user-1" },
        run: () => {
          fields.handler.set("a");
          return "a";
        },
      }),
      handle({
        name: "handler-b",
        initial: { userId: "user-2" },
        run: () => {
          fields.handler.set("b");
          return "b";
        },
      }),
    ]);

    expect(journal.size()).toBe(2);

    expect(r1.log["userId"]).toBe("user-1");
    expect(r1.log["handler"]).toBe("a");

    expect(r2.log["userId"]).toBe("user-2");
    expect(r2.log["handler"]).toBe("b");
  });

  it("should generate unique requestIds", async () => {
    const { handle } = setup();

    const r1 = await handle({ name: "a", run: () => 1 });
    const r2 = await handle({ name: "b", run: () => 2 });

    expect(r1.log.requestId).not.toBe(r2.log.requestId);
  });

  it("should record startedAt using the clock", async () => {
    const { handle, clock } = setup();

    clock.advanceBy(ms(500));

    const { log } = await handle({
      name: "clockTest",
      run: () => "ok",
    });

    expect(log.startedAt).toBe(1500);
  });
});

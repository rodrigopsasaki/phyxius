import { describe, expect, it } from "vitest";

import { createControlledClock } from "@phyxiusjs/clock";

import { bracket, make, of } from "../src/core.js";
import type { ResourceEvent } from "../src/types.js";

describe("resource.make → use", () => {
  it("acquires, runs fn, releases — happy path", async () => {
    const events: string[] = [];
    const r = make(
      async () => {
        events.push("acquire");
        return { id: 42 };
      },
      async (value) => {
        events.push(`release:${value.id}`);
      },
    );

    const result = await r.use(async (value) => {
      events.push(`use:${value.id}`);
      return value.id * 2;
    });

    expect(result).toBe(84);
    expect(events).toEqual(["acquire", "use:42", "release:42"]);
  });

  it("releases exactly once, even when fn throws", async () => {
    const events: string[] = [];
    const r = make(
      async () => {
        events.push("acquire");
        return "resource";
      },
      async () => {
        events.push("release");
      },
    );

    await expect(
      r.use(async () => {
        events.push("use");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(events).toEqual(["acquire", "use", "release"]);
  });

  it("releases when fn resolves even if the resource value is discarded", async () => {
    let released = false;
    const r = make(
      () => ({ ref: 1 }),
      () => {
        released = true;
      },
    );

    await r.use(async () => 5);
    expect(released).toBe(true);
  });

  it("does NOT release when acquire throws (nothing to release)", async () => {
    let released = false;
    const r = make(
      () => {
        throw new Error("acquire failed");
      },
      () => {
        released = true;
      },
    );

    await expect(r.use(async () => 1)).rejects.toThrow("acquire failed");
    expect(released).toBe(false);
  });

  it("each use() call acquires and releases independently", async () => {
    let acquiredCount = 0;
    let releasedCount = 0;
    const r = make(
      async () => {
        acquiredCount += 1;
        return acquiredCount;
      },
      async () => {
        releasedCount += 1;
      },
    );

    const v1 = await r.use(async (x) => x);
    const v2 = await r.use(async (x) => x);
    const v3 = await r.use(async (x) => x);

    expect(v1).toBe(1);
    expect(v2).toBe(2);
    expect(v3).toBe(3);
    expect(releasedCount).toBe(3);
  });

  it("release errors are SWALLOWED — do not mask use errors", async () => {
    const r = make(
      async () => "v",
      async () => {
        throw new Error("release failed");
      },
    );

    // Body throws; release ALSO throws. The body error must propagate.
    await expect(
      r.use(async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
  });

  it("release errors are swallowed silently when no emit is configured", async () => {
    const r = make(
      async () => "v",
      async () => {
        throw new Error("release failed");
      },
    );

    // No body error — release failing quietly shouldn't reject.
    await expect(r.use(async () => 1)).resolves.toBe(1);
  });
});

describe("resource.map", () => {
  it("transforms value without affecting lifecycle", async () => {
    const events: string[] = [];
    const base = make(
      () => {
        events.push("acquire");
        return { raw: 10 };
      },
      () => {
        events.push("release");
      },
    );

    const mapped = base.map((v) => v.raw * 5);

    const result = await mapped.use(async (v) => {
      events.push(`use:${v}`);
      return v + 1;
    });

    expect(result).toBe(51);
    // CRITICAL: the underlying resource was released exactly once.
    expect(events).toEqual(["acquire", "use:50", "release"]);
  });

  it("chained maps compose without re-acquiring", async () => {
    let acquireCount = 0;
    let releaseCount = 0;
    const r = make(
      () => {
        acquireCount += 1;
        return 10;
      },
      () => {
        releaseCount += 1;
      },
    )
      .map((n) => n + 1)
      .map((n) => n * 2);

    const result = await r.use(async (v) => v);
    expect(result).toBe(22);
    expect(acquireCount).toBe(1);
    expect(releaseCount).toBe(1);
  });
});

describe("resource.of", () => {
  it("exposes a pre-held value with no release work", async () => {
    const r = of({ already: "here" });
    const result = await r.use(async (v) => v.already);
    expect(result).toBe("here");
  });
});

describe("resource.bracket", () => {
  it("is equivalent to make(...).use(...)", async () => {
    const events: string[] = [];
    const result = await bracket(
      async () => {
        events.push("acq");
        return 7;
      },
      async () => {
        events.push("rel");
      },
      async (v) => {
        events.push(`use:${v}`);
        return v * 10;
      },
    );

    expect(result).toBe(70);
    expect(events).toEqual(["acq", "use:7", "rel"]);
  });
});

describe("resource events (clock + emit)", () => {
  it("emits acquired and released with durations", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: ResourceEvent[] = [];

    const r = make(
      async () => {
        clock.advanceBy(5 as never); // 5ms during acquire
        return "v";
      },
      async () => {
        clock.advanceBy(3 as never); // 3ms during release
      },
      { clock, name: "test-resource", emit: (e) => events.push(e) },
    );

    await r.use(async () => "ok");

    const types = events.map((e) => e.type);
    expect(types).toEqual(["resource:acquired", "resource:released"]);

    const acquired = events[0]!;
    const released = events[1]!;
    if (acquired.type === "resource:acquired") {
      expect(acquired.name).toBe("test-resource");
      expect(acquired.durationMs).toBe(5);
    }
    if (released.type === "resource:released") {
      expect(released.durationMs).toBe(3);
    }
  });

  it("emits acquire-failed with cause when acquire throws", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: ResourceEvent[] = [];

    const r = make(
      () => {
        throw new Error("cannot connect");
      },
      () => {},
      { clock, name: "broken", emit: (e) => events.push(e) },
    );

    await expect(r.use(async () => 1)).rejects.toThrow("cannot connect");

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("resource:acquire-failed");
    if (ev.type === "resource:acquire-failed") {
      expect((ev.cause as Error).message).toBe("cannot connect");
    }
  });

  it("emits release-failed with the duringUseError flag set", async () => {
    const clock = createControlledClock({ initialTime: 0 });
    const events: ResourceEvent[] = [];

    const r = make(
      async () => "v",
      async () => {
        throw new Error("release boom");
      },
      { clock, name: "leaky", emit: (e) => events.push(e) },
    );

    // Body succeeds; release fails — duringUseError is false.
    await r.use(async () => 1);

    const releaseFailed = events.find((e) => e.type === "resource:release-failed");
    expect(releaseFailed).toBeDefined();
    if (releaseFailed?.type === "resource:release-failed") {
      expect(releaseFailed.duringUseError).toBe(false);
    }

    // Now body AND release fail — duringUseError should be true.
    events.length = 0;
    await expect(
      r.use(async () => {
        throw new Error("body boom");
      }),
    ).rejects.toThrow("body boom");

    const releaseFailed2 = events.find((e) => e.type === "resource:release-failed");
    expect(releaseFailed2).toBeDefined();
    if (releaseFailed2?.type === "resource:release-failed") {
      expect(releaseFailed2.duringUseError).toBe(true);
    }
  });

  it("emitter failures never cascade into the use() caller", async () => {
    const r = make(
      async () => "v",
      async () => {},
      {
        clock: createControlledClock({ initialTime: 0 }),
        emit: () => {
          throw new Error("emitter broke");
        },
      },
    );

    await expect(r.use(async () => 1)).resolves.toBe(1);
  });
});

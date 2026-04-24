import { describe, expect, it } from "vitest";

import { make, of } from "../src/core.js";
import { parallel, sequence } from "../src/compose.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function tracked<T>(
  name: string,
  value: T,
  events: string[],
  options: { failAcquire?: boolean; failRelease?: boolean; delayAcquireMs?: number } = {},
) {
  return make(
    async () => {
      if (options.delayAcquireMs !== undefined) {
        await new Promise((r) => setTimeout(r, options.delayAcquireMs));
      }
      if (options.failAcquire) {
        events.push(`${name}:acquire-failed`);
        throw new Error(`${name} acquire failed`);
      }
      events.push(`${name}:acquire`);
      return value;
    },
    async () => {
      if (options.failRelease) {
        events.push(`${name}:release-failed`);
        throw new Error(`${name} release failed`);
      }
      events.push(`${name}:release`);
    },
  );
}

// ── parallel ──────────────────────────────────────────────────────────────

describe("resource.parallel", () => {
  it("acquires all resources, exposes values together, releases all", async () => {
    const events: string[] = [];
    const a = tracked("A", 1, events);
    const b = tracked("B", "two", events);
    const c = tracked("C", true, events);

    const result = await parallel([a, b, c]).use(async ([av, bv, cv]) => {
      events.push(`use:${av},${bv},${cv}`);
      return av + bv.length + (cv ? 1 : 0);
    });

    expect(result).toBe(1 + 3 + 1);
    // All three acquired, all three released. Acquire and release ORDER between
    // them may interleave — only their presence matters.
    const acquires = events.filter((e) => e.endsWith(":acquire"));
    const releases = events.filter((e) => e.endsWith(":release"));
    expect(acquires).toHaveLength(3);
    expect(releases).toHaveLength(3);
    expect(events).toContain("use:1,two,true");
  });

  it("if one acquire fails, releases the ones that succeeded", async () => {
    const events: string[] = [];
    const a = tracked("A", 1, events);
    const b = tracked("B", 2, events, { failAcquire: true });
    const c = tracked("C", 3, events, { delayAcquireMs: 10 });

    await expect(
      parallel([a, b, c]).use(async () => {
        events.push("use-should-not-run");
        return 1;
      }),
    ).rejects.toThrow("B acquire failed");

    // `use` body must not have run.
    expect(events).not.toContain("use-should-not-run");

    // Every resource that acquired successfully (A and maybe C) got released.
    for (const name of ["A", "C"]) {
      const acquired = events.includes(`${name}:acquire`);
      const released = events.includes(`${name}:release`);
      if (acquired) {
        expect(released).toBe(true);
      }
    }
  });

  it("empty array is a valid resource that exposes []", async () => {
    const result = await parallel([]).use(async (values) => {
      expect(values).toEqual([]);
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("composes with of()", async () => {
    const events: string[] = [];
    const real = tracked("R", 42, events);
    const constant = of("literal");

    const result = await parallel([real, constant]).use(async ([n, s]) => `${n}:${s}`);
    expect(result).toBe("42:literal");
    expect(events).toEqual(["R:acquire", "R:release"]);
  });

  it("propagates body errors after releasing everything", async () => {
    const events: string[] = [];
    const a = tracked("A", 1, events);
    const b = tracked("B", 2, events);

    await expect(
      parallel([a, b]).use(async () => {
        throw new Error("body boom");
      }),
    ).rejects.toThrow("body boom");

    expect(events.filter((e) => e.endsWith(":release"))).toHaveLength(2);
  });
});

// ── sequence ──────────────────────────────────────────────────────────────

describe("resource.sequence", () => {
  it("acquires in order, releases in reverse", async () => {
    const events: string[] = [];
    const a = tracked("A", "a", events);
    const b = tracked("B", "b", events);
    const c = tracked("C", "c", events);

    await sequence([a, b, c]).use(async ([av, bv, cv]) => {
      events.push(`use:${av}${bv}${cv}`);
      return 0;
    });

    expect(events).toEqual(["A:acquire", "B:acquire", "C:acquire", "use:abc", "C:release", "B:release", "A:release"]);
  });

  it("if acquire N fails, releases N-1 ... 0 in reverse", async () => {
    const events: string[] = [];
    const a = tracked("A", 1, events);
    const b = tracked("B", 2, events);
    const c = tracked("C", 3, events, { failAcquire: true });

    await expect(
      sequence([a, b, c]).use(async () => {
        events.push("use-should-not-run");
        return 0;
      }),
    ).rejects.toThrow("C acquire failed");

    expect(events).toEqual([
      "A:acquire",
      "B:acquire",
      "C:acquire-failed",
      // Reverse-order cleanup of what WAS acquired.
      "B:release",
      "A:release",
    ]);
  });

  it("empty array is valid", async () => {
    const result = await sequence([]).use(async (values) => {
      expect(values).toEqual([]);
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("respects dependency ordering — outer lives while inner tears down", async () => {
    const events: string[] = [];

    // Simulate: conn is outer, tx is inner. Tx depends on conn.
    const conn = tracked("conn", { id: "c1" }, events);
    const tx = tracked("tx", { id: "t1" }, events);

    await sequence([conn, tx]).use(async ([connValue, txValue]) => {
      events.push(`work:${connValue.id}+${txValue.id}`);
    });

    // tx must release BEFORE conn — if the order flipped, a tx operation
    // during release would hit a closed connection.
    expect(events).toEqual(["conn:acquire", "tx:acquire", "work:c1+t1", "tx:release", "conn:release"]);
  });
});

// ── map on composed resources ─────────────────────────────────────────────

describe("map over parallel / sequence", () => {
  it("parallel.map transforms without altering lifecycle", async () => {
    const events: string[] = [];
    const a = tracked("A", 10, events);
    const b = tracked("B", 20, events);

    const combined = parallel([a, b]).map(([x, y]) => x + y);

    const result = await combined.use(async (sum) => sum * 2);
    expect(result).toBe(60);
    expect(events.filter((e) => e.endsWith(":release"))).toHaveLength(2);
  });

  it("sequence.map transforms without altering lifecycle", async () => {
    const events: string[] = [];
    const a = tracked("A", "x", events);
    const b = tracked("B", "y", events);

    const combined = sequence([a, b]).map(([x, y]) => `${x}${y}`);
    const result = await combined.use(async (s) => s.toUpperCase());
    expect(result).toBe("XY");
    // Release order is still reverse.
    expect(events.slice(-2)).toEqual(["B:release", "A:release"]);
  });
});

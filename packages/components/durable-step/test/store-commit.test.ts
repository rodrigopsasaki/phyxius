import { describe, it, expect } from "vitest";
import { isOk } from "@phyxiusjs/fp";
import { createSystemClock } from "@phyxiusjs/clock";
import { createMemoryStateStore } from "../src/store.js";

/**
 * `StateStore.trySet` documents that on success it COMMITS `to`. A store that
 * returns `ok` while keeping the old value is a silent false-success — the
 * exact failure this package exists to refuse, so it must not appear in the
 * store the package ships.
 */
describe("createMemoryStateStore — success means committed", () => {
  it("commits a same-kind transition that carries a new payload", async () => {
    const clock = createSystemClock();
    const store = createMemoryStateStore<{ kind: string; attempt: number }>({
      initial: { kind: "running", attempt: 1 },
      clock,
    });

    const result = await store.trySet("running", { kind: "running", attempt: 2 });

    expect(isOk(result)).toBe(true);
    // The claim `ok` makes: the store now holds what was written.
    expect((await store.current()).attempt).toBe(2);
  });

  it("still refuses a transition whose from-kind does not match", async () => {
    const clock = createSystemClock();
    const store = createMemoryStateStore<{ kind: string }>({
      initial: { kind: "running" },
      clock,
    });

    const result = await store.trySet("succeeded", { kind: "failed" });

    expect(isOk(result)).toBe(false);
    expect((await store.current()).kind).toBe("running");
  });
});

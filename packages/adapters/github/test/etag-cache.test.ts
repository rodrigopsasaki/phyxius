import { describe, expect, it } from "vitest";

import { createEtagCache } from "../src/etag-cache.js";

function entry(etag: string, body: unknown) {
  return { etag, body, headers: {}, cachedAt: Date.now() };
}

describe("createEtagCache", () => {
  it("starts empty", () => {
    const c = createEtagCache();
    expect(c.size).toBe(0);
    expect(c.get("k")).toBeUndefined();
  });

  it("set/get round-trips an entry", () => {
    const c = createEtagCache();
    c.set("k", entry("etag-1", { value: 42 }));
    expect(c.get("k")?.etag).toBe("etag-1");
    expect((c.get("k")?.body as { value: number }).value).toBe(42);
  });

  it("delete removes an entry", () => {
    const c = createEtagCache();
    c.set("k", entry("e", "v"));
    c.delete("k");
    expect(c.get("k")).toBeUndefined();
  });

  it("clear empties the cache", () => {
    const c = createEtagCache();
    c.set("a", entry("e1", 1));
    c.set("b", entry("e2", 2));
    c.clear();
    expect(c.size).toBe(0);
  });

  it("evicts least-recently-used when over capacity", () => {
    const c = createEtagCache({ maxEntries: 2 });
    c.set("a", entry("ea", 1));
    c.set("b", entry("eb", 2));
    c.set("c", entry("ec", 3));
    expect(c.get("a")).toBeUndefined(); // 'a' evicted as oldest
    expect(c.get("b")?.etag).toBe("eb");
    expect(c.get("c")?.etag).toBe("ec");
  });

  it("get promotes an entry to most-recent (LRU semantics)", () => {
    const c = createEtagCache({ maxEntries: 2 });
    c.set("a", entry("ea", 1));
    c.set("b", entry("eb", 2));
    c.get("a"); // 'a' becomes most-recent
    c.set("c", entry("ec", 3)); // forces eviction of 'b' (oldest now)
    expect(c.get("a")?.etag).toBe("ea");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")?.etag).toBe("ec");
  });

  it("set with existing key updates value AND recency", () => {
    const c = createEtagCache({ maxEntries: 2 });
    c.set("a", entry("ea", 1));
    c.set("b", entry("eb", 2));
    c.set("a", entry("ea-2", 1.5)); // 'a' becomes most-recent
    c.set("c", entry("ec", 3)); // evicts 'b'
    expect(c.get("a")?.etag).toBe("ea-2");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")?.etag).toBe("ec");
  });

  it("rejects non-positive maxEntries", () => {
    expect(() => createEtagCache({ maxEntries: 0 })).toThrow();
    expect(() => createEtagCache({ maxEntries: -1 })).toThrow();
  });

  it("size reflects current entry count", () => {
    const c = createEtagCache();
    expect(c.size).toBe(0);
    c.set("a", entry("ea", 1));
    expect(c.size).toBe(1);
    c.set("b", entry("eb", 2));
    expect(c.size).toBe(2);
    c.delete("a");
    expect(c.size).toBe(1);
  });
});

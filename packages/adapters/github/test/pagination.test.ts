import { describe, expect, it } from "vitest";

import { paginate, paginateGraphQL, parseLinkHeader } from "../src/pagination.js";

describe("parseLinkHeader", () => {
  it("returns empty for null/undefined/empty", () => {
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader(undefined)).toEqual({});
    expect(parseLinkHeader("")).toEqual({});
    expect(parseLinkHeader("   ")).toEqual({});
  });

  it("parses next + last", () => {
    const header = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=42>; rel="last"';
    const result = parseLinkHeader(header);
    expect(result.next).toBe("https://api.github.com/x?page=2");
    expect(result.last).toBe("https://api.github.com/x?page=42");
  });

  it("parses all four standard rels", () => {
    const header = [
      '<https://api.github.com/x?page=2>; rel="next"',
      '<https://api.github.com/x?page=42>; rel="last"',
      '<https://api.github.com/x?page=1>; rel="first"',
      '<https://api.github.com/x?page=1>; rel="prev"',
    ].join(", ");
    const result = parseLinkHeader(header);
    expect(result.next).toBe("https://api.github.com/x?page=2");
    expect(result.last).toBe("https://api.github.com/x?page=42");
    expect(result.first).toBe("https://api.github.com/x?page=1");
    expect(result.prev).toBe("https://api.github.com/x?page=1");
  });

  it("survives URLs with commas inside angle brackets", () => {
    const header = '<https://api.github.com/search?q=a,b&page=2>; rel="next"';
    const result = parseLinkHeader(header);
    expect(result.next).toBe("https://api.github.com/search?q=a,b&page=2");
  });

  it("accepts unquoted rel values", () => {
    const header = "<https://api.github.com/x?page=2>; rel=next";
    const result = parseLinkHeader(header);
    expect(result.next).toBe("https://api.github.com/x?page=2");
  });

  it("ignores non-standard rels", () => {
    const header = '<https://example.com/a>; rel="custom-rel"';
    expect(parseLinkHeader(header)).toEqual({});
  });

  it("returns empty for malformed input", () => {
    expect(parseLinkHeader("not a link header at all")).toEqual({});
  });
});

describe("paginate (Link-header)", () => {
  it("walks pages until next is absent", async () => {
    const pages = new Map<string, { items: number[]; linkHeader: string | null }>([
      ["https://x/?page=1", { items: [1, 2], linkHeader: '<https://x/?page=2>; rel="next"' }],
      ["https://x/?page=2", { items: [3, 4], linkHeader: '<https://x/?page=3>; rel="next"' }],
      ["https://x/?page=3", { items: [5], linkHeader: null }],
    ]);
    const result = await paginate<number>("https://x/?page=1", async (url) => {
      const page = pages.get(url);
      if (page === undefined) throw new Error(`unexpected url ${url}`);
      return page;
    });
    expect(result.items).toEqual([1, 2, 3, 4, 5]);
    expect(result.hasMore).toBe(false);
  });

  it("stops at maxPages and reports hasMore", async () => {
    const pages = new Map<string, { items: number[]; linkHeader: string | null }>([
      ["https://x/?page=1", { items: [1], linkHeader: '<https://x/?page=2>; rel="next"' }],
      ["https://x/?page=2", { items: [2], linkHeader: '<https://x/?page=3>; rel="next"' }],
      ["https://x/?page=3", { items: [3], linkHeader: '<https://x/?page=4>; rel="next"' }],
    ]);
    const result = await paginate<number>(
      "https://x/?page=1",
      async (url) => {
        const page = pages.get(url);
        if (page === undefined) throw new Error(`unexpected url ${url}`);
        return page;
      },
      { maxPages: 2 },
    );
    expect(result.items).toEqual([1, 2]);
    expect(result.hasMore).toBe(true);
  });

  it("stops at maxItems mid-page and reports hasMore", async () => {
    const pages = new Map<string, { items: number[]; linkHeader: string | null }>([
      ["https://x/?page=1", { items: [1, 2, 3, 4, 5], linkHeader: null }],
    ]);
    const result = await paginate<number>(
      "https://x/?page=1",
      async (url) => {
        const page = pages.get(url);
        if (page === undefined) throw new Error(`unexpected url ${url}`);
        return page;
      },
      { maxItems: 3 },
    );
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.hasMore).toBe(true);
  });

  it("rejects non-positive bounds", async () => {
    await expect(
      paginate("https://x", async () => ({ items: [], linkHeader: null }), { maxPages: 0 }),
    ).rejects.toThrow();
    await expect(
      paginate("https://x", async () => ({ items: [], linkHeader: null }), { maxItems: -1 }),
    ).rejects.toThrow();
  });
});

describe("paginateGraphQL", () => {
  it("walks pages until hasNextPage is false", async () => {
    const pages: Array<{ items: string[]; pageInfo: { hasNextPage: boolean; endCursor?: string } }> = [
      { items: ["a", "b"], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { items: ["c", "d"], pageInfo: { hasNextPage: true, endCursor: "c2" } },
      { items: ["e"], pageInfo: { hasNextPage: false } },
    ];
    let i = 0;
    const result = await paginateGraphQL<string>(async () => {
      const next = pages[i];
      i += 1;
      if (next === undefined) throw new Error("ran out of pages");
      return next;
    });
    expect(result.items).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.hasMore).toBe(false);
  });

  it("stops at maxPages and reports hasMore", async () => {
    const result = await paginateGraphQL<string>(
      async (cursor) => ({
        items: [String(cursor ?? "first")],
        pageInfo: { hasNextPage: true, endCursor: `c${Math.random()}` },
      }),
      { maxPages: 2 },
    );
    expect(result.items.length).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it("stops at maxItems mid-page", async () => {
    const result = await paginateGraphQL<number>(
      async () => ({
        items: [1, 2, 3, 4, 5],
        pageInfo: { hasNextPage: false },
      }),
      { maxItems: 3 },
    );
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.hasMore).toBe(true);
  });
});

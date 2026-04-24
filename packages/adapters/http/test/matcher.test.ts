import { describe, expect, it } from "vitest";

import type { HttpRoute } from "../src/types.js";
import { compilePattern, compileRoutes, matchPattern } from "../src/matcher.js";

describe("compilePattern", () => {
  it("compiles a static path", () => {
    const p = compilePattern("GET", "/orders");
    expect(p.segments).toEqual([{ kind: "literal", value: "orders" }]);
    expect(p.staticCount).toBe(1);
  });

  it("compiles a parameterized path", () => {
    const p = compilePattern("GET", "/orders/:id/items/:itemId");
    expect(p.segments).toEqual([
      { kind: "literal", value: "orders" },
      { kind: "param", name: "id" },
      { kind: "literal", value: "items" },
      { kind: "param", name: "itemId" },
    ]);
    expect(p.staticCount).toBe(2);
  });

  it("compiles the root path", () => {
    const p = compilePattern("GET", "/");
    expect(p.segments).toEqual([]);
    expect(p.staticCount).toBe(0);
  });

  it("rejects paths without a leading slash", () => {
    expect(() => compilePattern("GET", "orders")).toThrow(/must start with/);
  });

  it("rejects empty param names", () => {
    expect(() => compilePattern("GET", "/orders/:")).toThrow(/Empty param/);
  });
});

describe("matchPattern", () => {
  it("matches a simple static path", () => {
    const pattern = compilePattern("GET", "/orders");
    expect(matchPattern(pattern, "GET", "/orders")).toEqual({});
  });

  it("rejects when method differs", () => {
    const pattern = compilePattern("GET", "/orders");
    expect(matchPattern(pattern, "POST", "/orders")).toBeNull();
  });

  it("extracts params and decodes them", () => {
    const pattern = compilePattern("GET", "/orders/:id");
    expect(matchPattern(pattern, "GET", "/orders/abc%20def")).toEqual({ id: "abc def" });
  });

  it("does not match when segment count differs", () => {
    const pattern = compilePattern("GET", "/orders/:id");
    expect(matchPattern(pattern, "GET", "/orders/abc/extra")).toBeNull();
    expect(matchPattern(pattern, "GET", "/orders")).toBeNull();
  });

  it("matches the root path", () => {
    const pattern = compilePattern("GET", "/");
    expect(matchPattern(pattern, "GET", "/")).toEqual({});
  });
});

describe("compileRoutes", () => {
  it("orders more-specific routes first", () => {
    const routes: HttpRoute<unknown, unknown>[] = [
      { method: "GET", path: "/orders/:id", handler: {} as never, decode: () => null },
      { method: "GET", path: "/orders/new", handler: {} as never, decode: () => null },
      { method: "GET", path: "/orders", handler: {} as never, decode: () => null },
    ];

    const compiled = compileRoutes(routes);

    // /orders/new (2 static) should come before /orders/:id (1 static) even though they're same length.
    expect(compiled.entries[0]?.route.path).toBe("/orders/new");
    expect(compiled.entries[1]?.route.path).toBe("/orders/:id");
    expect(compiled.entries[2]?.route.path).toBe("/orders");
  });
});

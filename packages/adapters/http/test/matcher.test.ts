import { describe, expect, it } from "vitest";

import type { HttpRoute } from "../src/types.js";
import { compilePattern, compileRoutes, matchPattern, matchRoute } from "../src/matcher.js";

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

describe("matchRoute", () => {
  it("finds a route and extracts params", () => {
    const routes: HttpRoute<unknown, unknown>[] = [
      { method: "GET", path: "/orders/:id", handler: "get-order" as never, decode: () => null },
    ];
    const result = matchRoute(compileRoutes(routes), "GET", "/orders/abc");
    expect(result).toEqual({ found: true, route: routes[0], params: { id: "abc" } });
  });

  it("reports not_found when no route matches the path at all", () => {
    const routes: HttpRoute<unknown, unknown>[] = [
      { method: "GET", path: "/orders/:id", handler: {} as never, decode: () => null },
    ];
    const result = matchRoute(compileRoutes(routes), "GET", "/nope");
    expect(result).toEqual({ found: false, reason: "not_found" });
  });

  it("reports method_not_allowed when the path matches but the method doesn't", () => {
    const routes: HttpRoute<unknown, unknown>[] = [
      { method: "GET", path: "/orders/:id", handler: {} as never, decode: () => null },
    ];
    const result = matchRoute(compileRoutes(routes), "POST", "/orders/abc");
    expect(result).toEqual({ found: false, reason: "method_not_allowed" });
  });

  // Regression: matchRoute used to check a candidate entry's PATH by
  // temporarily overriding that entry's own method with the REQUESTED
  // method before calling matchPattern — which made the method check
  // inside matchPattern trivially pass for every entry whose path shape
  // matched, regardless of which method it was actually registered for.
  // Two routes sharing a path under different methods meant whichever
  // route happened to be checked first (by specificity/insertion order)
  // won for EVERY method, silently invoking the wrong handler.
  describe("same path, different methods (method must win over insertion order)", () => {
    const routes: HttpRoute<unknown, unknown>[] = [
      { method: "DELETE", path: "/orders/:id", handler: "delete-order" as never, decode: () => null },
      { method: "GET", path: "/orders/:id", handler: "get-order" as never, decode: () => null },
    ];
    const compiled = compileRoutes(routes);

    it("a GET request matches the GET route, not the DELETE route checked first", () => {
      const result = matchRoute(compiled, "GET", "/orders/123");
      expect(result).toEqual({ found: true, route: routes[1], params: { id: "123" } });
    });

    it("a DELETE request matches the DELETE route", () => {
      const result = matchRoute(compiled, "DELETE", "/orders/123");
      expect(result).toEqual({ found: true, route: routes[0], params: { id: "123" } });
    });

    it("a PATCH request (neither registered method) reports method_not_allowed, not a false match", () => {
      const result = matchRoute(compiled, "PATCH", "/orders/123");
      expect(result).toEqual({ found: false, reason: "method_not_allowed" });
    });
  });
});

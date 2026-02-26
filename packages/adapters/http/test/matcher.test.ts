import { describe, it, expect } from "vitest";
import { parseRoutePattern, matchPattern, compareSpecificity, matchRoutes } from "../src/matcher.js";
import type { HttpRoute } from "../src/types.js";

// A stub Handler for routing tests (we only test routing logic, not execution)
function stubHandler(): HttpRoute["handler"] {
  return {
    start: async () => {},
    stop: async () => {},
    submit: async () => ({ _tag: "Ok" as const, value: {} }),
    getMetrics: () => ({
      state: "running" as const,
      activeCount: 0,
      queuedCount: 0,
      totalProcessed: 0,
      totalSucceeded: 0,
      totalFailed: 0,
    }),
    getState: () => "running" as const,
  };
}

function makeRoute(method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", path: string): HttpRoute {
  return {
    method,
    path,
    handler: stubHandler(),
    transform: (params) => params,
  };
}

describe("parseRoutePattern", () => {
  it("parses a static path", () => {
    const pattern = parseRoutePattern("GET", "/users/profile");
    expect(pattern).not.toBeNull();
    expect(pattern?.method).toBe("GET");
    expect(pattern?.path).toBe("/users/profile");
    expect(pattern?.paramNames).toEqual([]);
    expect(pattern?.specificity).toBeGreaterThan(0);
  });

  it("parses a parameterized path", () => {
    const pattern = parseRoutePattern("GET", "/users/:id");
    expect(pattern).not.toBeNull();
    expect(pattern?.paramNames).toEqual(["id"]);
  });

  it("parses a wildcard path", () => {
    const pattern = parseRoutePattern("GET", "/files/*rest");
    expect(pattern).not.toBeNull();
    expect(pattern?.paramNames).toEqual(["rest"]);
    expect(pattern?.specificity).toBeLessThan(0); // wildcard lowers specificity
  });

  it("parses root path /", () => {
    const pattern = parseRoutePattern("GET", "/");
    expect(pattern).not.toBeNull();
  });

  it("returns null for path not starting with /", () => {
    const pattern = parseRoutePattern("GET", "users/profile");
    expect(pattern).toBeNull();
  });

  it("returns null for duplicate param names", () => {
    const pattern = parseRoutePattern("GET", "/users/:id/things/:id");
    expect(pattern).toBeNull();
  });

  it("static paths have higher specificity than parameterized", () => {
    const staticPattern = parseRoutePattern("GET", "/users/profile");
    const paramPattern = parseRoutePattern("GET", "/users/:id");
    expect(staticPattern).not.toBeNull();
    expect(paramPattern).not.toBeNull();
    if (staticPattern && paramPattern) {
      expect(staticPattern.specificity).toBeGreaterThan(paramPattern.specificity);
    }
  });

  it("parameterized paths have higher specificity than wildcard", () => {
    const paramPattern = parseRoutePattern("GET", "/users/:id");
    const wildcardPattern = parseRoutePattern("GET", "/users/*rest");
    expect(paramPattern).not.toBeNull();
    expect(wildcardPattern).not.toBeNull();
    if (paramPattern && wildcardPattern) {
      expect(paramPattern.specificity).toBeGreaterThan(wildcardPattern.specificity);
    }
  });
});

describe("matchPattern", () => {
  it("matches a static path", () => {
    const pattern = parseRoutePattern("GET", "/users/profile")!;
    const params = matchPattern(pattern, "GET", "/users/profile");
    expect(params).not.toBeNull();
    expect(params).toEqual({});
  });

  it("extracts path parameters", () => {
    const pattern = parseRoutePattern("GET", "/users/:id")!;
    const params = matchPattern(pattern, "GET", "/users/42");
    expect(params).not.toBeNull();
    expect(params?.id).toBe("42");
  });

  it("URL-decodes path parameters", () => {
    const pattern = parseRoutePattern("GET", "/items/:name")!;
    const params = matchPattern(pattern, "GET", "/items/hello%20world");
    expect(params?.name).toBe("hello world");
  });

  it("returns null for wrong method", () => {
    const pattern = parseRoutePattern("GET", "/users/:id")!;
    const params = matchPattern(pattern, "POST", "/users/42");
    expect(params).toBeNull();
  });

  it("returns null for non-matching path", () => {
    const pattern = parseRoutePattern("GET", "/users/:id")!;
    const params = matchPattern(pattern, "GET", "/posts/42");
    expect(params).toBeNull();
  });

  it("matches wildcard path and captures rest", () => {
    const pattern = parseRoutePattern("GET", "/files/*rest")!;
    const params = matchPattern(pattern, "GET", "/files/a/b/c.txt");
    expect(params).not.toBeNull();
    expect(params?.rest).toBe("a/b/c.txt");
  });
});

describe("compareSpecificity", () => {
  it("sorts static before parameterized before wildcard", () => {
    const a = parseRoutePattern("GET", "/users/profile")!; // static
    const b = parseRoutePattern("GET", "/users/:id")!; // param
    const c = parseRoutePattern("GET", "/users/*rest")!; // wildcard

    const sorted = [c, b, a].sort(compareSpecificity);
    expect(sorted[0]).toBe(a); // static first
    expect(sorted[1]).toBe(b); // param second
    expect(sorted[2]).toBe(c); // wildcard last
  });
});

describe("matchRoutes", () => {
  it("returns found: true with correct route and params", () => {
    const routes = [{ pattern: parseRoutePattern("GET", "/users/:id")!, route: makeRoute("GET", "/users/:id") }];

    const result = matchRoutes(routes, "GET", "/users/123");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.params).toEqual({ id: "123" });
    }
  });

  it("returns not_found for unrecognized path", () => {
    const routes = [{ pattern: parseRoutePattern("GET", "/users/:id")!, route: makeRoute("GET", "/users/:id") }];

    const result = matchRoutes(routes, "GET", "/unknown/path");
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns method_not_allowed when path matches but method does not", () => {
    const routes = [{ pattern: parseRoutePattern("GET", "/users/:id")!, route: makeRoute("GET", "/users/:id") }];

    const result = matchRoutes(routes, "DELETE", "/users/123");
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("method_not_allowed");
    }
  });

  it("static route wins over parameterized when both could match", () => {
    const staticRoute = makeRoute("GET", "/users/me");
    const paramRoute = makeRoute("GET", "/users/:id");

    const routes = [
      { pattern: parseRoutePattern("GET", "/users/:id")!, route: paramRoute },
      { pattern: parseRoutePattern("GET", "/users/me")!, route: staticRoute },
    ].sort((a, b) => compareSpecificity(a.pattern, b.pattern));

    const result = matchRoutes(routes, "GET", "/users/me");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.route).toBe(staticRoute); // static wins
    }
  });
});

import { describe, it, expect } from "vitest";
import { parseRoutePattern, matchRoute, compareRouteSpecificity } from "../src/pattern.js";
import { isOk, isErr } from "@phyxiusjs/fp";

describe("parseRoutePattern", () => {
  describe("valid patterns", () => {
    it("should parse simple static routes", () => {
      const result = parseRoutePattern("GET", "/users");

      expect(isOk(result)).toBe(true);
      const pattern = result.value;
      expect(pattern.method).toBe("GET");
      expect(pattern.path).toBe("/users");
      expect(pattern.paramNames).toEqual([]);
      expect(pattern.specificity).toBeGreaterThan(0);
      expect(pattern.pathRegex.test("/users")).toBe(true);
      expect(pattern.pathRegex.test("/user")).toBe(false);
    });

    it("should parse routes with parameters", () => {
      const result = parseRoutePattern("POST", "/users/:id/posts/:postId");

      expect(isOk(result)).toBe(true);
      const pattern = result.value;
      expect(pattern.paramNames).toEqual(["id", "postId"]);
      expect(pattern.pathRegex.test("/users/123/posts/456")).toBe(true);
      expect(pattern.pathRegex.test("/users/123/posts")).toBe(false);
    });

    it("should parse routes with wildcards", () => {
      const result = parseRoutePattern("GET", "/assets/*filepath");

      expect(isOk(result)).toBe(true);
      const pattern = result.value;
      expect(pattern.paramNames).toEqual(["filepath"]);
      expect(pattern.pathRegex.test("/assets/images/logo.png")).toBe(true);
      expect(pattern.pathRegex.test("/assets/")).toBe(true);
      expect(pattern.pathRegex.test("/asset")).toBe(false);
    });

    it("should parse root route", () => {
      const result = parseRoutePattern("GET", "/");

      expect(isOk(result)).toBe(true);
      const pattern = result.value;
      expect(pattern.paramNames).toEqual([]);
      expect(pattern.pathRegex.test("/")).toBe(true);
      expect(pattern.pathRegex.test("/users")).toBe(false);
    });

    it("should handle routes with special regex characters", () => {
      const result = parseRoutePattern("GET", "/api/v1.0/users+friends");

      expect(isOk(result)).toBe(true);
      const pattern = result.value;
      expect(pattern.pathRegex.test("/api/v1.0/users+friends")).toBe(true);
      expect(pattern.pathRegex.test("/api/v1X0/users+friends")).toBe(false);
    });
  });

  describe("invalid patterns", () => {
    it("should reject patterns not starting with /", () => {
      const result = parseRoutePattern("GET", "users");

      expect(isErr(result)).toBe(true);
      expect(result.error.code).toBe("INVALID_ROUTE_PATTERN");
    });

    it("should reject empty parameter names", () => {
      const result = parseRoutePattern("GET", "/users/:");

      expect(isErr(result)).toBe(true);
      expect(result.error.code).toBe("INVALID_ROUTE_PATTERN");
    });

    it("should reject duplicate parameter names", () => {
      const result = parseRoutePattern("GET", "/users/:id/posts/:id");

      expect(isErr(result)).toBe(true);
      expect(result.error.code).toBe("INVALID_ROUTE_PATTERN");
    });

    it("should reject duplicate wildcard parameters", () => {
      const result = parseRoutePattern("GET", "/api/*path/assets/*path");

      expect(isErr(result)).toBe(true);
      expect(result.error.code).toBe("INVALID_ROUTE_PATTERN");
    });
  });

  describe("specificity calculation", () => {
    it("should prioritize static segments over parameters", () => {
      const staticResult = parseRoutePattern("GET", "/users/profile");
      const paramResult = parseRoutePattern("GET", "/users/:id");

      expect(isOk(staticResult)).toBe(true);
      expect(isOk(paramResult)).toBe(true);
      expect(staticResult.value.specificity).toBeGreaterThan(paramResult.value.specificity);
    });

    it("should prioritize parameters over wildcards", () => {
      const paramResult = parseRoutePattern("GET", "/files/:name");
      const wildcardResult = parseRoutePattern("GET", "/files/*path");

      expect(isOk(paramResult)).toBe(true);
      expect(isOk(wildcardResult)).toBe(true);
      expect(paramResult.value.specificity).toBeGreaterThan(wildcardResult.value.specificity);
    });

    it("should prioritize longer paths", () => {
      const shortResult = parseRoutePattern("GET", "/api");
      const longResult = parseRoutePattern("GET", "/api/v1/users");

      expect(isOk(shortResult)).toBe(true);
      expect(isOk(longResult)).toBe(true);
      expect(longResult.value.specificity).toBeGreaterThan(shortResult.value.specificity);
    });
  });
});

describe("matchRoute", () => {
  describe("successful matches", () => {
    it("should match static routes", () => {
      const pattern = parseRoutePattern("GET", "/users").value;
      const params = matchRoute(pattern, "GET", "/users");

      expect(params).toEqual({});
    });

    it("should extract parameters", () => {
      const pattern = parseRoutePattern("GET", "/users/:id/posts/:postId").value;
      const params = matchRoute(pattern, "GET", "/users/123/posts/456");

      expect(params).toEqual({ id: "123", postId: "456" });
    });

    it("should decode URL-encoded parameters", () => {
      const pattern = parseRoutePattern("GET", "/users/:name").value;
      const params = matchRoute(pattern, "GET", "/users/john%20doe");

      expect(params).toEqual({ name: "john doe" });
    });

    it("should match wildcards", () => {
      const pattern = parseRoutePattern("GET", "/assets/*filepath").value;
      const params = matchRoute(pattern, "GET", "/assets/images/logo.png");

      expect(params).toEqual({ filepath: "images/logo.png" });
    });

    it("should handle empty wildcard", () => {
      const pattern = parseRoutePattern("GET", "/assets/*filepath").value;
      const params = matchRoute(pattern, "GET", "/assets/");

      expect(params).toEqual({ filepath: "" });
    });
  });

  describe("failed matches", () => {
    it("should not match different methods", () => {
      const pattern = parseRoutePattern("POST", "/users").value;
      const params = matchRoute(pattern, "GET", "/users");

      expect(params).toBeNull();
    });

    it("should not match different paths", () => {
      const pattern = parseRoutePattern("GET", "/users").value;
      const params = matchRoute(pattern, "GET", "/posts");

      expect(params).toBeNull();
    });

    it("should not match incomplete paths", () => {
      const pattern = parseRoutePattern("GET", "/users/:id/posts").value;
      const params = matchRoute(pattern, "GET", "/users/123");

      expect(params).toBeNull();
    });
  });
});

describe("compareRouteSpecificity", () => {
  it("should order routes by specificity (most specific first)", () => {
    const patterns = [
      parseRoutePattern("GET", "/users/*path").value, // least specific
      parseRoutePattern("GET", "/users/:id").value, // medium specific
      parseRoutePattern("GET", "/users/profile").value, // most specific
    ];

    patterns.sort(compareRouteSpecificity);

    expect(patterns[0]!.path).toBe("/users/profile");
    expect(patterns[1]!.path).toBe("/users/:id");
    expect(patterns[2]!.path).toBe("/users/*path");
  });

  it("should handle complex specificity ordering", () => {
    const patterns = [
      parseRoutePattern("GET", "/api/*path").value, // least specific
      parseRoutePattern("GET", "/api/v1/:resource").value, // medium-low
      parseRoutePattern("GET", "/api/v1/users/:id").value, // medium-high
      parseRoutePattern("GET", "/api/v1/users/profile").value, // most specific
    ];

    patterns.sort(compareRouteSpecificity);

    expect(patterns[0]!.path).toBe("/api/v1/users/profile");
    expect(patterns[1]!.path).toBe("/api/v1/users/:id");
    expect(patterns[2]!.path).toBe("/api/v1/:resource");
    expect(patterns[3]!.path).toBe("/api/*path");
  });
});

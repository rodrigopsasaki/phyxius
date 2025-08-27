import { describe, it, expect, beforeEach } from "vitest";
import { Router, createHandler } from "../src/index.js";
import { ok, isOk, isErr } from "@phyxiusjs/fp";
import type { RouteRequest, Middleware } from "../src/types.js";

describe("Router", () => {
  let router: Router;

  beforeEach(() => {
    router = new Router();
  });

  describe("addRoute", () => {
    it("should add a simple route", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const result = router.addRoute("GET", "/users", handler);

      expect(isOk(result)).toBe(true);
      expect(router.getRoutes()).toHaveLength(1);
    });

    it("should reject duplicate routes", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      router.addRoute("GET", "/users", handler);
      const result = router.addRoute("GET", "/users", handler);

      expect(isErr(result)).toBe(true);
      expect(result.error.code).toBe("DUPLICATE_ROUTE");
    });

    it("should allow same path with different methods", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const result1 = router.addRoute("GET", "/users", handler);
      const result2 = router.addRoute("POST", "/users", handler);

      expect(isOk(result1)).toBe(true);
      expect(isOk(result2)).toBe(true);
      expect(router.getRoutes()).toHaveLength(2);
    });

    it("should reject invalid route patterns", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const result = router.addRoute("GET", "invalid-pattern", handler);

      expect(isErr(result)).toBe(true);
      expect(result.error.code).toBe("INVALID_ROUTE_PATTERN");
    });

    it("should wrap handler with middleware", () => {
      const handler = createHandler("test", async () => ok({ status: 200, body: "original" }));
      const middleware: Middleware = (context, next) => {
        context.response = { status: 201, body: "modified" };
        return next();
      };

      const result = router.addRoute("GET", "/users", handler, [middleware]);

      expect(isOk(result)).toBe(true);
      expect(router.getRoutes()).toHaveLength(1);
    });
  });

  describe("match", () => {
    beforeEach(() => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      router.addRoute("GET", "/users", handler);
      router.addRoute("GET", "/users/:id", handler);
      router.addRoute("POST", "/users", handler);
      router.addRoute("GET", "/users/profile", handler);
      router.addRoute("GET", "/admin/*path", handler);
    });

    it("should match exact static routes", () => {
      const match = router.match("GET", "/users");

      expect(match).not.toBeNull();
      expect(match!.route.pattern.path).toBe("/users");
      expect(match!.params).toEqual({});
    });

    it("should match parameterized routes", () => {
      const match = router.match("GET", "/users/123");

      expect(match).not.toBeNull();
      expect(match!.route.pattern.path).toBe("/users/:id");
      expect(match!.params).toEqual({ id: "123" });
    });

    it("should match wildcard routes", () => {
      const match = router.match("GET", "/admin/users/create");

      expect(match).not.toBeNull();
      expect(match!.route.pattern.path).toBe("/admin/*path");
      expect(match!.params).toEqual({ path: "users/create" });
    });

    it("should prioritize most specific routes", () => {
      const match = router.match("GET", "/users/profile");

      expect(match).not.toBeNull();
      expect(match!.route.pattern.path).toBe("/users/profile");
    });

    it("should return null for unmatched routes", () => {
      const match = router.match("GET", "/nonexistent");

      expect(match).toBeNull();
    });

    it("should return null for wrong method", () => {
      const match = router.match("DELETE", "/users");

      expect(match).toBeNull();
    });

    it("should maintain route order by specificity", () => {
      const routes = router.getRoutes();

      // Should be ordered by specificity (most specific first)
      expect(routes[0]!.pattern.path).toBe("/users/profile");
      expect(routes[1]!.pattern.path).toBe("/users");
      expect(routes[2]!.pattern.path).toBe("/users"); // POST /users
      expect(routes[3]!.pattern.path).toBe("/users/:id");
      expect(routes[4]!.pattern.path).toBe("/admin/*path");
    });
  });

  describe("getAllowedMethods", () => {
    beforeEach(() => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      router.addRoute("GET", "/users/:id", handler);
      router.addRoute("POST", "/users/:id", handler);
      router.addRoute("PUT", "/users/:id", handler);
      router.addRoute("DELETE", "/users/:id", handler);
    });

    it("should return allowed methods for a path", () => {
      const methods = router.getAllowedMethods("/users/123");

      expect(methods).toContain("GET");
      expect(methods).toContain("POST");
      expect(methods).toContain("PUT");
      expect(methods).toContain("DELETE");
      expect(methods).toHaveLength(4);
    });

    it("should return empty array for unmatched path", () => {
      const methods = router.getAllowedMethods("/nonexistent");

      expect(methods).toEqual([]);
    });
  });

  describe("middleware integration", () => {
    it("should execute middleware in order", async () => {
      const order: string[] = [];

      const middleware1: Middleware = async (context, next) => {
        order.push("middleware1-start");
        await next();
        order.push("middleware1-end");
      };

      const middleware2: Middleware = async (context, next) => {
        order.push("middleware2-start");
        await next();
        order.push("middleware2-end");
      };

      const handler = createHandler("test", async () => {
        order.push("handler");
        return ok({ status: 200 });
      });

      router.addRoute("GET", "/test", handler, [middleware1, middleware2]);
      const match = router.match("GET", "/test");

      expect(match).not.toBeNull();

      const request: RouteRequest = {
        method: "GET",
        path: "/test",
        params: {},
        query: new URLSearchParams(),
        headers: new Headers(),
        body: undefined,
      };

      await match!.route.handler.handle(request);

      expect(order).toEqual([
        "middleware1-start",
        "middleware2-start",
        "handler",
        "middleware2-end",
        "middleware1-end",
      ]);
    });

    it("should allow middleware to modify response", async () => {
      const middleware: Middleware = (context, next) => {
        context.response.headers = new Headers({ "X-Custom": "modified" });
        return next();
      };

      const handler = createHandler("test", async () => {
        return ok({ status: 200, body: "test" });
      });

      router.addRoute("GET", "/test", handler, [middleware]);
      const match = router.match("GET", "/test");

      expect(match).not.toBeNull();

      const request: RouteRequest = {
        method: "GET",
        path: "/test",
        params: {},
        query: new URLSearchParams(),
        headers: new Headers(),
        body: undefined,
      };

      const result = await match!.route.handler.handle(request);

      expect(isOk(result)).toBe(true);
      expect(result.value.headers?.get("X-Custom")).toBe("modified");
    });

    it("should handle middleware errors", async () => {
      const middleware: Middleware = () => {
        throw new Error("Middleware error");
      };

      const handler = createHandler("test", async () => {
        return ok({ status: 200 });
      });

      router.addRoute("GET", "/test", handler, [middleware]);
      const match = router.match("GET", "/test");

      expect(match).not.toBeNull();

      const request: RouteRequest = {
        method: "GET",
        path: "/test",
        params: {},
        query: new URLSearchParams(),
        headers: new Headers(),
        body: undefined,
      };

      const result = await match!.route.handler.handle(request);

      expect(isErr(result)).toBe(true);
      expect(result.error.message).toBe("Middleware error");
    });
  });

  describe("edge cases", () => {
    it("should handle empty path segments", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const result = router.addRoute("GET", "/api//v1", handler);

      // Should normalize multiple slashes
      expect(isOk(result)).toBe(true);
    });

    it("should handle URL encoding in paths", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      router.addRoute("GET", "/users/:name", handler);

      const match = router.match("GET", "/users/john%20doe");
      expect(match).not.toBeNull();
      expect(match!.params.name).toBe("john doe");
    });

    it("should handle special characters in static segments", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const result = router.addRoute("GET", "/api/v1.0/users+friends", handler);

      expect(isOk(result)).toBe(true);

      const match = router.match("GET", "/api/v1.0/users+friends");
      expect(match).not.toBeNull();
    });
  });
});

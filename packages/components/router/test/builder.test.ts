import { describe, it, expect } from "vitest";
import { route, createHandler } from "../src/index.js";
import { ok, isOk, isErr } from "@phyxiusjs/fp";
import type { RouteRequest, Middleware } from "../src/types.js";

describe("route builder", () => {
  describe("basic route building", () => {
    it("should build GET route", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const builtRoute = route().get("/users").handle(handler);

      expect(builtRoute.pattern.method).toBe("GET");
      expect(builtRoute.pattern.path).toBe("/users");
      expect(builtRoute.handler).toBe(handler);
    });

    it("should build POST route", () => {
      const handler = createHandler("test", async () => ok({ status: 201 }));
      const builtRoute = route().post("/users").handle(handler);

      expect(builtRoute.pattern.method).toBe("POST");
      expect(builtRoute.pattern.path).toBe("/users");
    });

    it("should build PUT route", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const builtRoute = route().put("/users/:id").handle(handler);

      expect(builtRoute.pattern.method).toBe("PUT");
      expect(builtRoute.pattern.path).toBe("/users/:id");
    });

    it("should build DELETE route", () => {
      const handler = createHandler("test", async () => ok({ status: 204 }));
      const builtRoute = route().delete("/users/:id").handle(handler);

      expect(builtRoute.pattern.method).toBe("DELETE");
      expect(builtRoute.pattern.path).toBe("/users/:id");
    });

    it("should build PATCH route", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const builtRoute = route().patch("/users/:id").handle(handler);

      expect(builtRoute.pattern.method).toBe("PATCH");
      expect(builtRoute.pattern.path).toBe("/users/:id");
    });

    it("should build HEAD route", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const builtRoute = route().head("/users").handle(handler);

      expect(builtRoute.pattern.method).toBe("HEAD");
      expect(builtRoute.pattern.path).toBe("/users");
    });

    it("should build OPTIONS route", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const builtRoute = route().options("/users").handle(handler);

      expect(builtRoute.pattern.method).toBe("OPTIONS");
      expect(builtRoute.pattern.path).toBe("/users");
    });
  });

  describe("middleware integration", () => {
    it("should add single middleware", () => {
      const middleware: Middleware = (context, next) => next();
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const builtRoute = route().get("/users").use(middleware).handle(handler);

      expect(builtRoute.pattern.method).toBe("GET");
      expect(builtRoute.pattern.path).toBe("/users");
      // Handler should be wrapped with middleware
      expect(builtRoute.handler).not.toBe(handler);
    });

    it("should chain multiple middleware", () => {
      const middleware1: Middleware = (context, next) => next();
      const middleware2: Middleware = (context, next) => next();
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const builtRoute = route().get("/users").use(middleware1).use(middleware2).handle(handler);

      expect(builtRoute.pattern.method).toBe("GET");
      expect(builtRoute.pattern.path).toBe("/users");
      expect(builtRoute.handler).not.toBe(handler);
    });

    it("should execute middleware in correct order", async () => {
      const executionOrder: string[] = [];

      const middleware1: Middleware = async (context, next) => {
        executionOrder.push("middleware1-start");
        await next();
        executionOrder.push("middleware1-end");
      };

      const middleware2: Middleware = async (context, next) => {
        executionOrder.push("middleware2-start");
        await next();
        executionOrder.push("middleware2-end");
      };

      const handler = createHandler("test", async () => {
        executionOrder.push("handler");
        return ok({ status: 200 });
      });

      const builtRoute = route().get("/users").use(middleware1).use(middleware2).handle(handler);

      const request: RouteRequest = {
        method: "GET",
        path: "/users",
        params: {},
        query: new URLSearchParams(),
        headers: new Headers(),
        body: undefined,
      };

      await builtRoute.handler.handle(request);

      expect(executionOrder).toEqual([
        "middleware1-start",
        "middleware2-start",
        "handler",
        "middleware2-end",
        "middleware1-end",
      ]);
    });

    it("should allow middleware to modify response", async () => {
      const middleware: Middleware = (context, next) => {
        context.response = { status: 201, body: { message: "Created" } };
        return next();
      };

      const handler = createHandler("test", async () => {
        return ok({ status: 200, body: { message: "OK" } });
      });

      const builtRoute = route().get("/users").use(middleware).handle(handler);

      const request: RouteRequest = {
        method: "GET",
        path: "/users",
        params: {},
        query: new URLSearchParams(),
        headers: new Headers(),
        body: undefined,
      };

      const result = await builtRoute.handler.handle(request);

      expect(isOk(result)).toBe(true);
      expect(result.value.status).toBe(201);
      expect(result.value.body).toEqual({ message: "Created" });
    });

    it("should handle middleware errors", async () => {
      const middleware: Middleware = () => {
        throw new Error("Middleware failed");
      };

      const handler = createHandler("test", async () => {
        return ok({ status: 200 });
      });

      const builtRoute = route().get("/users").use(middleware).handle(handler);

      const request: RouteRequest = {
        method: "GET",
        path: "/users",
        params: {},
        query: new URLSearchParams(),
        headers: new Headers(),
        body: undefined,
      };

      const result = await builtRoute.handler.handle(request);

      expect(isErr(result)).toBe(true);
      expect(result.error.message).toBe("Middleware failed");
    });
  });

  describe("fluent interface", () => {
    it("should support method chaining", () => {
      const middleware1: Middleware = (context, next) => next();
      const middleware2: Middleware = (context, next) => next();
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const builtRoute = route().post("/api/users").use(middleware1).use(middleware2).handle(handler);

      expect(builtRoute.pattern.method).toBe("POST");
      expect(builtRoute.pattern.path).toBe("/api/users");
    });

    it("should create new builders for different routes", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const route1 = route().get("/users").handle(handler);
      const route2 = route().post("/users").handle(handler);

      expect(route1.pattern.method).toBe("GET");
      expect(route2.pattern.method).toBe("POST");
      expect(route1).not.toBe(route2);
    });
  });

  describe("parameterized routes", () => {
    it("should handle route parameters", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const builtRoute = route().get("/users/:id/posts/:postId").handle(handler);

      expect(builtRoute.pattern.paramNames).toEqual(["id", "postId"]);
    });

    it("should handle wildcard routes", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const builtRoute = route().get("/static/*filepath").handle(handler);

      expect(builtRoute.pattern.paramNames).toEqual(["filepath"]);
    });
  });

  describe("error handling", () => {
    it("should throw on invalid route patterns", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      expect(() => {
        route().get("invalid-pattern").handle(handler);
      }).toThrow();
    });

    it("should throw on duplicate parameter names", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      expect(() => {
        route().get("/users/:id/posts/:id").handle(handler);
      }).toThrow();
    });
  });
});

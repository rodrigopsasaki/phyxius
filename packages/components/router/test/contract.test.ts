import { describe, it, expect } from "vitest";
import { createContractRouter, implementContract, defineContract, createHandler } from "../src/index.js";
import { ok, isOk } from "@phyxiusjs/fp";
import type { Contract, ImplementContract } from "../src/types.js";

describe("contract-first API", () => {
  describe("createContractRouter", () => {
    it("should create router from contract", () => {
      const getUserHandler = createHandler("getUser", async () =>
        ok({ status: 200, body: { id: "123", name: "John" } }),
      );

      const createUserHandler = createHandler("createUser", async () =>
        ok({ status: 201, body: { id: "456", name: "Jane" } }),
      );

      const contract: Contract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
          handler: getUserHandler,
        },
        createUser: {
          method: "POST",
          path: "/users",
          handler: createUserHandler,
        },
      };

      const contractRouter = createContractRouter(contract);

      expect(contractRouter.getUser.route.pattern.method).toBe("GET");
      expect(contractRouter.getUser.route.pattern.path).toBe("/users/:id");
      expect(contractRouter.getUser.name).toBe("getUser");

      expect(contractRouter.createUser.route.pattern.method).toBe("POST");
      expect(contractRouter.createUser.route.pattern.path).toBe("/users");
      expect(contractRouter.createUser.name).toBe("createUser");

      expect(contractRouter.routes).toHaveLength(2);
    });

    it("should expose router functionality", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const contract: Contract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
          handler,
        },
      };

      const contractRouter = createContractRouter(contract);

      const match = contractRouter.match("GET", "/users/123");
      expect(match).not.toBeNull();
      expect(match!.params).toEqual({ id: "123" });

      const methods = contractRouter.getAllowedMethods("/users/123");
      expect(methods).toEqual(["GET"]);
    });

    it("should handle middleware in contract routes", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));
      const middleware = [(context: unknown, next: () => Promise<void>) => next()];

      const contract: Contract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
          handler,
          middleware,
        },
      };

      const contractRouter = createContractRouter(contract);

      expect(contractRouter.getUser.route.handler).not.toBe(handler);
    });

    it("should throw on invalid route patterns", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const contract: Contract = {
        invalidRoute: {
          method: "GET",
          path: "invalid-pattern",
          handler,
        },
      };

      expect(() => createContractRouter(contract)).toThrow();
    });

    it("should throw on duplicate routes", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const contract: Contract = {
        route1: {
          method: "GET",
          path: "/users",
          handler,
        },
        route2: {
          method: "GET",
          path: "/users",
          handler,
        },
      };

      expect(() => createContractRouter(contract)).toThrow();
    });
  });

  describe("implementContract", () => {
    it("should implement contract with handlers", () => {
      const contract: Contract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
          handler: createHandler("placeholder", async () => {
            throw new Error("Not implemented");
          }),
        },
        createUser: {
          method: "POST",
          path: "/users",
          handler: createHandler("placeholder", async () => {
            throw new Error("Not implemented");
          }),
        },
      };

      const getUserHandler = createHandler("getUser", async () => ok({ status: 200, body: { id: "123" } }));

      const createUserHandler = createHandler("createUser", async () => ok({ status: 201, body: { id: "456" } }));

      const implementation = {
        getUser: getUserHandler,
        createUser: createUserHandler,
      };

      const contractRouter = implementContract(contract, implementation);

      expect(contractRouter.getUser.route.handler).toBe(getUserHandler);
      expect(contractRouter.createUser.route.handler).toBe(createUserHandler);
    });

    it("should throw on missing implementation", () => {
      const contract: Contract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
          handler: createHandler("placeholder", async () => {
            throw new Error("Not implemented");
          }),
        },
        createUser: {
          method: "POST",
          path: "/users",
          handler: createHandler("placeholder", async () => {
            throw new Error("Not implemented");
          }),
        },
      };

      const partialImplementation = {
        getUser: createHandler("getUser", async () => ok({ status: 200 })),
        // Missing createUser implementation
      } as ImplementContract<typeof contract>;

      expect(() => implementContract(contract, partialImplementation)).toThrow();
    });
  });

  describe("defineContract", () => {
    it("should define contract from route definitions", () => {
      const getUserHandler = createHandler("getUser", async () => ok({ status: 200, body: { id: "123" } }));

      const createUserHandler = createHandler("createUser", async () => ok({ status: 201, body: { id: "456" } }));

      const contract = defineContract({
        getUser: {
          method: "GET" as const,
          path: "/users/:id",
          handler: getUserHandler,
        },
        createUser: {
          method: "POST" as const,
          path: "/users",
          handler: createUserHandler,
        },
      });

      expect(contract.getUser.method).toBe("GET");
      expect(contract.getUser.path).toBe("/users/:id");
      expect(contract.getUser.handler).toBe(getUserHandler);

      expect(contract.createUser.method).toBe("POST");
      expect(contract.createUser.path).toBe("/users");
      expect(contract.createUser.handler).toBe(createUserHandler);
    });
  });

  describe("type safety", () => {
    it("should provide type-safe access to routes", () => {
      const getUserHandler = createHandler("getUser", async () =>
        ok({ status: 200, body: { id: "123", name: "John" } }),
      );

      const contract: Contract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
          handler: getUserHandler,
        },
      };

      const contractRouter = createContractRouter(contract);

      // This should be type-safe - getUser should exist and have the correct shape
      expect(contractRouter.getUser.name).toBe("getUser");
      expect(contractRouter.getUser.route.pattern.method).toBe("GET");

      // This should provide type safety at compile time
      // TypeScript would error if we tried to access a non-existent route
      // contractRouter.nonExistentRoute; // Would be a compile error
    });

    it("should maintain type information through implementation", () => {
      interface User {
        id: string;
        name: string;
      }

      interface CreateUserRequest {
        name: string;
      }

      const contract = defineContract({
        getUser: {
          method: "GET" as const,
          path: "/users/:id",
          handler: createHandler("placeholder", async () => {
            throw new Error("Not implemented");
          }),
        },
        createUser: {
          method: "POST" as const,
          path: "/users",
          handler: createHandler("placeholder", async () => {
            throw new Error("Not implemented");
          }),
        },
      });

      const getUserHandler = createHandler("getUser", async (req) =>
        ok({ status: 200, body: { id: req.params.id, name: "John" } as User }),
      );

      const createUserHandler = createHandler("createUser", async (req) =>
        ok({ status: 201, body: { id: "456", name: (req.body as CreateUserRequest).name } as User }),
      );

      const implementation = {
        getUser: getUserHandler,
        createUser: createUserHandler,
      };

      const contractRouter = implementContract(contract, implementation);

      expect(contractRouter.getUser.route.handler).toBe(getUserHandler);
      expect(contractRouter.createUser.route.handler).toBe(createUserHandler);
    });
  });

  describe("integration", () => {
    it("should integrate with router matching", async () => {
      const getUserHandler = createHandler("getUser", async (req: { params: { id: string } }) =>
        ok({ status: 200, body: { id: req.params.id, name: "John" } }),
      );

      const contract: Contract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
          handler: getUserHandler,
        },
      };

      const contractRouter = createContractRouter(contract);
      const match = contractRouter.match("GET", "/users/123");

      expect(match).not.toBeNull();
      expect(match!.params).toEqual({ id: "123" });

      const request = {
        method: "GET" as const,
        path: "/users/123",
        params: match!.params,
        query: new URLSearchParams(),
        headers: new Headers(),
        body: undefined,
      };

      const result = await match!.route.handler.handle(request);

      expect(isOk(result)).toBe(true);
      expect(result.value.status).toBe(200);
      expect(result.value.body).toEqual({ id: "123", name: "John" });
    });
  });
});

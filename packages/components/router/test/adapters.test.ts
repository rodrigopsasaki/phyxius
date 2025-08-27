import { describe, it, expect } from "vitest";
import { tsRestAdapter, openApiAdapter, adaptContract, createAdapter, createHandler } from "../src/index.js";
import { ok, err } from "@phyxiusjs/fp";
import type { TsRestContract, OpenApiContract, HttpMethod } from "../src/types.js";

describe("adapters", () => {
  describe("tsRestAdapter", () => {
    it("should convert ts-rest contract to Phyxius contract", () => {
      const tsRestContract: TsRestContract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
          summary: "Get user by ID",
        },
        createUser: {
          method: "POST",
          path: "/users",
          summary: "Create new user",
        },
      };

      const phyxiusContract = tsRestAdapter.toPhyxiusContract(tsRestContract);

      expect(Object.keys(phyxiusContract)).toHaveLength(2);

      const routeNames = Object.keys(phyxiusContract);
      expect(routeNames).toContain("get_users_id_0");
      expect(routeNames).toContain("post_users_1");

      const getUserRoute = phyxiusContract["get_users_id_0"]!;
      expect(getUserRoute.method).toBe("GET");
      expect(getUserRoute.path).toBe("/users/:id");

      const createUserRoute = phyxiusContract["post_users_1"]!;
      expect(createUserRoute.method).toBe("POST");
      expect(createUserRoute.path).toBe("/users");
    });

    it("should convert Phyxius contract back to ts-rest format", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const phyxiusContract = {
        getUser: {
          method: "GET" as const,
          path: "/users/:id",
          handler,
        },
        createUser: {
          method: "POST" as const,
          path: "/users",
          handler,
        },
      };

      const tsRestContract = tsRestAdapter.fromPhyxiusContract(phyxiusContract);

      expect(Object.keys(tsRestContract)).toHaveLength(2);
      expect(tsRestContract.route_0.method).toBe("get");
      expect(tsRestContract.route_0.path).toBe("/users/:id");
      expect(tsRestContract.route_1.method).toBe("post");
      expect(tsRestContract.route_1.path).toBe("/users");
    });

    it("should handle invalid HTTP methods", () => {
      const tsRestContract = {
        invalidMethod: {
          method: "INVALID",
          path: "/test",
        },
      };

      expect(() => {
        tsRestAdapter.toPhyxiusContract(tsRestContract as TsRestContract);
      }).toThrow();
    });
  });

  describe("openApiAdapter", () => {
    it("should convert OpenAPI contract to Phyxius contract", () => {
      const openApiContract: OpenApiContract = {
        paths: {
          "/users/{id}": {
            get: {
              operationId: "getUser",
              summary: "Get user by ID",
              responses: {
                "200": { description: "Success" },
              },
            },
            delete: {
              operationId: "deleteUser",
              summary: "Delete user",
              responses: {
                "204": { description: "No Content" },
              },
            },
          },
          "/users": {
            post: {
              operationId: "createUser",
              summary: "Create user",
              responses: {
                "201": { description: "Created" },
              },
            },
          },
        },
      };

      const phyxiusContract = openApiAdapter.toPhyxiusContract(openApiContract);

      expect(Object.keys(phyxiusContract)).toHaveLength(3);

      const routeNames = Object.keys(phyxiusContract);
      expect(routeNames).toContain("get_users_id_0");
      expect(routeNames).toContain("delete_users_id_1");
      expect(routeNames).toContain("post_users_2");

      const getUserRoute = phyxiusContract["get_users_id_0"]!;
      expect(getUserRoute.method).toBe("GET");
      expect(getUserRoute.path).toBe("/users/:id"); // Should be converted from {id}

      const deleteUserRoute = phyxiusContract["delete_users_id_1"]!;
      expect(deleteUserRoute.method).toBe("DELETE");
      expect(deleteUserRoute.path).toBe("/users/:id");

      const createUserRoute = phyxiusContract["post_users_2"]!;
      expect(createUserRoute.method).toBe("POST");
      expect(createUserRoute.path).toBe("/users");
    });

    it("should convert Phyxius contract back to OpenAPI format", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const phyxiusContract = {
        getUser: {
          method: "GET" as const,
          path: "/users/:id",
          handler,
        },
        createUser: {
          method: "POST" as const,
          path: "/users",
          handler,
        },
      };

      const openApiContract = openApiAdapter.fromPhyxiusContract(phyxiusContract);

      expect(Object.keys(openApiContract)).toHaveLength(2);
      expect(openApiContract.route_0.method).toBe("get");
      expect(openApiContract.route_0.path).toBe("/users/{id}"); // Should be converted to {id}
      expect(openApiContract.route_0.operationId).toBe("getUsersId");
      expect(openApiContract.route_0.summary).toBe("GET /users/:id");

      expect(openApiContract.route_1.method).toBe("post");
      expect(openApiContract.route_1.path).toBe("/users");
      expect(openApiContract.route_1.operationId).toBe("postUsers");
      expect(openApiContract.route_1.summary).toBe("POST /users");
    });

    it("should handle complex paths in OpenAPI", () => {
      const openApiContract: OpenApiContract = {
        paths: {
          "/api/v1/users/{userId}/posts/{postId}/comments": {
            get: {
              operationId: "getUserPostComments",
              summary: "Get comments for user post",
            },
          },
        },
      };

      const phyxiusContract = openApiAdapter.toPhyxiusContract(openApiContract);

      const routeNames = Object.keys(phyxiusContract);
      expect(routeNames).toHaveLength(1);
      expect(routeNames[0]).toMatch(/get_api_v1_users_userId_posts_postId_comments/);
    });
  });

  describe("adaptContract", () => {
    it("should adapt external contract with handlers", () => {
      const getUserHandler = createHandler("getUser", async () => ok({ status: 200, body: { id: "123" } }));

      const createUserHandler = createHandler("createUser", async () => ok({ status: 201, body: { id: "456" } }));

      const tsRestContract: TsRestContract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
        },
        createUser: {
          method: "POST",
          path: "/users",
        },
      };

      const handlers = {
        get_users_id_0: getUserHandler,
        post_users_1: createUserHandler,
      };

      const contractRouter = adaptContract(tsRestAdapter, tsRestContract, handlers);

      expect(contractRouter.routes).toHaveLength(2);

      const match = contractRouter.match("GET", "/users/123");
      expect(match).not.toBeNull();
      expect(match!.route.handler).toBe(getUserHandler);
    });

    it("should throw on missing handlers", () => {
      const tsRestContract: TsRestContract = {
        getUser: {
          method: "GET",
          path: "/users/:id",
        },
        createUser: {
          method: "POST",
          path: "/users",
        },
      };

      const partialHandlers = {
        get_users_id_0: createHandler("getUser", async () => ok({ status: 200 })),
        // Missing handler for createUser
      };

      expect(() => {
        adaptContract(tsRestAdapter, tsRestContract, partialHandlers);
      }).toThrow();
    });

    it("should work with different adapter types", () => {
      const handler = createHandler("test", async () => ok({ status: 200 }));

      const openApiContract: OpenApiContract = {
        paths: {
          "/users/{id}": {
            get: {
              operationId: "getUser",
            },
          },
        },
      };

      const handlers = {
        get_users_id_0: handler,
      };

      const contractRouter = adaptContract(openApiAdapter, openApiContract, handlers);

      expect(contractRouter.routes).toHaveLength(1);

      const match = contractRouter.match("GET", "/users/123"); // Should match because {id} converted to :id
      expect(match).not.toBeNull();
    });
  });

  describe("createAdapter", () => {
    it("should create custom adapter", () => {
      interface CustomContract {
        routes: Array<{
          name: string;
          method: string;
          url: string;
        }>;
      }

      const customAdapter = createAdapter<CustomContract, { name: string; method: string; url: string }>({
        extractRoutes(contract) {
          return contract.routes;
        },

        createContractRoute(route) {
          return {
            method: route.method.toUpperCase() as HttpMethod,
            path: route.url,
            handler: createHandler("placeholder", async () => {
              return err(new Error("Not implemented"));
            }),
          };
        },

        createExternalRoute(contractRoute) {
          return {
            name: `${contractRoute.method}_${contractRoute.path}`,
            method: contractRoute.method.toLowerCase(),
            url: contractRoute.path,
          };
        },
      });

      const customContract: CustomContract = {
        routes: [
          { name: "getUser", method: "GET", url: "/users/:id" },
          { name: "createUser", method: "POST", url: "/users" },
        ],
      };

      const phyxiusContract = customAdapter.toPhyxiusContract(customContract);

      expect(Object.keys(phyxiusContract)).toHaveLength(2);

      const routeNames = Object.keys(phyxiusContract);
      expect(routeNames).toContain("get_users_id_0");
      expect(routeNames).toContain("post_users_1");

      const getUserRoute = phyxiusContract["get_users_id_0"]!;
      expect(getUserRoute.method).toBe("GET");
      expect(getUserRoute.path).toBe("/users/:id");
    });

    it("should handle roundtrip conversion", () => {
      interface SimpleContract {
        [key: string]: {
          method: string;
          path: string;
        };
      }

      const simpleAdapter = createAdapter<SimpleContract>({
        extractRoutes(contract) {
          return Object.entries(contract).map(([name, route]) => ({ name, ...route }));
        },

        createContractRoute(route: { name: string; method: string; url: string }) {
          return {
            method: route.method.toUpperCase() as HttpMethod,
            path: route.path,
            handler: createHandler("placeholder", async () => ok({ status: 200 })),
          };
        },

        createExternalRoute(contractRoute) {
          return {
            method: contractRoute.method.toLowerCase(),
            path: contractRoute.path,
          };
        },
      });

      const originalContract: SimpleContract = {
        getUser: { method: "GET", path: "/users/:id" },
        createUser: { method: "POST", path: "/users" },
      };

      const phyxiusContract = simpleAdapter.toPhyxiusContract(originalContract);
      const convertedBack = simpleAdapter.fromPhyxiusContract(phyxiusContract);

      expect(Object.keys(convertedBack)).toHaveLength(2);
      expect(convertedBack.route_0.method).toBe("get");
      expect(convertedBack.route_0.path).toBe("/users/:id");
      expect(convertedBack.route_1.method).toBe("post");
      expect(convertedBack.route_1.path).toBe("/users");
    });
  });

  describe("edge cases", () => {
    it("should handle empty contracts", () => {
      const emptyTsRest = {};
      const phyxiusContract = tsRestAdapter.toPhyxiusContract(emptyTsRest);

      expect(Object.keys(phyxiusContract)).toHaveLength(0);
    });

    it("should handle special characters in paths", () => {
      const tsRestContract = {
        specialRoute: {
          method: "GET",
          path: "/api/v1.0/users+friends",
        },
      };

      const phyxiusContract = tsRestAdapter.toPhyxiusContract(tsRestContract);

      expect(Object.keys(phyxiusContract)).toHaveLength(1);
      const routeName = Object.keys(phyxiusContract)[0]!;
      expect(phyxiusContract[routeName]!.path).toBe("/api/v1.0/users+friends");
    });

    it("should handle root paths", () => {
      const tsRestContract = {
        root: {
          method: "GET",
          path: "/",
        },
      };

      const phyxiusContract = tsRestAdapter.toPhyxiusContract(tsRestContract);

      expect(Object.keys(phyxiusContract)).toHaveLength(1);
      const routeName = Object.keys(phyxiusContract)[0]!;
      expect(phyxiusContract[routeName]!.path).toBe("/");
    });
  });
});

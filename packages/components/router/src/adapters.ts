import type { Contract, ContractRoute, HttpMethod, RouteHandler, TsRestContract, OpenApiContract } from "./types.js";
import { createContractRouter } from "./contract.js";
import { err } from "@phyxiusjs/fp";
import { RouterError } from "./types.js";
import { createHandler } from "./utils.js";

export interface ContractAdapter<TExternal> {
  toPhyxiusContract(external: TExternal): Contract;
  fromPhyxiusContract(phyxius: Contract): TExternal;
}

export interface AdapterImplementation<TExternal, TRoute = unknown> {
  extractRoutes(external: TExternal): readonly TRoute[];
  createContractRoute(route: TRoute): ContractRoute;
  createExternalRoute(contractRoute: ContractRoute): TRoute;
}

export function createAdapter<TExternal, TRoute = unknown>(
  implementation: AdapterImplementation<TExternal, TRoute>,
): ContractAdapter<TExternal> {
  return {
    toPhyxiusContract(external: TExternal): Contract {
      const routes = implementation.extractRoutes(external);
      const contract: Record<string, ContractRoute> = {};

      for (const [index, route] of routes.entries()) {
        const contractRoute = implementation.createContractRoute(route);
        const routeName = generateRouteName(contractRoute, index);
        contract[routeName] = contractRoute;
      }

      return contract;
    },

    fromPhyxiusContract(phyxius: Contract): TExternal {
      const routes: TRoute[] = [];

      for (const contractRoute of Object.values(phyxius)) {
        const externalRoute = implementation.createExternalRoute(contractRoute);
        routes.push(externalRoute);
      }

      return reconstructExternal(routes) as TExternal;
    },
  };
}

export const tsRestAdapter: ContractAdapter<TsRestContract> = createAdapter({
  extractRoutes(contract: TsRestContract) {
    return Object.entries(contract).map(([name, route]) => ({ name, ...route }));
  },

  createContractRoute(route: { name: string; method: string; path: string }) {
    const method = route.method.toUpperCase() as HttpMethod;

    if (!isValidHttpMethod(method)) {
      throw new RouterError(`Invalid HTTP method: ${route.method}`, "INVALID_ROUTE_PATTERN", {
        method: route.method,
        route,
      });
    }

    return {
      method,
      path: route.path,
      handler: createPlaceholderHandler(),
    };
  },

  createExternalRoute(contractRoute: ContractRoute) {
    return {
      name: `${contractRoute.method.toLowerCase()}_${contractRoute.path.replace(/[/:]/g, "_")}`,
      method: contractRoute.method.toLowerCase(),
      path: contractRoute.path,
      summary: `${contractRoute.method} ${contractRoute.path}`,
    };
  },
});

export const openApiAdapter: ContractAdapter<OpenApiContract> = createAdapter({
  extractRoutes(contract: OpenApiContract) {
    const routes: Array<{
      method: string;
      path: string;
      operationId?: string;
      summary?: string;
    }> = [];

    for (const [path, pathMethods] of Object.entries(contract.paths)) {
      for (const [method, operation] of Object.entries(pathMethods)) {
        routes.push({
          method: method.toUpperCase(),
          path: convertOpenApiPath(path), // Convert {id} to :id
          operationId: operation.operationId || `${method}${path.replace(/[{}]/g, "_")}`,
          summary: operation.summary || `${method.toUpperCase()} ${path}`,
        });
      }
    }

    return routes;
  },

  createContractRoute(route: { method: string; path: string; operationId?: string; summary?: string }) {
    const method = route.method.toUpperCase() as HttpMethod;

    if (!isValidHttpMethod(method)) {
      throw new RouterError(`Invalid HTTP method: ${route.method}`, "INVALID_ROUTE_PATTERN", {
        method: route.method,
        route,
      });
    }

    return {
      method,
      path: route.path,
      handler: createPlaceholderHandler(),
    };
  },

  createExternalRoute(contractRoute: ContractRoute) {
    return {
      method: contractRoute.method.toLowerCase(),
      path: convertPhyxiusPath(contractRoute.path), // Convert :id to {id}
      operationId: generateOperationId(contractRoute),
      summary: `${contractRoute.method} ${contractRoute.path}`,
    };
  },
});

export function adaptContract<TExternal>(
  adapter: ContractAdapter<TExternal>,
  externalContract: TExternal,
  handlers: Record<string, RouteHandler>,
) {
  const phyxiusContract = adapter.toPhyxiusContract(externalContract);

  const implementedContract: Record<string, ContractRoute> = {};
  for (const [routeName, contractRoute] of Object.entries(phyxiusContract)) {
    const handler = handlers[routeName];
    if (!handler) {
      throw new RouterError(`Missing handler for route: ${routeName}`, "HANDLER_ERROR", { routeName, contractRoute });
    }

    implementedContract[routeName] = {
      ...contractRoute,
      handler,
    };
  }

  return createContractRouter(implementedContract);
}

function generateRouteName(contractRoute: ContractRoute, index: number): string {
  const pathKey =
    contractRoute.path
      .replace(/[/:*{}]/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "root";

  return `${contractRoute.method.toLowerCase()}_${pathKey}_${index}`;
}

function generateOperationId(contractRoute: ContractRoute): string {
  const pathKey =
    contractRoute.path
      .replace(/[/:*{}]/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "root";

  // Convert snake_case to camelCase
  const camelCaseKey = pathKey.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

  return `${contractRoute.method.toLowerCase()}${camelCaseKey.charAt(0).toUpperCase() + camelCaseKey.slice(1)}`;
}

function isValidHttpMethod(method: string): method is HttpMethod {
  return ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method);
}

function createPlaceholderHandler(): RouteHandler {
  return createHandler("placeholder-handler", async () => {
    return err(new RouterError("Handler not implemented", "HANDLER_ERROR"));
  });
}

function convertOpenApiPath(path: string): string {
  // Convert {id} to :id
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function convertPhyxiusPath(path: string): string {
  // Convert :id to {id}
  return path.replace(/:([^/]+)/g, "{$1}");
}

function reconstructExternal<T>(routes: readonly T[]): unknown {
  const result: Record<string, T> = {};
  for (const [index, route] of routes.entries()) {
    result[`route_${index}`] = route;
  }
  return result;
}

import type { Contract, ContractRoute, Route, RouteHandler } from "./types.js";
import { Router } from "./router.js";
import { RouterError } from "./types.js";

export type ContractRouter<TContract extends Contract> = {
  readonly [K in keyof TContract]: {
    readonly route: Route<
      TContract[K] extends ContractRoute<infer TReq, unknown> ? TReq : never,
      TContract[K] extends ContractRoute<unknown, infer TRes> ? TRes : never
    >;
    readonly name: K;
  };
} & {
  readonly router: Router;
  readonly routes: readonly Route[];
  match: Router["match"];
  getAllowedMethods: Router["getAllowedMethods"];
};

export function createContractRouter<TContract extends Contract>(contract: TContract): ContractRouter<TContract> {
  const router = new Router();
  const routeMap: Record<string, { route: Route; name: string }> = {};

  for (const [routeName, contractRoute] of Object.entries(contract)) {
    const result = router.addRoute(
      contractRoute.method,
      contractRoute.path,
      contractRoute.handler,
      contractRoute.middleware || [],
    );

    if (result._tag === "Err") {
      throw result.error;
    }

    const routes = router.getRoutes();
    const route = routes.find(
      (r) => r.pattern.method === contractRoute.method && r.pattern.path === contractRoute.path,
    );

    if (!route) {
      throw new RouterError(`Failed to create route for ${routeName}`, "HANDLER_ERROR", { routeName, contractRoute });
    }

    routeMap[routeName] = {
      route,
      name: routeName,
    };
  }

  return {
    ...routeMap,
    router,
    get routes() {
      return router.getRoutes();
    },
    match: router.match.bind(router),
    getAllowedMethods: router.getAllowedMethods.bind(router),
  };
}

export type ImplementContract<TContract extends Contract> = {
  [K in keyof TContract]: TContract[K]["handler"];
};

export function implementContract<TContract extends Contract>(
  contract: TContract,
  implementation: ImplementContract<TContract>,
): ContractRouter<TContract> {
  const implementedContract: Record<string, ContractRoute> = {};

  for (const [routeName, contractRoute] of Object.entries(contract)) {
    const handler = implementation[routeName];
    if (!handler) {
      throw new RouterError(`Missing implementation for route: ${String(routeName)}`, "HANDLER_ERROR", { routeName });
    }

    implementedContract[routeName] = {
      ...contractRoute,
      handler,
    };
  }

  return createContractRouter(implementedContract as TContract);
}

export type ContractFromRoutes<T> =
  T extends Record<
    string,
    {
      method: infer _M;
      path: infer _P;
      handler: infer _H;
    }
  >
    ? {
        [K in keyof T]: T[K] extends {
          method: infer M extends string;
          path: infer P extends string;
          handler: infer H;
        }
          ? ContractRoute<
              H extends (req: infer Req) => unknown ? Req : never,
              H extends (req: unknown) => Promise<{ value: infer Res }> | { value: infer Res } ? Res : never
            > & {
              method: M;
              path: P;
              handler: H;
            }
          : never;
      }
    : never;

export function defineContract<
  T extends Record<
    string,
    {
      method: string;
      path: string;
      handler: RouteHandler;
    }
  >,
>(routes: T): ContractFromRoutes<T> {
  return routes as ContractFromRoutes<T>;
}

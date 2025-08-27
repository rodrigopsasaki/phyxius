import type {
  Route,
  RouteRequest,
  RouteResponse,
  RouteMatch,
  RouterResult,
  HttpMethod,
  RouteHandler,
  Middleware,
  MiddlewareContext,
} from "./types.js";
import { ok, err } from "@phyxiusjs/fp";
import { RouterError } from "./types.js";
import { parseRoutePattern, matchRoute, compareRouteSpecificity } from "./pattern.js";
import { createHandler } from "./utils.js";

export class Router {
  private readonly routes: Route[] = [];
  private routesSorted = false;

  addRoute<TReq = unknown, TRes = unknown>(
    method: HttpMethod,
    path: string,
    handler: RouteHandler<TReq, TRes>,
    middleware: readonly Middleware<TReq, TRes>[] = [],
  ): RouterResult<void> {
    const patternResult = parseRoutePattern(method, path);
    if (patternResult._tag === "Err") {
      return patternResult;
    }

    const pattern = patternResult.value;

    if (this.routes.some((route) => route.pattern.method === method && route.pattern.path === path)) {
      return err(new RouterError(`Route already exists: ${method} ${path}`, "DUPLICATE_ROUTE", { method, path }));
    }

    const wrappedHandler = middleware.length > 0 ? this.wrapWithMiddleware(handler, middleware) : handler;

    const route: Route<TReq, TRes> = {
      pattern,
      handler: wrappedHandler,
    };

    this.routes.push(route as Route);
    this.routesSorted = false;

    return ok(undefined);
  }

  match(method: HttpMethod, path: string): RouteMatch | null {
    this.ensureRoutesSorted();

    for (const route of this.routes) {
      const params = matchRoute(route.pattern, method, path);
      if (params !== null) {
        return {
          route,
          params,
        };
      }
    }

    return null;
  }

  private ensureRoutesSorted(): void {
    if (!this.routesSorted) {
      this.routes.sort((a, b) => compareRouteSpecificity(a.pattern, b.pattern));
      this.routesSorted = true;
    }
  }

  private wrapWithMiddleware<TReq, TRes>(
    handler: RouteHandler<TReq, TRes>,
    middleware: readonly Middleware<TReq, TRes>[],
  ): RouteHandler<TReq, TRes> {
    return createHandler(
      `middleware-wrapped-${handler.name}`,
      async (request: RouteRequest<TReq>) => {
        const response: RouteResponse<TRes> = { status: 200 };

        const context: MiddlewareContext<TReq, TRes> = {
          request,
          response,
          params: {},
        };

        // Create the middleware chain by composing them in reverse order
        const composedHandler = middleware.reduceRight(
          (nextHandler: () => Promise<void>, currentMiddleware) => {
            return async () => {
              await currentMiddleware(context, nextHandler);
            };
          },
          async () => {
            // This is the final handler in the chain
            const middlewareHeaders = context.response.headers;
            const middlewareStatus = context.response.status;
            const middlewareBody = context.response.body;

            const responseWasModified = middlewareStatus !== 200 || middlewareBody !== undefined || middlewareHeaders;

            if (!responseWasModified) {
              // No middleware changes, use handler result as-is
              const result = await handler.handle(request);
              if (result._tag === "Ok") {
                context.response = result.value;
              } else {
                throw result.error;
              }
            } else {
              // Middleware made changes, run handler and merge results
              const result = await handler.handle(request);
              if (result._tag === "Ok") {
                context.response = {
                  status: middlewareStatus !== 200 ? middlewareStatus : result.value.status,
                  ...(middlewareHeaders && { headers: middlewareHeaders }),
                  ...(result.value.headers && { headers: result.value.headers }),
                  ...(middlewareBody !== undefined && { body: middlewareBody }),
                  ...(result.value.body !== undefined && { body: result.value.body }),
                };
              } else {
                throw result.error;
              }
            }
          },
        );

        try {
          await composedHandler();
          return ok(context.response);
        } catch (error) {
          return err(error instanceof Error ? error : new Error(String(error)));
        }
      },
      handler.config && {
        timeout: handler.config.timeout,
        circuitBreaker: handler.config.circuitBreaker,
      },
    );
  }

  getRoutes(): readonly Route[] {
    this.ensureRoutesSorted();
    return Object.freeze([...this.routes]);
  }

  getAllowedMethods(path: string): HttpMethod[] {
    const methods: HttpMethod[] = [];

    for (const route of this.routes) {
      const params = matchRoute(route.pattern, route.pattern.method, path);
      if (params !== null) {
        methods.push(route.pattern.method);
      }
    }

    return methods;
  }
}

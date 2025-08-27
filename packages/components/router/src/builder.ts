import type { RouteBuilder, PathBuilder, Route, RouteHandler, RouteResponse, Middleware, HttpMethod } from "./types.js";
import { parseRoutePattern } from "./pattern.js";
import { ok, err } from "@phyxiusjs/fp";
import { createHandler } from "./utils.js";

class RouteBuilderImpl<TReq = unknown, TRes = unknown> implements RouteBuilder<TReq, TRes> {
  private readonly middleware: Middleware<TReq, TRes>[] = [];

  constructor(
    private readonly method: HttpMethod,
    private readonly path: string,
  ) {}

  use(middleware: Middleware<TReq, TRes>): RouteBuilder<TReq, TRes> {
    this.middleware.push(middleware);
    return this;
  }

  handle(handler: RouteHandler<TReq, TRes>): Route<TReq, TRes> {
    const patternResult = parseRoutePattern(this.method, this.path);
    if (patternResult._tag === "Err") {
      throw patternResult.error;
    }

    const pattern = patternResult.value;

    return {
      pattern,
      handler: this.middleware.length > 0 ? this.wrapWithMiddleware(handler) : handler,
    };
  }

  private wrapWithMiddleware(handler: RouteHandler<TReq, TRes>): RouteHandler<TReq, TRes> {
    return createHandler(
      `middleware-wrapped-${handler.name}`,
      async (request) => {
        const response: RouteResponse<TRes> = { status: 200 };

        const context = {
          request,
          response,
          params: {},
        };

        // Create the middleware chain by composing them in reverse order
        const composedHandler = this.middleware.reduceRight(
          (nextHandler: () => Promise<void>, currentMiddleware) => {
            return async () => {
              await currentMiddleware(context, nextHandler);
            };
          },
          async () => {
            // This is the final handler in the chain
            // Only call handler if response wasn't already set by middleware
            const responseWasModified = context.response.status !== 200 || context.response.body !== undefined;
            if (!responseWasModified) {
              const result = await handler.handle(request);
              if (result._tag === "Ok") {
                context.response = result.value;
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
}

export class PathBuilderImpl implements PathBuilder {
  get<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes> {
    return new RouteBuilderImpl<TReq, TRes>("GET", path);
  }

  post<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes> {
    return new RouteBuilderImpl<TReq, TRes>("POST", path);
  }

  put<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes> {
    return new RouteBuilderImpl<TReq, TRes>("PUT", path);
  }

  delete<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes> {
    return new RouteBuilderImpl<TReq, TRes>("DELETE", path);
  }

  patch<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes> {
    return new RouteBuilderImpl<TReq, TRes>("PATCH", path);
  }

  head<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes> {
    return new RouteBuilderImpl<TReq, TRes>("HEAD", path);
  }

  options<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes> {
    return new RouteBuilderImpl<TReq, TRes>("OPTIONS", path);
  }
}

export function route(): PathBuilder {
  return new PathBuilderImpl();
}

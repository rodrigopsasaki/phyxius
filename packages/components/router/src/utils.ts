import type { RouteHandler, RouteRequest, RouteResponse } from "./types.js";
import type { Result } from "@phyxiusjs/fp";

export function createHandler<TReq = unknown, TRes = unknown>(
  name: string,
  handlerFn: (request: RouteRequest<TReq>) => Promise<Result<RouteResponse<TRes>, Error>>,
  config?: {
    timeout?: number;
    circuitBreaker?: {
      threshold: number;
      timeout: number;
      resetTimeout: number;
    };
  },
): RouteHandler<TReq, TRes> {
  return {
    name,
    handle: handlerFn,
    config: config || undefined,
  };
}

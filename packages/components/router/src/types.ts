import type { Result } from "@phyxiusjs/fp";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export interface RouteParams {
  readonly [key: string]: string;
}

export interface RouteRequest<TBody = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: RouteParams;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly body: TBody;
}

export interface RouteResponse<TBody = unknown> {
  readonly status: number;
  readonly headers?: Headers;
  readonly body?: TBody;
}

export interface SimpleRouteHandler<TReq = unknown, TRes = unknown> {
  readonly name: string;
  handle(request: RouteRequest<TReq>): Promise<Result<RouteResponse<TRes>, Error>>;
  readonly config?: {
    timeout?: number;
    circuitBreaker?: {
      threshold: number;
      timeout: number;
      resetTimeout: number;
    };
  };
}

export type RouteHandler<TReq = unknown, TRes = unknown> = SimpleRouteHandler<TReq, TRes>;

export interface RoutePattern {
  readonly method: HttpMethod;
  readonly path: string;
  readonly specificity: number;
  readonly paramNames: readonly string[];
  readonly pathRegex: RegExp;
}

export interface Route<TReq = unknown, TRes = unknown> {
  readonly pattern: RoutePattern;
  readonly handler: RouteHandler<TReq, TRes>;
}

export interface RouteMatch<TReq = unknown, TRes = unknown> {
  readonly route: Route<TReq, TRes>;
  readonly params: RouteParams;
}

export type RouterResult<T> = Result<T, RouterError>;

export class RouterError extends Error {
  constructor(
    message: string,
    public readonly code: RouterErrorCode,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RouterError";
  }
}

export type RouterErrorCode =
  | "ROUTE_NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INVALID_ROUTE_PATTERN"
  | "DUPLICATE_ROUTE"
  | "HANDLER_ERROR";

export interface MiddlewareContext<TReq = unknown, TRes = unknown> {
  readonly request: RouteRequest<TReq>;
  response: RouteResponse<TRes>;
  readonly params: RouteParams;
}

export type Middleware<TReq = unknown, TRes = unknown> = (
  context: MiddlewareContext<TReq, TRes>,
  next: () => Promise<void>,
) => Promise<void> | void;

export interface ContractRoute<TReq = unknown, TRes = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: RouteHandler<TReq, TRes>;
  readonly middleware?: readonly Middleware<TReq, TRes>[];
}

export interface Contract {
  readonly [routeName: string]: ContractRoute;
}

export interface RouteBuilder<TReq = unknown, TRes = unknown> {
  use(middleware: Middleware<TReq, TRes>): RouteBuilder<TReq, TRes>;
  handle(handler: RouteHandler<TReq, TRes>): Route<TReq, TRes>;
}

export interface PathBuilder {
  get<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes>;
  post<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes>;
  put<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes>;
  delete<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes>;
  patch<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes>;
  head<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes>;
  options<TReq = unknown, TRes = unknown>(path: string): RouteBuilder<TReq, TRes>;
}

export interface ExternalContract {
  readonly [routeName: string]: {
    readonly method: string;
    readonly path: string;
    readonly summary?: string;
    readonly description?: string;
    readonly body?: unknown;
    readonly responses?: Record<number, unknown>;
    readonly query?: unknown;
    readonly params?: unknown;
    readonly headers?: unknown;
  };
}

export interface TsRestContract {
  readonly [routeName: string]: {
    readonly method: string;
    readonly path: string;
    readonly summary?: string;
    readonly description?: string;
    readonly body?: unknown;
    readonly responses?: Record<number, unknown>;
    readonly query?: unknown;
    readonly params?: unknown;
    readonly headers?: unknown;
  };
}

export interface OpenApiContract {
  readonly paths: {
    readonly [path: string]: {
      readonly [method: string]: {
        readonly operationId?: string;
        readonly summary?: string;
        readonly description?: string;
        readonly parameters?: unknown[];
        readonly requestBody?: unknown;
        readonly responses?: Record<string, unknown>;
      };
    };
  };
}

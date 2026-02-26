import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { isOk } from "@phyxiusjs/fp";
import type {
  HttpAdapter,
  HttpAdapterConfig,
  HttpAdapterResponse,
  HttpMethod,
  IncomingRequest,
  RoutePattern,
  HttpRoute,
} from "./types.js";
import { parseRoutePattern, compareSpecificity, matchRoutes } from "./matcher.js";

interface CompiledRoute {
  pattern: RoutePattern;
  route: HttpRoute;
}

const DEFAULT_404_RESPONSE: HttpAdapterResponse = {
  status: 404,
  headers: { "content-type": "application/json" },
  body: { error: "Not Found" },
};

const DEFAULT_503_RESPONSE: HttpAdapterResponse = {
  status: 503,
  headers: { "content-type": "application/json" },
  body: { error: "Service Unavailable", message: "Too many requests — try again later" },
};

const DEFAULT_405_RESPONSE: HttpAdapterResponse = {
  status: 405,
  headers: { "content-type": "application/json" },
  body: { error: "Method Not Allowed" },
};

/**
 * Create an HTTP adapter that routes incoming Node.js HTTP requests to Handlers.
 *
 * Route specificity ordering is automatic:
 *   static > parameterized > wildcard
 *
 * The adapter's only job is translation — all intelligence lives in the Handler
 * (concurrency, backpressure, circuit breaking) and the Runtime (timeout, retry).
 *
 * @example
 * const adapter = createHttpAdapter({
 *   routes: [
 *     {
 *       method: "GET",
 *       path: "/users/:id",
 *       handler: userHandler,
 *       transform: (params) => ({ userId: params.id }),
 *     },
 *   ],
 * });
 *
 * const server = createServer((req, res) => adapter.handle(req, res));
 */
export function createHttpAdapter(config: HttpAdapterConfig): HttpAdapter {
  // Compile and sort routes by specificity (highest first)
  const compiledRoutes: CompiledRoute[] = [];

  for (const route of config.routes) {
    const pattern = parseRoutePattern(route.method, route.path);
    if (!pattern) {
      throw new Error(`Invalid route pattern: ${route.method} ${route.path}`);
    }
    compiledRoutes.push({ pattern, route });
  }

  compiledRoutes.sort((a, b) => compareSpecificity(a.pattern, b.pattern));

  function on404(req: IncomingRequest): HttpAdapterResponse {
    return config.on404 ? config.on404(req) : DEFAULT_404_RESPONSE;
  }

  function on503(req: IncomingRequest): HttpAdapterResponse {
    return config.on503 ? config.on503(req) : DEFAULT_503_RESPONSE;
  }

  function writeResponse(res: ServerResponse, response: HttpAdapterResponse): void {
    res.statusCode = response.status;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...response.headers,
    };

    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }

    if (response.body !== undefined) {
      res.end(JSON.stringify(response.body));
    } else {
      res.end();
    }
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      });

      req.on("error", reject);
    });
  }

  function normalizeHeaders(req: IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }
    return headers;
  }

  function parseQuery(url: string): Record<string, string> {
    const queryIndex = url.indexOf("?");
    if (queryIndex === -1) {
      return {};
    }
    const queryString = url.slice(queryIndex + 1);
    const params: Record<string, string> = {};
    for (const pair of queryString.split("&")) {
      const [key, value] = pair.split("=");
      if (key) {
        params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : "";
      }
    }
    return params;
  }

  function parsePath(url: string): string {
    const queryIndex = url.indexOf("?");
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
  }

  const adapter: HttpAdapter = {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const method = (req.method ?? "GET").toUpperCase() as HttpMethod;
      const rawUrl = req.url ?? "/";
      const path = parsePath(rawUrl);
      const query = parseQuery(rawUrl);
      const headers = normalizeHeaders(req);

      const incomingRequest: IncomingRequest = {
        method,
        path,
        headers,
        query,
        body: undefined,
      };

      // Route matching
      const matchResult = matchRoutes(compiledRoutes, method, path);

      if (!matchResult.found) {
        if (matchResult.reason === "method_not_allowed") {
          writeResponse(res, DEFAULT_405_RESPONSE);
        } else {
          writeResponse(res, on404(incomingRequest));
        }
        return;
      }

      const { route, params } = matchResult;

      // Read body for methods that typically have one
      const body = method === "POST" || method === "PUT" || method === "PATCH" ? await readBody(req) : undefined;

      const correlationId = (headers["x-correlation-id"] ?? headers["x-request-id"]) || randomUUID();

      // Transform HTTP fields → typed Handler input
      const input = route.transform(params, body, headers, query);

      // Submit to the Handler
      const result = await route.handler.submit(input, {
        source: "http",
        correlationId,
        context: { method, path, query },
      });

      if (!isOk(result)) {
        const handlerError = result.error;

        if (handlerError.code === "BACKPRESSURE_REJECT" || handlerError.code === "HANDLER_NOT_RUNNING") {
          writeResponse(res, on503(incomingRequest));
          return;
        }

        writeResponse(res, {
          status: 500,
          headers: { "content-type": "application/json" },
          body: {
            error: "Internal Server Error",
            message: handlerError.message,
            correlationId,
          },
        });
        return;
      }

      writeResponse(res, {
        status: 200,
        headers: { "content-type": "application/json", "x-correlation-id": correlationId },
        body: result.value,
      });
    },
  };

  return adapter;
}

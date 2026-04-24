import type { IncomingMessage, ServerResponse } from "node:http";

import type { Result } from "@phyxiusjs/fp";
import type { HandlerError, RunningHandler } from "@phyxiusjs/handler";

import { defaultEncode } from "./encode.js";
import { compileRoutes, type CompiledRoutes, type Segment } from "./matcher.js";
import type { HttpAdapterOptions, HttpMethod, HttpRequest, HttpResponse, HttpRoute } from "./types.js";

export type { HttpAdapterOptions, HttpMethod, HttpRequest, HttpResponse, HttpRoute, MatchResult } from "./types.js";
export { defaultEncode } from "./encode.js";
export { compilePattern, matchPattern, compileRoutes, matchRoute } from "./matcher.js";

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * HTTP adapter. The core is a pure `handle(HttpRequest) → HttpResponse`
 * function — it knows nothing about Node streams, sockets, or framework
 * glue. `listener` is the thin wrapper that makes it usable with
 * `http.createServer`. Tests exercise `handle` directly.
 */
export interface HttpAdapter {
  /**
   * Route and invoke the matching handler. Returns the encoded response.
   * Never throws — adapter-level failures become 500s via `onInternalError`.
   */
  handle(request: HttpRequest): Promise<HttpResponse>;

  /**
   * Node `http`/`https` listener. Parses the incoming message into an
   * `HttpRequest`, runs `handle`, and writes the response to the socket.
   */
  listener(req: IncomingMessage, res: ServerResponse): Promise<void>;

  /** The compiled route table, exposed for diagnostics and testing. */
  readonly routes: CompiledRoutes;
}

/**
 * Build an HTTP adapter. Routes are compiled and ordered by specificity at
 * construction time — there's no runtime scanning beyond the match loop.
 */
export function createHttpAdapter(options: HttpAdapterOptions): HttpAdapter {
  const routes = compileRoutes(options.routes);
  const correlationHeaders = options.correlationIdHeaders ?? DEFAULT_CORRELATION_HEADERS;
  const on404 = options.on404 ?? defaultOn404;
  const on405 = options.on405 ?? defaultOn405;
  const onInternalError = options.onInternalError ?? defaultOnInternalError;

  async function handle(request: HttpRequest): Promise<HttpResponse> {
    try {
      return await dispatch(request, routes, {
        correlationHeaders,
        on404,
        on405,
      });
    } catch (error) {
      return onInternalError(error, request);
    }
  }

  async function listener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let request: HttpRequest;
    try {
      request = await readHttpRequest(req);
    } catch (error) {
      writeResponse(res, onInternalError(error, emptyRequestFor(req)));
      return;
    }

    const response = await handle(request);
    writeResponse(res, response);
  }

  return { handle, listener, routes };
}

// ── Core dispatch ──────────────────────────────────────────────────────────

interface DispatchDeps {
  readonly correlationHeaders: ReadonlyArray<string>;
  readonly on404: (req: HttpRequest) => HttpResponse;
  readonly on405: (req: HttpRequest) => HttpResponse;
}

async function dispatch(request: HttpRequest, routes: CompiledRoutes, deps: DispatchDeps): Promise<HttpResponse> {
  // Walk compiled routes once. We track path-only matches so we can
  // distinguish "no such path" (404) from "path exists, wrong method" (405).
  let pathMatchedAnyMethod = false;

  for (const entry of routes.entries) {
    const {pattern} = entry;
    if (pattern.method !== request.method) {
      // Different method: check if path shape matches to flag 405 candidacy.
      if (pathShapeMatches(pattern.segments, request.path)) {
        pathMatchedAnyMethod = true;
      }
      continue;
    }

    const params = extractParams(pattern.segments, request.path);
    if (params === null) continue;

    return invokeRoute(entry.route, { ...request, params }, deps.correlationHeaders);
  }

  return pathMatchedAnyMethod ? deps.on405(request) : deps.on404(request);
}

async function invokeRoute(
  route: HttpRoute<unknown, unknown>,
  request: HttpRequest,
  correlationHeaders: ReadonlyArray<string>,
): Promise<HttpResponse> {
  const input = route.decode(request);

  const correlationId = firstHeader(request.headers, correlationHeaders);

  const meta: Parameters<RunningHandler<unknown, unknown>["invoke"]>[1] = {
    source: "http",
    context: {
      method: request.method,
      path: request.path,
      params: request.params,
      query: request.query,
    },
    ...(correlationId !== undefined ? { correlationId } : {}),
  };

  const result: Result<unknown, HandlerError> = await (route.handler as RunningHandler<unknown, unknown>).invoke(
    input,
    meta,
  );

  const encode = route.encode ?? defaultEncode;
  return encode(result, request);
}

// ── Pattern helpers (duplicated from matcher to avoid allocating params twice) ─

function pathShapeMatches(segments: ReadonlyArray<Segment>, path: string): boolean {
  const parts = splitPath(path);
  if (parts.length !== segments.length) return false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (!segment || part === undefined) return false;
    if (segment.kind === "literal" && segment.value !== part) return false;
  }
  return true;
}

function extractParams(segments: ReadonlyArray<Segment>, path: string): Record<string, string> | null {
  const parts = splitPath(path);
  if (parts.length !== segments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (!segment || part === undefined) return null;

    if (segment.kind === "literal") {
      if (segment.value !== part) return null;
    } else {
      params[segment.name] = decodeURIComponent(part);
    }
  }
  return params;
}

function splitPath(path: string): string[] {
  const withoutLead = path.startsWith("/") ? path.slice(1) : path;
  if (withoutLead === "") return [];
  return withoutLead.split("/");
}

// ── Node request parsing ───────────────────────────────────────────────────

/**
 * Convert a Node `IncomingMessage` into a pure `HttpRequest`. Reads the body
 * fully (JSON-decoded when `content-type` indicates JSON), parses the URL,
 * and normalizes headers to lowercase keys.
 */
export async function readHttpRequest(req: IncomingMessage): Promise<HttpRequest> {
  const method = normalizeMethod(req.method);
  const url = new URL(req.url ?? "/", "http://localhost"); // base is synthetic; only used to parse
  const path = url.pathname;
  const query = queryToRecord(url.searchParams);
  const headers = headersToRecord(req.headers);

  const body = hasBody(method) ? await readBody(req, headers) : undefined;

  return {
    method,
    path,
    params: {}, // filled in by the matcher
    query,
    headers,
    body,
  };
}

function normalizeMethod(method: string | undefined): HttpMethod {
  const upper = (method ?? "GET").toUpperCase();
  if (
    upper === "GET" ||
    upper === "POST" ||
    upper === "PUT" ||
    upper === "PATCH" ||
    upper === "DELETE" ||
    upper === "OPTIONS" ||
    upper === "HEAD"
  ) {
    return upper;
  }
  throw new Error(`Unsupported HTTP method: ${method}`);
}

function hasBody(method: HttpMethod): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

async function readBody(req: IncomingMessage, headers: Readonly<Record<string, string>>): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;

  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = headers["content-type"] ?? "";

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      // Leave as raw string; the route decoder can reject via validation.
      return raw;
    }
  }

  return raw;
}

function headersToRecord(headers: IncomingMessage["headers"]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function queryToRecord(params: URLSearchParams): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    out[key] = value;
  }
  return out;
}

function firstHeader(headers: Readonly<Record<string, string>>, names: ReadonlyArray<string>): string | undefined {
  for (const name of names) {
    const value = headers[name.toLowerCase()];
    if (value !== undefined) return value;
  }
  return undefined;
}

function emptyRequestFor(req: IncomingMessage): HttpRequest {
  return {
    method: (() => {
      try {
        return normalizeMethod(req.method);
      } catch {
        return "GET";
      }
    })(),
    path: req.url ?? "/",
    params: {},
    query: {},
    headers: headersToRecord(req.headers),
    body: undefined,
  };
}

// ── Node response writing ──────────────────────────────────────────────────

function writeResponse(res: ServerResponse, response: HttpResponse): void {
  const headers = response.headers ?? {};
  const {body} = response;

  if (body === undefined) {
    res.writeHead(response.status, { ...headers });
    res.end();
    return;
  }

  const contentType = headers["content-type"] ?? "application/json";
  const payload = typeof body === "string" || body instanceof Buffer ? body : JSON.stringify(body);

  res.writeHead(response.status, {
    ...headers,
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload as string | Buffer).toString(),
  });
  res.end(payload);
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CORRELATION_HEADERS: ReadonlyArray<string> = ["x-correlation-id", "x-request-id"];

function defaultOn404(_req: HttpRequest): HttpResponse {
  return {
    status: 404,
    headers: { "content-type": "application/json" },
    body: { error: "NotFound" },
  };
}

function defaultOn405(_req: HttpRequest): HttpResponse {
  return {
    status: 405,
    headers: { "content-type": "application/json" },
    body: { error: "MethodNotAllowed" },
  };
}

function defaultOnInternalError(_error: unknown, _req: HttpRequest): HttpResponse {
  return {
    status: 500,
    headers: { "content-type": "application/json" },
    body: { error: "InternalError" },
  };
}

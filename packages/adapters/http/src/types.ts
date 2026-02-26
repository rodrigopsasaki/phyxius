import type { IncomingMessage, ServerResponse } from "node:http";
import type { Handler } from "@phyxiusjs/handler";

/**
 * HTTP methods supported by the adapter.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

/**
 * Extracted route parameters (path segments like :id become string values).
 */
export interface RouteParams {
  readonly [key: string]: string;
}

/**
 * A compiled route pattern used for matching incoming requests.
 */
export interface RoutePattern {
  readonly method: HttpMethod;
  readonly path: string;
  /** Higher specificity wins. Static segments beat params, params beat wildcards. */
  readonly specificity: number;
  readonly paramNames: readonly string[];
  readonly pathRegex: RegExp;
}

/**
 * A route definition that wires a method + path to a Handler.
 * The `transform` function is the only adapter-specific code:
 * it converts HTTP fields into the typed input expected by the Handler.
 */
export interface HttpRoute<TInput = unknown, TOutput = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: Handler<TInput, TOutput>;
  /**
   * Convert HTTP fields into the typed input for `handler.submit()`.
   * All intelligence about what the handler expects lives here.
   */
  readonly transform: (
    params: RouteParams,
    body: unknown,
    headers: Record<string, string>,
    query: Record<string, string>,
  ) => TInput;
}

/**
 * An incoming HTTP request normalized for the adapter.
 */
export interface IncomingRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

/**
 * The HTTP adapter — converts incoming Node.js HTTP requests into Handler submissions.
 */
export interface HttpAdapter {
  /**
   * Handle a single incoming HTTP request.
   * Performs route matching, calls `handler.submit()`, and writes the response.
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/**
 * Configuration for creating an HTTP adapter.
 */
export interface HttpAdapterConfig {
  /** Ordered list of routes. Will be sorted by specificity automatically. */
  readonly routes: readonly HttpRoute[];
  /** Response handler for unmatched paths. Defaults to 404 JSON. */
  readonly on404?: (req: IncomingRequest) => HttpAdapterResponse;
  /** Response handler for backpressure rejections. Defaults to 503 JSON. */
  readonly on503?: (req: IncomingRequest) => HttpAdapterResponse;
}

/**
 * Internal response shape used within the adapter before writing to ServerResponse.
 */
export interface HttpAdapterResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

/**
 * Result of route matching.
 */
export type MatchResult =
  | { readonly found: true; readonly route: HttpRoute; readonly params: RouteParams }
  | { readonly found: false; readonly reason: "not_found" | "method_not_allowed" };

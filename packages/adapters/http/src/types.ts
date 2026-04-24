import type { Result } from "@phyxiusjs/fp";
import type { HandlerError, RunningHandler } from "@phyxiusjs/handler";

// ── HTTP fundamentals ──────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/**
 * Decoded request passed to route handlers. A pure value — the adapter has
 * already read the body, parsed the URL, and normalized the headers.
 */
export interface HttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Response shape produced by encoders. Body is JSON-serialized if present.
 */
export interface HttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

// ── Route ───────────────────────────────────────────────────────────────────

/**
 * A single route: transport matching + handler wiring.
 *
 * `decode` turns the HTTP request into the handler's typed input. `encode`
 * (optional) turns the handler's Result into an HttpResponse — if omitted,
 * the default encoder in this package maps outcomes to standard HTTP status
 * codes (see the README).
 */
export interface HttpRoute<TInput, TOutput> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: RunningHandler<TInput, TOutput>;
  readonly decode: (req: HttpRequest) => TInput;
  readonly encode?: (result: Result<TOutput, HandlerError>, req: HttpRequest) => HttpResponse;
}

// ── Adapter options ────────────────────────────────────────────────────────

export interface HttpAdapterOptions {
  readonly routes: ReadonlyArray<HttpRoute<unknown, unknown>>;
  /** Override the 404 response. Default: `{ status: 404, body: { error: "Not Found" } }`. */
  readonly on404?: (req: HttpRequest) => HttpResponse;
  /** Override the 405 response (route exists for a different method). */
  readonly on405?: (req: HttpRequest) => HttpResponse;
  /** Override the generic 500 response when the adapter itself throws. */
  readonly onInternalError?: (error: unknown, req: HttpRequest) => HttpResponse;
  /**
   * Header names to inspect for an inbound correlation ID, in order.
   * Defaults to `["x-correlation-id", "x-request-id"]`.
   */
  readonly correlationIdHeaders?: ReadonlyArray<string>;
}

// ── Match result ────────────────────────────────────────────────────────────

export type MatchResult =
  | { readonly found: true; readonly route: HttpRoute<unknown, unknown>; readonly params: Record<string, string> }
  | { readonly found: false; readonly reason: "not_found" | "method_not_allowed" };

/**
 * The transport layer. Every operation calls into this.
 *
 * What transport does, in order:
 *   1. Resolves the auth context (`AuthManager.current()`).
 *   2. Builds the URL from base + path + query.
 *   3. Checks the ETag cache for a cached response keyed by
 *      `<method> <url> <authIdentity>`. If present, attaches
 *      `If-None-Match: <etag>`.
 *   4. Composes headers: Authorization, Accept (per request type),
 *      User-Agent, X-GitHub-Api-Version, X-GitHub-Request-Id when
 *      provided. Caller-supplied headers win on collision.
 *   5. Issues `fetch(url, { method, headers, body, signal })` —
 *      passing `signal` so the handler's timeout aborts the
 *      in-flight request cleanly.
 *   6. Updates the rate-limit tracker from response headers.
 *   7. On 304: returns the cached body and tags `fromCache: true`.
 *   8. On 2xx: parses body per acceptType, refreshes the ETag
 *      cache (if cacheable), returns the parsed body with
 *      `fromCache: false`.
 *   9. On 401 (and we haven't retried yet): forces a token refresh
 *      and retries once. A second 401 surfaces as UNAUTHORIZED.
 *  10. On any other non-2xx: detects the GitHub category, throws
 *      `GithubHttpError`. The connector wrapper catches it and runs
 *      `mapGithubError` to produce the typed `ConnectorError`.
 *
 * Concurrency model: this function is reentrant and stateless apart
 * from the auth/cache/budget instances bound to the config. Multiple
 * operations can call it in parallel safely.
 */

import { createSystemClock, type Clock } from "@phyxiusjs/clock";

import type { AuthContext, AuthManager } from "./auth.js";
import type {
  EtagCache,
  EtagCacheEntry,
  GithubConfig,
  GithubErrorCategory,
  RateLimitResource,
  RateLimitTracker,
} from "./types.js";
import { GithubHttpError } from "./types.js";
import { createEtagCache } from "./etag-cache.js";
import { createRateLimitTracker } from "./rate-limits.js";
import { createAuthManager } from "./auth.js";

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql";
const DEFAULT_USER_AGENT = "phyxius-github/0.1.0";
const DEFAULT_API_VERSION = "2022-11-28";

/**
 * Per-request body-format selector. Determines the `Accept` header
 * and how the response body is parsed.
 */
export type AcceptType =
  | "json" // application/vnd.github+json — the default
  | "diff" // application/vnd.github.v3.diff — raw unified diff
  | "patch" // application/vnd.github.v3.patch — raw mailbox patch
  | "raw"; // raw text (used by file contents API for blob fetches)

export interface RequestInput {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  /** Path relative to baseUrl, e.g., `/repos/{owner}/{repo}/pulls/{number}`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialized as JSON when present. */
  readonly body?: unknown;
  /** Accept header / parsing strategy. Default: "json". */
  readonly acceptType?: AcceptType;
  /** Which budget this charges. Default: "core". */
  readonly resource?: RateLimitResource;
  /**
   * Whether to cache via ETag. Default: true for GET, false otherwise.
   * Mutating requests are never cached.
   */
  readonly cacheable?: boolean;
  /**
   * Override base URL (for GraphQL or Enterprise). Default: config baseUrl.
   */
  readonly baseUrl?: string;
}

export interface ResponseEnvelope<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
  /** True when the body was served from the ETag cache after a 304. */
  readonly fromCache: boolean;
}

export interface Transport {
  /**
   * Issue a request. Throws `GithubHttpError` for HTTP errors and
   * lets node:fetch errors propagate as-is — `mapGithubError`
   * understands both shapes.
   */
  readonly request: <T>(input: RequestInput, signal: AbortSignal | undefined) => Promise<ResponseEnvelope<T>>;

  /** Exposed for operations and observability. */
  readonly auth: AuthManager;
  readonly rateLimits: RateLimitTracker;
  readonly etagCache: EtagCache;
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly graphqlUrl: string;
}

export interface TransportOptions {
  readonly config: GithubConfig;
}

/**
 * Build a transport bound to a `GithubConfig`. One transport per
 * config; operations on the same config share the underlying state.
 */
export function createTransport(options: TransportOptions): Transport {
  const { config } = options;
  const clock = config.clock ?? createSystemClock();
  const fetchImpl = config.fetch ?? fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const graphqlUrl = config.graphqlUrl ?? DEFAULT_GRAPHQL_URL;
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
  const etagCache = config.etagCache ?? createEtagCache();
  const rateLimits = config.rateLimits ?? createRateLimitTracker();
  const auth = createAuthManager({
    auth: config.auth,
    clock,
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {}),
  });

  async function request<T>(input: RequestInput, signal: AbortSignal | undefined): Promise<ResponseEnvelope<T>> {
    const ctx = await auth.current();
    return executeRequest<T>(input, signal, ctx, /* didRefresh*/ false);
  }

  async function executeRequest<T>(
    input: RequestInput,
    signal: AbortSignal | undefined,
    ctx: AuthContext,
    didRefresh: boolean,
  ): Promise<ResponseEnvelope<T>> {
    const {method} = input;
    const url = buildUrl(input.baseUrl ?? baseUrl, input.path, input.query);
    const acceptType = input.acceptType ?? "json";
    const cacheable = input.cacheable ?? method === "GET";
    const cacheKey = cacheable ? buildCacheKey(method, url, ctx.authIdentity) : undefined;
    const cachedEntry = cacheKey !== undefined ? etagCache.get(cacheKey) : undefined;

    const headers = composeHeaders({
      authorization: ctx.authorization,
      acceptType,
      userAgent,
      apiVersion,
      ...(cachedEntry?.etag !== undefined ? { ifNoneMatch: cachedEntry.etag } : {}),
      ...(input.headers !== undefined ? { extra: input.headers } : {}),
      hasJsonBody: input.body !== undefined,
    });

    const init: RequestInit = {
      method,
      headers,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };

    const response = await fetchImpl(url, init);
    const resource = input.resource ?? "core";
    rateLimits.observe(resource, response.headers, clock.now().wallMs);

    // 304 → return cached body
    if (response.status === 304 && cachedEntry !== undefined) {
      // Refresh cachedAt so LRU treats the entry as recently-used.
      if (cacheKey !== undefined) {
        etagCache.set(cacheKey, { ...cachedEntry, cachedAt: clock.now().wallMs });
      }
      return {
        data: cachedEntry.body as T,
        status: response.status,
        headers: response.headers,
        fromCache: true,
      };
    }

    // 2xx → parse body, optionally cache
    if (response.ok) {
      const data = (await parseBody(response, acceptType)) as T;
      if (cacheKey !== undefined) {
        const etag = response.headers.get("etag");
        if (etag !== null) {
          etagCache.set(cacheKey, {
            etag,
            body: data,
            headers: snapshotHeaders(response.headers),
            cachedAt: clock.now().wallMs,
          });
        }
      }
      // GraphQL: 200 with errors-in-body is a logical failure even
      // when HTTP is 200. Detect and surface as graphql-errors.
      if (acceptType === "json" && isGraphQLErrorPayload(data)) {
        throw makeGithubHttpError(response, url, method, "graphql-errors", data);
      }
      return { data, status: response.status, headers: response.headers, fromCache: false };
    }

    // 401 once → refresh + retry
    if (response.status === 401 && !didRefresh) {
      const refreshed = await auth.refresh();
      if (refreshed.authorization !== ctx.authorization) {
        return executeRequest<T>(input, signal, refreshed, /* didRefresh*/ true);
      }
      // Refresh produced no new token — fall through, surface as
      // unauthorized below.
    }

    // Any other non-2xx → categorize + throw GithubHttpError
    const errorBody = await readErrorBody(response, acceptType);
    const category = categorizeError(response.status, response.headers, errorBody);
    throw makeGithubHttpError(response, url, method, category, errorBody);
  }

  return {
    request,
    auth,
    rateLimits,
    etagCache,
    clock,
    baseUrl,
    graphqlUrl,
  };
}

// ── URL + headers ───────────────────────────────────────────────────────────

function buildUrl(
  base: string,
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  let url = `${base}${cleanPath}`;
  if (query !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs.length > 0) url += `?${qs}`;
  }
  return url;
}

interface ComposeHeadersInput {
  readonly authorization: string;
  readonly acceptType: AcceptType;
  readonly userAgent: string;
  readonly apiVersion: string;
  readonly ifNoneMatch?: string;
  readonly extra?: Readonly<Record<string, string>>;
  readonly hasJsonBody: boolean;
}

function composeHeaders(input: ComposeHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: acceptHeaderFor(input.acceptType),
    Authorization: input.authorization,
    "User-Agent": input.userAgent,
    "X-GitHub-Api-Version": input.apiVersion,
  };
  if (input.ifNoneMatch !== undefined) {
    headers["If-None-Match"] = input.ifNoneMatch;
  }
  if (input.hasJsonBody) {
    headers["Content-Type"] = "application/json";
  }
  if (input.extra !== undefined) {
    for (const [k, v] of Object.entries(input.extra)) {
      headers[k] = v;
    }
  }
  return headers;
}

function acceptHeaderFor(acceptType: AcceptType): string {
  switch (acceptType) {
    case "json":
      return "application/vnd.github+json";
    case "diff":
      return "application/vnd.github.v3.diff";
    case "patch":
      return "application/vnd.github.v3.patch";
    case "raw":
      return "application/vnd.github.v3.raw";
  }
}

// ── Body parsing ────────────────────────────────────────────────────────────

async function parseBody(response: Response, acceptType: AcceptType): Promise<unknown> {
  if (acceptType === "json") {
    // Some 2xx responses are intentionally empty (204, 205). Return
    // undefined rather than choking on JSON.parse("").
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(
        `GitHub returned non-JSON body for json request: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // diff/patch/raw — return text verbatim
  return response.text();
}

async function readErrorBody(response: Response, acceptType: AcceptType): Promise<unknown> {
  // For error responses, GitHub usually returns JSON regardless of
  // the requested Accept type. Try JSON first; fall back to text.
  const text = await response.text().catch(() => "");
  if (text.length === 0) return undefined;
  if (acceptType === "json" || text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

// ── Error categorization ────────────────────────────────────────────────────

/**
 * Detect the github-specific category of an error response. The
 * key insight: GitHub returns 403 for both real authorization
 * failures AND primary-rate-limit exhaustion. They have very
 * different policy implications. We disambiguate by checking
 * `X-RateLimit-Remaining` and the body messages.
 */
export function categorizeError(status: number, headers: Headers, body: unknown): GithubErrorCategory {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 408) return "timeout";
  if (status === 422) return "validation";

  if (status === 403) {
    // Primary rate-limit: X-RateLimit-Remaining: 0 with the window
    // not yet reset. The body message often confirms but isn't
    // required — the header is authoritative.
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining !== null && Number(remaining) === 0) {
      return "primary-rate-limit";
    }

    // Abuse-detection: body explicitly names the mechanism.
    const message = extractMessage(body);
    if (message !== undefined) {
      const lower = message.toLowerCase();
      if (lower.includes("abuse detection") || lower.includes("abuse rate limit")) {
        return "abuse-detection";
      }
      if (lower.includes("secondary rate limit")) {
        return "secondary-rate-limit";
      }
    }

    return "forbidden";
  }

  if (status === 429) {
    // 429 is GitHub's secondary-rate-limit signal in newer
    // responses. Could also be primary if X-RateLimit-Remaining: 0
    // — fall back to header check first.
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining !== null && Number(remaining) === 0) {
      return "primary-rate-limit";
    }
    return "secondary-rate-limit";
  }

  if (status >= 500 && status < 600) return "server-error";

  return "unknown";
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const m = (body as { message?: unknown }).message;
  return typeof m === "string" ? m : undefined;
}

// ── GraphQL error detection ─────────────────────────────────────────────────

/**
 * GraphQL responses come back as 200 OK with shape
 * `{ data: ..., errors?: [...] }`. We treat any non-empty `errors`
 * array as a logical failure.
 */
function isGraphQLErrorPayload(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const {errors} = (data as { errors?: unknown });
  return Array.isArray(errors) && errors.length > 0;
}

// ── Cache key + header snapshotting ─────────────────────────────────────────

function buildCacheKey(method: string, url: string, authIdentity: string): string {
  return `${method} ${url} ${authIdentity}`;
}

function snapshotHeaders(headers: Headers): Record<string, string> {
  const snapshot: Record<string, string> = {};
  headers.forEach((value, key) => {
    snapshot[key] = value;
  });
  return snapshot;
}

// ── Error envelope helper ───────────────────────────────────────────────────

function makeGithubHttpError(
  response: Response,
  url: string,
  method: string,
  category: GithubErrorCategory,
  body: unknown,
): GithubHttpError {
  return new GithubHttpError({
    status: response.status,
    headers: snapshotHeaders(response.headers),
    body,
    url,
    method,
    githubCategory: category,
  });
}

// Used by tests / cache-key helpers
export type EtagCacheEntryRef = EtagCacheEntry;

/**
 * Public types for the GitHub connector.
 *
 * The shape of this file is the contract between the connector and
 * everything that uses it. Callers compose `GithubConfig`, then spawn
 * operation specs against their own runtime. Shared cross-operation
 * state (rate-limit budgets, ETag cache, auth-token refresh) lives on
 * the config so that one bot instance can call a hundred operations
 * against the same provider account without each one re-establishing
 * provider state.
 */

import type { Clock } from "@phyxiusjs/clock";

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * The three first-class auth modes GitHub supports.
 *
 * `pat` is the simplest: a personal access token sent as a Bearer
 * credential. Use for scripts and single-user automation.
 *
 * `app` is the production shape: a GitHub App installation. The
 * connector signs a short-lived JWT with the app's RS256 private key,
 * exchanges it for an installation access token (1-hour lifetime),
 * and rotates the installation token automatically before expiry.
 * The app credentials never travel beyond the connector; only the
 * installation token reaches GitHub's API.
 *
 * `oauth` is a user-facing token (e.g., from a GitHub OAuth flow).
 * The connector treats the token as opaque and delegates refresh to
 * the supplied `TokenStorage`. If GitHub returns 401 for a valid-
 * looking token, the connector calls `tokenStorage.refresh()` once
 * before surfacing the failure.
 */
export type GithubAuth =
  | { readonly kind: "pat"; readonly token: string }
  | {
      readonly kind: "app";
      readonly appId: string;
      readonly privateKey: string;
      readonly installationId: number;
    }
  | {
      readonly kind: "oauth";
      readonly token: string;
      readonly refreshToken?: string;
      readonly tokenStorage: OAuthTokenStorage;
    };

/**
 * Pluggable storage and refresh for OAuth tokens. The connector never
 * persists tokens itself; this interface is how the application tells
 * the connector how to load, save, and refresh user-bound credentials.
 *
 * `refresh()` is called when the connector sees a 401 with what it
 * believed was a valid token. The method should return the new token
 * pair or throw to surface the failure.
 */
export interface OAuthTokenStorage {
  readonly load: () => Promise<OAuthTokenSnapshot | undefined>;
  readonly save: (snapshot: OAuthTokenSnapshot) => Promise<void>;
  readonly refresh: (refreshToken: string) => Promise<OAuthTokenSnapshot>;
}

export interface OAuthTokenSnapshot {
  readonly token: string;
  readonly refreshToken?: string;
  /** Unix milliseconds. Absent means "no known expiry"; treat as long-lived. */
  readonly expiresAt?: number;
}

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * The shared bundle every operation reads from. One `GithubConfig`
 * per provider account; multiple operations share state through it.
 */
export interface GithubConfig {
  readonly auth: GithubAuth;

  /** REST base URL. Default: `https://api.github.com`. */
  readonly baseUrl?: string;

  /** GraphQL endpoint. Default: `https://api.github.com/graphql`. */
  readonly graphqlUrl?: string;

  /**
   * Sent as `User-Agent`. GitHub requires a non-empty UA on every
   * request; the connector always sends one. Default identifies the
   * connector + version.
   */
  readonly userAgent?: string;

  /**
   * Sent as `X-GitHub-Api-Version`. Pinning this protects against
   * GitHub's API-version drift. Default: `2022-11-28`.
   */
  readonly apiVersion?: string;

  /**
   * Override fetch. Tests inject a stub here; production callers
   * normally don't set this.
   */
  readonly fetch?: typeof fetch;

  /**
   * Clock used for token expiry, retry-after parsing, rate-limit
   * reset arithmetic. Default: a system clock.
   */
  readonly clock?: Clock;

  /**
   * Shared ETag cache across operations on this config. If unset, the
   * connector creates a default LRU cache of 1024 entries scoped to
   * the config's lifetime. Pass an explicit instance when you want a
   * different policy or external cache.
   */
  readonly etagCache?: EtagCache;

  /**
   * Shared rate-limit tracker across operations. If unset, the
   * connector creates a default in-memory tracker. Multiple configs
   * pointed at the same token must share the same tracker to keep
   * the budget honest.
   */
  readonly rateLimits?: RateLimitTracker;
}

// ── Rate limits ─────────────────────────────────────────────────────────────

/**
 * The GitHub rate-limit resource classes that we account for. Each
 * has its own independent budget. The full list per
 * https://docs.github.com/en/rest/rate-limit/rate-limit#about-rate-limits
 * is broader; we model the ones a real consumer hits often enough
 * that visibility matters.
 */
export type RateLimitResource =
  | "core"
  | "search"
  | "graphql"
  | "code_search"
  | "integration_manifest"
  | "code_scanning_upload";

/**
 * A snapshot of one resource's budget at a point in time. Read this
 * via `RateLimitTracker.budget(resource)`. The values come from
 * `X-RateLimit-*` response headers; when they're missing (e.g., on a
 * cached response or before the first call), the tracker returns
 * `undefined`.
 */
export interface RateLimitBudget {
  readonly resource: RateLimitResource;
  readonly limit: number;
  readonly remaining: number;
  /** Unix milliseconds when the window resets. */
  readonly resetMs: number;
  readonly used: number;
  /** Unix milliseconds when this snapshot was observed. */
  readonly observedAt: number;
}

/**
 * Tracks per-resource budgets observed across requests. The tracker
 * is the single source of truth for "how much budget is left"; the
 * transport layer feeds it after every response, and operations or
 * the caller can query it to make backoff decisions proactively.
 *
 * Implementations must be safe to call concurrently. Default impl
 * uses a Map; concurrent writes for the same resource last-write-
 * wins on observedAt.
 */
export interface RateLimitTracker {
  /** Update from a response's headers. Idempotent for a given response. */
  readonly observe: (resource: RateLimitResource, headers: Headers, nowMs: number) => void;
  /** Current snapshot, or undefined if no observation has occurred yet. */
  readonly budget: (resource: RateLimitResource) => RateLimitBudget | undefined;
  /**
   * True when the current observation says `remaining <= 0` and the
   * reset time hasn't passed. Callers that want to back off
   * voluntarily should consult this before issuing new requests.
   */
  readonly isExhausted: (resource: RateLimitResource, nowMs: number) => boolean;
}

// ── ETag cache ──────────────────────────────────────────────────────────────

/**
 * One cached response keyed by canonical request URL + auth identity.
 * The ETag comes from the response; the body is whatever the
 * operation parsed and asked to cache (parsed JSON for most reads).
 *
 * On a 304 conditional-revalidation, the connector returns the
 * cached body, refreshes the cachedAt timestamp, and counts the
 * revalidation as a separate observation in rate-limit accounting
 * (304s consume budget too).
 */
export interface EtagCacheEntry<T = unknown> {
  readonly etag: string;
  readonly body: T;
  readonly headers: Readonly<Record<string, string>>;
  /** Unix milliseconds when the entry was last refreshed. */
  readonly cachedAt: number;
}

/**
 * Pluggable cache the connector consults before every read and
 * writes after every successful read. Default impl: in-memory LRU.
 *
 * Keying convention: the connector hashes `<method> <url> <auth-id>`
 * where `auth-id` is a stable identifier for the auth context (e.g.
 * the SHA-256 of the access token). This keeps cached responses
 * from leaking across users when one config is reused for multiple
 * tokens — which shouldn't happen, but defense-in-depth.
 */
export interface EtagCache {
  readonly get: (key: string) => EtagCacheEntry | undefined;
  readonly set: <T>(key: string, entry: EtagCacheEntry<T>) => void;
  readonly delete: (key: string) => void;
  readonly clear: () => void;
  readonly size: number;
}

// ── Provider-native error envelope ──────────────────────────────────────────

/**
 * The error a request throws *before* `defineConnector` translates
 * it. The transport layer raises this; the operation's `mapError`
 * (which is just `mapGithubError` for every operation in this
 * package) translates it to `ConnectorError`.
 *
 * Carries enough context that operations can be debugged from the
 * journal entry without re-issuing the request.
 */
export class GithubHttpError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly url: string;
  readonly method: string;
  /**
   * The github-specific error category, derived from status + body.
   * Distinct from ConnectorError because this layer can detect
   * github's quirks (403-as-rate-limit, secondary rate limits,
   * abuse detection) before they reach the generic mapper.
   */
  readonly githubCategory: GithubErrorCategory;

  constructor(input: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
    readonly url: string;
    readonly method: string;
    readonly githubCategory: GithubErrorCategory;
  }) {
    super(`GitHub ${input.method} ${input.url} → ${input.status} (${input.githubCategory})`);
    this.name = "GithubHttpError";
    this.status = input.status;
    this.headers = input.headers;
    this.body = input.body;
    this.url = input.url;
    this.method = input.method;
    this.githubCategory = input.githubCategory;
  }
}

/**
 * GitHub-specific error categories detected before the generic
 * status-based mapping runs. These names exist so the operation
 * layer can distinguish e.g. "primary rate-limit exhausted (403)"
 * from "lacking permission (403)" — both are status 403, very
 * different policy implications.
 */
export type GithubErrorCategory =
  | "unauthorized"
  | "forbidden"
  | "primary-rate-limit"
  | "secondary-rate-limit"
  | "abuse-detection"
  | "not-found"
  | "validation"
  | "timeout"
  | "server-error"
  | "graphql-errors"
  | "unknown";

// ── GraphQL ─────────────────────────────────────────────────────────────────

/**
 * GraphQL responses carry errors in the body even on HTTP 200. The
 * GraphQL transport unwraps the body, surfaces errors as
 * `GithubHttpError(githubCategory: "graphql-errors")`, and only
 * returns the `data` payload when the response is unambiguously
 * successful.
 */
export interface GraphQLError {
  readonly message: string;
  readonly type?: string;
  readonly path?: ReadonlyArray<string | number>;
  readonly locations?: ReadonlyArray<{ readonly line: number; readonly column: number }>;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

// ── Webhook event envelope ──────────────────────────────────────────────────

/**
 * Verified webhook event. The webhook receiver returns this only
 * after HMAC signature verification + replay-window check pass; if
 * either fails, the receiver throws and the handler's stability
 * surface attributes the failure.
 */
export interface VerifiedWebhookEvent<TPayload = unknown> {
  /** GitHub event type from `X-GitHub-Event` header (e.g., `pull_request`). */
  readonly event: string;
  /** Unique delivery id from `X-GitHub-Delivery` for dedup / replay protection. */
  readonly deliveryId: string;
  /** Parsed JSON payload body. */
  readonly payload: TPayload;
  /** Unix milliseconds when the receiver verified the signature. */
  readonly receivedAt: number;
}

/**
 * Auth manager for the three first-class GitHub auth modes.
 *
 * The transport layer talks to an `AuthManager` rather than the raw
 * config so that token rotation is opaque to operations. `current()`
 * returns the auth context to use right now; `refresh()` is called
 * after a 401 to attempt a single re-auth before surfacing the
 * failure. Refresh is at-most-once per request — looped retries are
 * handled at the connector / handler stability layer, not here.
 *
 * Token identity hashing: every auth context carries a stable
 * `authIdentity` derived from a SHA-256 of the bearer token. The
 * ETag cache and the rate-limit tracker key on this so that cached
 * data and budget accounting never leak across users when a single
 * config instance happens to be reused for multiple tokens. (It
 * shouldn't be — but defense-in-depth.)
 */

import { createHash, createSign } from "node:crypto";

import { createSystemClock, type Clock } from "@phyxiusjs/clock";

import type { GithubAuth, OAuthTokenSnapshot } from "./types.js";

/**
 * What the transport layer sees: a header value to send and a
 * stable identifier for cache / budget keying. `expiresAt` is set
 * for installation-token auth so the manager can pre-empt expiry
 * proactively rather than wait for a 401.
 */
export interface AuthContext {
  readonly authorization: string;
  readonly authIdentity: string;
  readonly expiresAt?: number;
}

export interface AuthManager {
  /**
   * The auth context to use for the next request. Refreshes
   * proactively when the cached context is within the expiry-buffer
   * window. Concurrent callers see the same in-flight refresh.
   */
  readonly current: () => Promise<AuthContext>;

  /**
   * Force a refresh. Called by the transport after a 401 with
   * what was thought to be a valid context. Returns the new
   * context; throws if refresh is impossible (e.g., PAT auth has
   * nothing to refresh).
   */
  readonly refresh: () => Promise<AuthContext>;
}

export interface AuthManagerOptions {
  readonly auth: GithubAuth;
  readonly clock?: Clock;
  /**
   * How close to expiry to refresh proactively. Default: 60s.
   * Installation tokens are 1 hour long, so this gives plenty of
   * margin without wasting too much of each token's lifetime.
   */
  readonly expiryBufferMs?: number;
  /**
   * Override fetch for installation-token exchange. Tests inject a
   * stub here; production callers normally don't set this.
   */
  readonly fetch?: typeof fetch;
  /**
   * Override base URL for installation-token exchange. Default:
   * `https://api.github.com`. Useful for GitHub Enterprise.
   */
  readonly apiBaseUrl?: string;
  readonly userAgent?: string;
}

const DEFAULT_EXPIRY_BUFFER_MS = 60_000;
const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_USER_AGENT = "phyxius-github/0.1.0";

export function createAuthManager(options: AuthManagerOptions): AuthManager {
  const { auth } = options;
  switch (auth.kind) {
    case "pat":
      return createPatAuth(auth.token);
    case "oauth":
      return createOAuthAuth(auth, options);
    case "app":
      return createAppAuth(auth, options);
  }
}

// ── PAT ─────────────────────────────────────────────────────────────────────

function createPatAuth(token: string): AuthManager {
  const ctx: AuthContext = {
    authorization: `Bearer ${token}`,
    authIdentity: hashToken(token),
  };

  // PATs don't refresh — but we don't throw on refresh() either,
  // because the transport layer's at-most-one-refresh logic prefers
  // a no-op response over a thrown error here. The actual auth
  // problem will surface on the second 401, which we then map to
  // UNAUTHORIZED.
  return {
    current: async () => ctx,
    refresh: async () => ctx,
  };
}

// ── OAuth ───────────────────────────────────────────────────────────────────

function createOAuthAuth(auth: Extract<GithubAuth, { kind: "oauth" }>, options: AuthManagerOptions): AuthManager {
  const clock = options.clock ?? createSystemClock();
  const expiryBuffer = options.expiryBufferMs ?? DEFAULT_EXPIRY_BUFFER_MS;

  // Cached context is the latest known good snapshot. Loaded lazily
  // from the storage on the first request.
  let cached: AuthContext | undefined;
  let inflightRefresh: Promise<AuthContext> | undefined;

  async function load(): Promise<AuthContext> {
    const stored = await auth.tokenStorage.load();
    const snapshot: OAuthTokenSnapshot = stored ?? {
      token: auth.token,
      ...(auth.refreshToken !== undefined ? { refreshToken: auth.refreshToken } : {}),
    };
    return snapshotToContext(snapshot);
  }

  async function current(): Promise<AuthContext> {
    if (cached !== undefined && !isExpiringSoon(cached, clock.now().wallMs, expiryBuffer)) {
      return cached;
    }
    if (cached === undefined) {
      cached = await load();
      // Re-check after load — the loaded snapshot may itself be
      // close to expiry, in which case we proactively refresh.
      if (!isExpiringSoon(cached, clock.now().wallMs, expiryBuffer)) {
        return cached;
      }
    }
    return refresh();
  }

  async function refresh(): Promise<AuthContext> {
    if (inflightRefresh !== undefined) return inflightRefresh;
    const stored = await auth.tokenStorage.load();
    const refreshToken = stored?.refreshToken ?? auth.refreshToken;
    if (refreshToken === undefined) {
      // Nothing we can do. Return the existing cached or initial
      // context; the transport's retry will see another 401 and
      // surface UNAUTHORIZED.
      cached ??= snapshotToContext({ token: auth.token });
      return cached;
    }
    inflightRefresh = (async () => {
      try {
        const next = await auth.tokenStorage.refresh(refreshToken);
        await auth.tokenStorage.save(next);
        cached = snapshotToContext(next);
        return cached;
      } finally {
        inflightRefresh = undefined;
      }
    })();
    return inflightRefresh;
  }

  return { current, refresh };
}

function snapshotToContext(snapshot: OAuthTokenSnapshot): AuthContext {
  return {
    authorization: `Bearer ${snapshot.token}`,
    authIdentity: hashToken(snapshot.token),
    ...(snapshot.expiresAt !== undefined ? { expiresAt: snapshot.expiresAt } : {}),
  };
}

function isExpiringSoon(ctx: AuthContext, nowMs: number, bufferMs: number): boolean {
  if (ctx.expiresAt === undefined) return false;
  return ctx.expiresAt - nowMs <= bufferMs;
}

// ── GitHub App ──────────────────────────────────────────────────────────────

function createAppAuth(auth: Extract<GithubAuth, { kind: "app" }>, options: AuthManagerOptions): AuthManager {
  const clock = options.clock ?? createSystemClock();
  const expiryBuffer = options.expiryBufferMs ?? DEFAULT_EXPIRY_BUFFER_MS;
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const fetchImpl = options.fetch ?? fetch;

  let cached: AuthContext | undefined;
  let inflightRefresh: Promise<AuthContext> | undefined;

  async function exchangeJwtForInstallationToken(): Promise<AuthContext> {
    const nowSec = Math.floor(clock.now().wallMs / 1000);
    const jwt = signAppJwt({
      appId: auth.appId,
      privateKey: auth.privateKey,
      issuedAtSec: nowSec - 30, // backdate 30s for clock skew
      expiresAtSec: nowSec + 540, // 9 minutes; GH max is 10
    });

    const url = `${apiBaseUrl}/app/installations/${auth.installationId}/access_tokens`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      const body = await readErrorBody(res);
      throw new Error(`GitHub App installation token exchange failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof json.token !== "string") {
      throw new Error("GitHub App installation token response missing token field");
    }
    const expiresAt = typeof json.expires_at === "string" ? Date.parse(json.expires_at) : undefined;

    return {
      authorization: `Bearer ${json.token}`,
      authIdentity: hashToken(json.token),
      ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    };
  }

  async function current(): Promise<AuthContext> {
    if (cached !== undefined && !isExpiringSoon(cached, clock.now().wallMs, expiryBuffer)) {
      return cached;
    }
    return refresh();
  }

  async function refresh(): Promise<AuthContext> {
    if (inflightRefresh !== undefined) return inflightRefresh;
    inflightRefresh = (async () => {
      try {
        cached = await exchangeJwtForInstallationToken();
        return cached;
      } finally {
        inflightRefresh = undefined;
      }
    })();
    return inflightRefresh;
  }

  return { current, refresh };
}

// ── JWT signing (RS256, GitHub App spec) ────────────────────────────────────

interface JwtClaims {
  readonly appId: string;
  readonly privateKey: string;
  readonly issuedAtSec: number;
  readonly expiresAtSec: number;
}

function signAppJwt(claims: JwtClaims): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: claims.issuedAtSec, exp: claims.expiresAtSec, iss: claims.appId };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(claims.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ── Token identity hashing ──────────────────────────────────────────────────

/**
 * Stable identifier for a token. Used as a cache-key component so
 * cached responses and rate-limit budgets don't leak across tokens
 * when the same config is reused. Truncated SHA-256 — full hash is
 * unnecessary for collision resistance at this layer.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

// ── Internals ───────────────────────────────────────────────────────────────

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

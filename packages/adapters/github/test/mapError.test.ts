import { describe, expect, it } from "vitest";

import { mapGithubError } from "../src/mapError.js";
import { GithubHttpError } from "../src/types.js";

function makeError(args: {
  status: number;
  category: GithubHttpError["githubCategory"];
  headers?: Record<string, string>;
  body?: unknown;
}): GithubHttpError {
  return new GithubHttpError({
    status: args.status,
    headers: args.headers ?? {},
    body: args.body,
    url: "https://api.github.com/test",
    method: "GET",
    githubCategory: args.category,
  });
}

describe("mapGithubError — category translation", () => {
  it("maps unauthorized → UNAUTHORIZED", () => {
    const result = mapGithubError(makeError({ status: 401, category: "unauthorized" }));
    expect(result.type).toBe("UNAUTHORIZED");
  });

  it("maps forbidden → FORBIDDEN", () => {
    const result = mapGithubError(makeError({ status: 403, category: "forbidden" }));
    expect(result.type).toBe("FORBIDDEN");
  });

  it("maps not-found → NOT_FOUND", () => {
    const result = mapGithubError(makeError({ status: 404, category: "not-found" }));
    expect(result.type).toBe("NOT_FOUND");
  });

  it("maps validation → VALIDATION", () => {
    const result = mapGithubError(makeError({ status: 422, category: "validation" }));
    expect(result.type).toBe("VALIDATION");
  });

  it("maps server-error → PROVIDER_ERROR", () => {
    const result = mapGithubError(makeError({ status: 500, category: "server-error" }));
    expect(result.type).toBe("PROVIDER_ERROR");
  });

  it("maps timeout → TIMEOUT", () => {
    const result = mapGithubError(makeError({ status: 408, category: "timeout" }));
    expect(result.type).toBe("TIMEOUT");
  });

  it("maps graphql-errors → VALIDATION", () => {
    const result = mapGithubError(makeError({ status: 200, category: "graphql-errors" }));
    expect(result.type).toBe("VALIDATION");
  });
});

describe("mapGithubError — rate-limit handling", () => {
  it("maps primary-rate-limit with X-RateLimit-Reset → RATE_LIMITED with retryAfterMs", () => {
    const futureSec = Math.floor(Date.now() / 1000) + 30;
    const result = mapGithubError(
      makeError({
        status: 403,
        category: "primary-rate-limit",
        headers: { "x-ratelimit-reset": String(futureSec) },
      }),
    );
    expect(result.type).toBe("RATE_LIMITED");
    if (result.type === "RATE_LIMITED") {
      // Should be ~30s in milliseconds
      expect(result.retryAfterMs).toBeGreaterThan(25_000);
      expect(result.retryAfterMs).toBeLessThan(35_000);
    }
  });

  it("maps primary-rate-limit with reset in the past → 0 retryAfterMs", () => {
    const pastSec = Math.floor(Date.now() / 1000) - 30;
    const result = mapGithubError(
      makeError({
        status: 403,
        category: "primary-rate-limit",
        headers: { "x-ratelimit-reset": String(pastSec) },
      }),
    );
    expect(result.type).toBe("RATE_LIMITED");
    if (result.type === "RATE_LIMITED") {
      expect(result.retryAfterMs).toBe(0);
    }
  });

  it("maps secondary-rate-limit → RATE_LIMITED honoring Retry-After header", () => {
    const result = mapGithubError(
      makeError({
        status: 403,
        category: "secondary-rate-limit",
        headers: { "retry-after": "60" },
      }),
    );
    expect(result.type).toBe("RATE_LIMITED");
    if (result.type === "RATE_LIMITED") {
      expect(result.retryAfterMs).toBe(60_000);
    }
  });

  it("maps abuse-detection → RATE_LIMITED", () => {
    const result = mapGithubError(makeError({ status: 403, category: "abuse-detection" }));
    expect(result.type).toBe("RATE_LIMITED");
  });

  it("maps secondary-rate-limit without Retry-After → RATE_LIMITED with no retryAfterMs", () => {
    const result = mapGithubError(makeError({ status: 403, category: "secondary-rate-limit" }));
    expect(result.type).toBe("RATE_LIMITED");
    if (result.type === "RATE_LIMITED") {
      expect(result.retryAfterMs).toBeUndefined();
    }
  });
});

describe("mapGithubError — non-HTTP errors", () => {
  it("falls through to mapFetchError for fetch-shaped errors", () => {
    const fetchErr = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });
    const result = mapGithubError(fetchErr);
    expect(result.type).toBe("CONNECTION_ERROR");
  });

  it("maps AbortError → TIMEOUT", () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const result = mapGithubError(abortErr);
    expect(result.type).toBe("TIMEOUT");
  });
});

describe("mapGithubError — unknown category falls back to status mapping", () => {
  it("unknown 418 → VALIDATION (4xx fallback)", () => {
    const result = mapGithubError(makeError({ status: 418, category: "unknown" }));
    expect(result.type).toBe("VALIDATION");
  });

  it("unknown 503 → PROVIDER_ERROR (5xx fallback)", () => {
    const result = mapGithubError(makeError({ status: 503, category: "unknown" }));
    expect(result.type).toBe("PROVIDER_ERROR");
  });
});

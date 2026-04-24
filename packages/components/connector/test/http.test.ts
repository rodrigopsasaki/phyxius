import { describe, expect, it } from "vitest";

import { mapFetchError, mapHttpStatus, parseRetryAfter } from "../src/index.js";

// These tests pin the SQLSTATE-equivalent for HTTP: the status-code table
// and the errno table. They're the real product of the http helpers —
// break one of these and every connector built on top silently shifts
// its retry behavior.

describe("mapHttpStatus", () => {
  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [408, "TIMEOUT"],
    [422, "VALIDATION"],
  ])("maps %i → %s", (status, expected) => {
    const mapped = mapHttpStatus(status, "cause");
    expect(mapped.type).toBe(expected);
  });

  it("maps 429 without Retry-After → RATE_LIMITED (no retryAfterMs)", () => {
    const mapped = mapHttpStatus(429, "throttled");
    expect(mapped.type).toBe("RATE_LIMITED");
    if (mapped.type === "RATE_LIMITED") {
      expect(mapped.retryAfterMs).toBeUndefined();
      expect(mapped.cause).toBe("throttled");
    }
  });

  it("maps 429 with Retry-After → RATE_LIMITED with retryAfterMs", () => {
    const mapped = mapHttpStatus(429, "throttled", { retryAfterMs: 5000 });
    expect(mapped.type).toBe("RATE_LIMITED");
    if (mapped.type === "RATE_LIMITED") {
      expect(mapped.retryAfterMs).toBe(5000);
    }
  });

  it.each([500, 502, 503, 504, 599])("maps %i → PROVIDER_ERROR (5xx)", (status) => {
    expect(mapHttpStatus(status, "upstream").type).toBe("PROVIDER_ERROR");
  });

  it.each([400, 402, 405, 409, 410, 418])("maps %i → VALIDATION (4xx catch-all)", (status) => {
    expect(mapHttpStatus(status, "bad").type).toBe("VALIDATION");
  });

  it("maps 408 → TIMEOUT with timeoutMs: 0", () => {
    const mapped = mapHttpStatus(408, "req timeout");
    expect(mapped.type).toBe("TIMEOUT");
    if (mapped.type === "TIMEOUT") {
      expect(mapped.timeoutMs).toBe(0);
    }
  });

  it("maps 2xx / 3xx / 1xx as PROVIDER_ERROR fallback (defensive)", () => {
    expect(mapHttpStatus(200, null).type).toBe("PROVIDER_ERROR");
    expect(mapHttpStatus(302, null).type).toBe("PROVIDER_ERROR");
    expect(mapHttpStatus(100, null).type).toBe("PROVIDER_ERROR");
  });
});

describe("mapFetchError", () => {
  it("maps an AbortError (by name) → TIMEOUT", () => {
    const cause = Object.assign(new Error("aborted"), { name: "AbortError" });
    const mapped = mapFetchError(cause);
    expect(mapped.type).toBe("TIMEOUT");
  });

  it.each(["ABORT_ERR", "UND_ERR_ABORTED", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])(
    "maps %s errno → TIMEOUT",
    (code) => {
      const cause = { code };
      expect(mapFetchError(cause).type).toBe("TIMEOUT");
    },
  );

  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ])("maps %s errno → CONNECTION_ERROR", (code) => {
    const cause = { code };
    expect(mapFetchError(cause).type).toBe("CONNECTION_ERROR");
  });

  it("finds the errno on cause.cause.code (node:fetch wraps)", () => {
    // node:fetch throws TypeError("fetch failed") with the real errno
    // on .cause — we have to look one level deep.
    const cause = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    expect(mapFetchError(cause).type).toBe("CONNECTION_ERROR");
  });

  it("maps unknown errors → PROVIDER_ERROR", () => {
    expect(mapFetchError(new Error("something weird")).type).toBe("PROVIDER_ERROR");
    expect(mapFetchError({}).type).toBe("PROVIDER_ERROR");
    expect(mapFetchError(null).type).toBe("PROVIDER_ERROR");
    expect(mapFetchError("string").type).toBe("PROVIDER_ERROR");
  });

  it("preserves the original cause on the mapped error", () => {
    const original = new Error("boom");
    const mapped = mapFetchError(original);
    if (mapped.type === "PROVIDER_ERROR") {
      expect(mapped.cause).toBe(original);
    }
  });
});

describe("parseRetryAfter", () => {
  it("returns undefined for null / undefined / empty / whitespace", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
  });

  it("parses integer seconds as milliseconds", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("1")).toBe(1000);
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("rejects non-integer numeric-looking strings as invalid", () => {
    // The RFC allows only non-negative decimal integers; "12 abc" must
    // not sneakily parse as 12. parseRetryAfter would then attempt date
    // parsing, which also fails → undefined.
    expect(parseRetryAfter("12 abc")).toBeUndefined();
    expect(parseRetryAfter("12.5")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
  });

  it("parses HTTP-date form relative to an injected now", () => {
    const now = () => new Date("2025-10-21T07:00:00Z").getTime();
    const future = "Tue, 21 Oct 2025 07:28:00 GMT";

    // 28 minutes in the future = 1,680,000 ms.
    expect(parseRetryAfter(future, now)).toBe(28 * 60 * 1000);
  });

  it("clamps past HTTP-dates to zero", () => {
    const now = () => new Date("2025-10-21T07:30:00Z").getTime();
    const past = "Tue, 21 Oct 2025 07:28:00 GMT";
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it("returns undefined for garbage input", () => {
    expect(parseRetryAfter("definitely not a date")).toBeUndefined();
    expect(parseRetryAfter("next tuesday")).toBeUndefined();
  });
});

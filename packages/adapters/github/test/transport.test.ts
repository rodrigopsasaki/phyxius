/**
 * Transport integration tests. These exercise the whole stack —
 * auth → headers → fetch → rate-limit observation → ETag handling
 * → error categorization — against a stubbed fetch. No real
 * network calls; the failures these tests catch are coordination
 * defects, not GitHub-API surface drift.
 */

import { describe, expect, it } from "vitest";

import { createTransport } from "../src/transport.js";
import { GithubHttpError } from "../src/types.js";

interface FakeCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function makeFakeFetch(
  responses: ReadonlyArray<{
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }>,
): {
  readonly fn: typeof fetch;
  readonly calls: ReadonlyArray<FakeCall>;
} {
  const calls: FakeCall[] = [];
  let idx = 0;
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headersIn = init?.headers ?? {};
    const headers: Record<string, string> = {};
    if (headersIn instanceof Headers) {
      headersIn.forEach((v, k) => (headers[k.toLowerCase()] = v));
    } else if (Array.isArray(headersIn)) {
      for (const pair of headersIn) {
        const k = pair[0];
        const v = pair[1];
        if (typeof k === "string" && typeof v === "string") headers[k.toLowerCase()] = v;
      }
    } else {
      for (const [k, v] of Object.entries(headersIn)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
    }
    const bodyArg = init?.body;
    const body = typeof bodyArg === "string" ? bodyArg : undefined;
    calls.push(body !== undefined ? { url, method, headers, body } : { url, method, headers });
    const next = responses[idx];
    idx += 1;
    if (next === undefined) throw new Error(`fake fetch: no response queued for call ${idx}`);
    // 204 / 304 must have a null body per the fetch spec; the Response
    // constructor rejects non-null bodies for those statuses.
    const isNullBodyStatus = next.status === 204 || next.status === 304;
    const respBody = isNullBodyStatus
      ? null
      : next.body === undefined
        ? ""
        : typeof next.body === "string"
          ? next.body
          : JSON.stringify(next.body);
    return new Response(respBody, {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
  return { fn, calls };
}

describe("transport — happy path", () => {
  it("issues a request with all required GitHub headers and parses JSON", async () => {
    const { fn, calls } = makeFakeFetch([
      {
        status: 200,
        body: { id: 7, name: "ok" },
        headers: {
          "content-type": "application/json",
          etag: '"abc"',
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          "x-ratelimit-used": "1",
        },
      },
    ]);
    const transport = createTransport({
      config: {
        auth: { kind: "pat", token: "ghp_test" },
        fetch: fn,
        userAgent: "test-agent/1.0",
        apiVersion: "2022-11-28",
      },
    });
    const result = await transport.request<{ id: number; name: string }>({ method: "GET", path: "/x" }, undefined);
    expect(result.status).toBe(200);
    expect(result.fromCache).toBe(false);
    expect(result.data).toEqual({ id: 7, name: "ok" });

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.github.com/x");
    expect(call?.headers["accept"]).toBe("application/vnd.github+json");
    expect(call?.headers["authorization"]).toBe("Bearer ghp_test");
    expect(call?.headers["user-agent"]).toBe("test-agent/1.0");
    expect(call?.headers["x-github-api-version"]).toBe("2022-11-28");

    // Rate-limit budget was observed.
    const budget = transport.rateLimits.budget("core");
    expect(budget?.limit).toBe(5000);
    expect(budget?.remaining).toBe(4999);
  });

  it("encodes query parameters", async () => {
    const { fn, calls } = makeFakeFetch([{ status: 200, body: [] }]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });
    await transport.request({ method: "GET", path: "/x", query: { state: "open", per_page: 50 } }, undefined);
    expect(calls[0]?.url).toBe("https://api.github.com/x?state=open&per_page=50");
  });

  it("serializes JSON body and sets Content-Type", async () => {
    const { fn, calls } = makeFakeFetch([{ status: 201, body: { id: 1 } }]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });
    await transport.request({ method: "POST", path: "/y", body: { hello: "world" }, cacheable: false }, undefined);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toBe('{"hello":"world"}');
  });

  it("uses 'diff' Accept header when acceptType is diff and returns text", async () => {
    const { fn, calls } = makeFakeFetch([{ status: 200, body: "diff --git a/x b/x\n" }]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });
    const result = await transport.request<string>(
      { method: "GET", path: "/diff-thing", acceptType: "diff" },
      undefined,
    );
    expect(calls[0]?.headers["accept"]).toBe("application/vnd.github.v3.diff");
    expect(result.data).toBe("diff --git a/x b/x\n");
  });
});

describe("transport — ETag conditional requests", () => {
  it("caches a response with ETag and returns cached body on 304", async () => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const { fn, calls } = makeFakeFetch([
      {
        status: 200,
        body: { v: 1 },
        headers: {
          etag: '"v1-etag"',
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(futureSec),
        },
      },
      {
        status: 304,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": String(futureSec),
        },
      },
    ]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });

    const first = await transport.request<{ v: number }>({ method: "GET", path: "/x" }, undefined);
    expect(first.status).toBe(200);
    expect(first.fromCache).toBe(false);
    expect(first.data).toEqual({ v: 1 });

    const second = await transport.request<{ v: number }>({ method: "GET", path: "/x" }, undefined);
    expect(second.status).toBe(304);
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual({ v: 1 });

    // Second request sent If-None-Match
    expect(calls[1]?.headers["if-none-match"]).toBe('"v1-etag"');
  });
});

describe("transport — error categorization", () => {
  it("throws GithubHttpError(unauthorized) on 401 (after refresh attempt)", async () => {
    const { fn } = makeFakeFetch([
      // Two 401s; PAT refresh is a no-op so we end up surfacing the second.
      { status: 401, body: { message: "Bad credentials" } },
      { status: 401, body: { message: "Bad credentials" } },
    ]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "bad" }, fetch: fn } });
    await expect(transport.request({ method: "GET", path: "/x" }, undefined)).rejects.toMatchObject({
      githubCategory: "unauthorized",
      status: 401,
    });
  });

  it("detects primary-rate-limit on 403 with X-RateLimit-Remaining: 0", async () => {
    const { fn } = makeFakeFetch([
      {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) },
      },
    ]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });
    await expect(transport.request({ method: "GET", path: "/x" }, undefined)).rejects.toMatchObject({
      githubCategory: "primary-rate-limit",
      status: 403,
    });
  });

  it("detects abuse-detection on 403 with abuse message", async () => {
    const { fn } = makeFakeFetch([
      {
        status: 403,
        body: { message: "You have triggered an abuse detection mechanism" },
        headers: { "x-ratelimit-remaining": "100" },
      },
    ]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });
    await expect(transport.request({ method: "GET", path: "/x" }, undefined)).rejects.toMatchObject({
      githubCategory: "abuse-detection",
    });
  });

  it("detects secondary-rate-limit on 403 with secondary message", async () => {
    const { fn } = makeFakeFetch([
      {
        status: 403,
        body: { message: "You have exceeded a secondary rate limit." },
        headers: { "x-ratelimit-remaining": "100", "retry-after": "60" },
      },
    ]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });
    await expect(transport.request({ method: "GET", path: "/x" }, undefined)).rejects.toMatchObject({
      githubCategory: "secondary-rate-limit",
    });
  });

  it("falls through to forbidden on 403 with no rate-limit signal", async () => {
    const { fn } = makeFakeFetch([
      { status: 403, body: { message: "Resource not accessible by integration" }, headers: {} },
    ]);
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });
    await expect(transport.request({ method: "GET", path: "/x" }, undefined)).rejects.toMatchObject({
      githubCategory: "forbidden",
    });
  });

  it("detects graphql-errors on 200 with errors-in-body", async () => {
    const { fn } = makeFakeFetch([
      {
        status: 200,
        body: { data: null, errors: [{ message: "Field 'x' doesn't exist on type 'Repository'" }] },
      },
    ]);
    const transport = createTransport({
      config: { auth: { kind: "pat", token: "t" }, fetch: fn },
    });
    await expect(
      transport.request(
        {
          method: "POST",
          path: "",
          baseUrl: "https://api.github.com/graphql",
          body: { query: "{}" },
          cacheable: false,
        },
        undefined,
      ),
    ).rejects.toBeInstanceOf(GithubHttpError);
  });
});

describe("transport — signal propagation", () => {
  it("passes the signal to fetch", async () => {
    const seen: AbortSignal[] = [];
    const fn: typeof fetch = async (_url, init) => {
      if (init?.signal !== undefined && init.signal !== null) seen.push(init.signal);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const transport = createTransport({ config: { auth: { kind: "pat", token: "t" }, fetch: fn } });
    const ctrl = new AbortController();
    await transport.request({ method: "GET", path: "/x" }, ctrl.signal);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(ctrl.signal);
  });
});

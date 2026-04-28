# `@phyxiusjs/github`

GitHub connector for phyxius — REST + GraphQL + webhooks, built on the `@phyxiusjs/connector` primitive with full stability surface, ETag conditional requests, rate-limit accounting, and the typed `ConnectorError` vocabulary.

## What this is

A GitHub connector that fits cleanly into phyxius's substrate. Every operation is a `HandlerSpec` you spawn against your runtime; every error speaks the same `ConnectorError` union as Stripe, Slack, OpenAI, or any other phyxius connector, so retry / circuit-breaker / dashboard policies don't need provider-specific branches.

Designed once and finished. No v0/v1 split — the architecture covers the surface you'd realistically need:

- **All three auth modes:** Personal Access Token, GitHub App (with JWT signing → installation token rotation), and OAuth (with pluggable token-storage refresh).
- **ETag conditional requests on by default for reads.** Cuts rate-limit burn dramatically; default LRU cache of 1024 entries scoped to the config.
- **Per-resource rate-limit accounting.** `core` / `search` / `graphql` / `code_search` / `integration_manifest` / `code_scanning_upload`, observed authoritatively from the `X-RateLimit-Resource` header.
- **GitHub-specific error categorization.** 403-as-rate-limit (when `X-RateLimit-Remaining: 0`), 403-as-abuse-detection, 403-as-secondary-rate-limit, and 200-with-GraphQL-errors are all detected and surfaced as the right `ConnectorError` variant — not lumped into a generic `FORBIDDEN`.
- **Webhook receiver with HMAC-SHA256 verification + replay protection.** Signature is verified before JSON parsing. Replay store rejects duplicate `X-GitHub-Delivery` IDs within a configurable window.
- **Bounded pagination utilities.** `paginate` (Link header) and `paginateGraphQL` (cursor) — explicitly bounded by default per `sd-no-unboundedness`.

## Architecture

```
GithubConfig                 (auth + cache + rate-limits + clock + fetch)
   │
   ▼
createTransport(config)      → Transport (one per account)
   │
   ▼
operation(transport)         → HandlerSpec
   │
   ▼
spawn(spec, runtime)         → RunningHandler<TInput, TOutput>
```

One transport per account. Operations share auth, ETag cache, and rate-limit budget through the transport. Each operation is its own handler with its own stability surface (timeout, concurrency, retry, circuit breaker).

## Quick start

```ts
import { createSystemClock, ms } from "@phyxiusjs/clock";
import { Journal } from "@phyxiusjs/journal";
import { spawn, type HandlerEvent } from "@phyxiusjs/handler";
import {
  createTransport,
  getPullRequest,
  listPullRequestFiles,
  getPullRequestDiff,
  createPullRequestReview,
  listChecksForRef,
  getCombinedStatusForRef,
} from "@phyxiusjs/github";

const clock = createSystemClock();
const journal = new Journal<HandlerEvent>({ clock, maxEntries: 10_000 });

const transport = createTransport({
  config: {
    auth: { kind: "pat", token: process.env.GITHUB_TOKEN! },
  },
});

const getPR = await spawn(getPullRequest(transport), { clock, journal });
const listFiles = await spawn(listPullRequestFiles(transport), { clock, journal });
const getDiff = await spawn(getPullRequestDiff(transport), { clock, journal });
const review = await spawn(createPullRequestReview(transport), { clock, journal });
const listChecks = await spawn(listChecksForRef(transport), { clock, journal });
const combinedStatus = await spawn(getCombinedStatusForRef(transport), { clock, journal });

const pr = await getPR({ owner: "rodrigopsasaki", repo: "mycelium", pull_number: 42 });
const files = await listFiles({ owner: "rodrigopsasaki", repo: "mycelium", pull_number: 42 });
const diff = await getDiff({ owner: "rodrigopsasaki", repo: "mycelium", pull_number: 42 });

// Check CI is healthy before posting a review.
const checks = await listChecks({
  owner: "rodrigopsasaki",
  repo: "mycelium",
  ref: pr.head.sha,
});

// Post a review with inline comments atomically.
await review({
  owner: "rodrigopsasaki",
  repo: "mycelium",
  pull_number: 42,
  event: "COMMENT",
  body: "Two structural concerns inline.",
  comments: [
    { path: "src/foo.ts", line: 42, side: "RIGHT", body: "Unbounded loop here." },
    { path: "src/bar.ts", line: 17, side: "RIGHT", body: "Doubled retry surface." },
  ],
});
```

## Auth modes

```ts
// Personal Access Token — simplest, single-user.
{ auth: { kind: "pat", token: process.env.GITHUB_TOKEN! } }

// GitHub App — production. Connector signs RS256 JWT, exchanges for
// installation token, rotates automatically before the 1-hour expiry.
{ auth: {
    kind: "app",
    appId: "12345",
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
    installationId: 67890,
  },
}

// OAuth — user-bound. Connector calls tokenStorage.refresh() on 401
// and retries once before surfacing UNAUTHORIZED.
{ auth: {
    kind: "oauth",
    token: currentAccessToken,
    refreshToken: currentRefreshToken,
    tokenStorage: {
      load: async () => ({ token: ..., refreshToken: ..., expiresAt: ... }),
      save: async (snapshot) => { /* persist */ },
      refresh: async (refreshToken) => ({ token: ..., expiresAt: ... }),
    },
  },
}
```

## Webhooks

```ts
import { verifyWebhook, createInMemoryReplayStore } from "@phyxiusjs/github";

const replayStore = createInMemoryReplayStore({ windowMs: 5 * 60 * 1000 });

// In your webhook route handler:
const event = verifyWebhook<{ action: string; pull_request: { number: number } }>(
  {
    body: rawRequestBody, // bytes-on-the-wire — re-serialized JSON breaks the signature
    headers: req.headers,
    secret: process.env.GITHUB_WEBHOOK_SECRET!,
  },
  { replayStore },
);

// `event.event` is the type from X-GitHub-Event (e.g., "pull_request").
// `event.deliveryId` is X-GitHub-Delivery (UUID).
// `event.payload` is the parsed JSON body, typed as the generic.
```

## Pagination

```ts
import { paginate, parseLinkHeader } from "@phyxiusjs/github";

// Bounded by default (10 pages × 1000 items). Override when you've
// thought about the total cost.
const { items, hasMore } = await paginate<Issue>(
  initialUrl,
  async (url) => {
    const response = await transport.request<Issue[]>({ method: "GET", path: url }, signal);
    return { items: response.data, linkHeader: response.headers.get("link") };
  },
  { maxPages: 5, maxItems: 200 },
);
```

## Rate-limit awareness

```ts
const budget = transport.rateLimits.budget("core");
// { resource, limit, remaining, resetMs, used, observedAt } | undefined

if (transport.rateLimits.isExhausted("search", Date.now())) {
  // Back off voluntarily before issuing a search.
}
```

## ETag cache

The transport adds `If-None-Match` automatically on cacheable reads (GETs by default). On a 304 response, the cached body is returned with `fromCache: true`. The cache is keyed on `<method> <url> <auth-identity>` so cached data never leaks across tokens.

```ts
// Custom cache (e.g., Redis-backed) — implement EtagCache and pass on config.
import { createEtagCache } from "@phyxiusjs/github";

const cache = createEtagCache({ maxEntries: 4096 });
const transport = createTransport({ config: { auth, etagCache: cache } });
```

## Error handling

Every operation throws `ConnectorFailure` (typed by the `@phyxiusjs/connector` primitive) on failure. The `error` field holds a typed `ConnectorError` variant; the handler's retry policy can pattern-match on the variant to make policy decisions.

```ts
import { isConnectorFailure } from "@phyxiusjs/github";

try {
  await getPR(input);
} catch (err) {
  if (isConnectorFailure(err)) {
    switch (err.error.type) {
      case "RATE_LIMITED":
        // Honor err.error.retryAfterMs — the connector already extracted it
        break;
      case "UNAUTHORIZED":
      case "FORBIDDEN":
      case "NOT_FOUND":
      case "VALIDATION":
        // Surface to caller — never retry
        break;
      case "TIMEOUT":
      case "CONNECTION_ERROR":
      case "PROVIDER_ERROR":
        // Default retry policy already handles these; you only see them
        // if retries were exhausted
        break;
    }
  }
}
```

## Operations available

| Cluster       | Operations                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pulls.*`     | get, list, listFiles, getDiff, listReviewComments, createReview, createIssueComment, create, update, merge, requestReviewers                                    |
| `repos.*`     | get, listBranches, getBranch, listCommits, getCommit, getCommitDiff, compareCommits, getContents, getReadme, getTree, createOrUpdateFile, deleteFile, createRef |
| `issues.*`    | list, get, create, update, listComments, addLabels, removeLabel                                                                                                 |
| `search.*`    | code, issuesAndPullRequests, repositories, users                                                                                                                |
| `checks.*`    | listForRef, get, getCombinedStatusForRef, create, update                                                                                                        |
| `reactions.*` | createForIssueComment, createForPullRequestReviewComment, createForIssue                                                                                        |
| `graphql`     | Generic typed-data GraphQL query                                                                                                                                |

Adding a new operation follows the established pattern in `src/operations/*` — wrap a `defineGithubOperation` call with input/output validators, observe fields, and a transport call.

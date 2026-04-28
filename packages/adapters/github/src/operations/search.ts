/**
 * Search operations.
 *
 * GitHub's search API has its own rate-limit budgets, separate from
 * the core REST budget:
 *   - /search/code     → resource: "code_search" (30 req/min auth)
 *   - everything else  → resource: "search"      (30 req/min auth)
 *
 * The transport layer reads `X-RateLimit-Resource` to confirm the
 * actual budget charged, but operations specify their expected
 * resource for pre-call exhaustion checks.
 *
 * Search APIs are rate-limited harder than other endpoints, so
 * callers should expect occasional RATE_LIMITED returns even with
 * modest concurrency. The default retry policy honors retry-after
 * automatically.
 */

import { observe } from "@phyxiusjs/observe";
import { fromSafeParse, passthrough } from "@phyxiusjs/validate";
import type { Endpoints } from "@octokit/types";
import { z } from "zod";

import { defineGithubOperation } from "../define-operation.js";
import type { Transport } from "../transport.js";

// ── Common search input shape ───────────────────────────────────────────────

const searchSortDirection = z.enum(["asc", "desc"]).optional();

const baseSearchSchema = z.object({
  q: z.string().min(1),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
  order: searchSortDirection,
});

// ── search.code ─────────────────────────────────────────────────────────────

const searchCodeInputSchema = baseSearchSchema.extend({
  sort: z.enum(["indexed"]).optional(),
});

export type SearchCodeInput = z.infer<typeof searchCodeInputSchema>;
export type SearchCodeOutput = Endpoints["GET /search/code"]["response"]["data"];

const searchCodeFields = observe.fields({
  query: observe.field<string>(),
  totalCount: observe.number(),
  incompleteResults: observe.field<boolean>(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function searchCode(transport: Transport) {
  return defineGithubOperation({
    name: "github.search.code",
    transport,
    input: fromSafeParse(searchCodeInputSchema),
    output: passthrough<SearchCodeOutput>(),
    fields: searchCodeFields,
    run: async (input, tools, t) => {
      searchCodeFields.query.set(input.q);
      const response = await t.request<SearchCodeOutput>(
        {
          method: "GET",
          path: `/search/code`,
          query: input,
          resource: "code_search",
        },
        tools.signal,
      );
      searchCodeFields.totalCount.set(response.data.total_count);
      searchCodeFields.incompleteResults.set(response.data.incomplete_results);
      searchCodeFields.status.set(response.status);
      searchCodeFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── search.issuesAndPullRequests ────────────────────────────────────────────

const searchIssuesInputSchema = baseSearchSchema.extend({
  sort: z
    .enum([
      "comments",
      "reactions",
      "reactions-+1",
      "reactions--1",
      "reactions-smile",
      "reactions-thinking_face",
      "reactions-heart",
      "reactions-tada",
      "interactions",
      "created",
      "updated",
    ])
    .optional(),
});

export type SearchIssuesInput = z.infer<typeof searchIssuesInputSchema>;
export type SearchIssuesOutput = Endpoints["GET /search/issues"]["response"]["data"];

const searchIssuesFields = observe.fields({
  query: observe.field<string>(),
  totalCount: observe.number(),
  incompleteResults: observe.field<boolean>(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function searchIssuesAndPullRequests(transport: Transport) {
  return defineGithubOperation({
    name: "github.search.issuesAndPullRequests",
    transport,
    input: fromSafeParse(searchIssuesInputSchema),
    output: passthrough<SearchIssuesOutput>(),
    fields: searchIssuesFields,
    run: async (input, tools, t) => {
      searchIssuesFields.query.set(input.q);
      const response = await t.request<SearchIssuesOutput>(
        {
          method: "GET",
          path: `/search/issues`,
          query: input,
          resource: "search",
        },
        tools.signal,
      );
      searchIssuesFields.totalCount.set(response.data.total_count);
      searchIssuesFields.incompleteResults.set(response.data.incomplete_results);
      searchIssuesFields.status.set(response.status);
      searchIssuesFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── search.repositories ─────────────────────────────────────────────────────

const searchReposInputSchema = baseSearchSchema.extend({
  sort: z.enum(["stars", "forks", "help-wanted-issues", "updated"]).optional(),
});

export type SearchReposInput = z.infer<typeof searchReposInputSchema>;
export type SearchReposOutput = Endpoints["GET /search/repositories"]["response"]["data"];

const searchReposFields = observe.fields({
  query: observe.field<string>(),
  totalCount: observe.number(),
  incompleteResults: observe.field<boolean>(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function searchRepositories(transport: Transport) {
  return defineGithubOperation({
    name: "github.search.repositories",
    transport,
    input: fromSafeParse(searchReposInputSchema),
    output: passthrough<SearchReposOutput>(),
    fields: searchReposFields,
    run: async (input, tools, t) => {
      searchReposFields.query.set(input.q);
      const response = await t.request<SearchReposOutput>(
        {
          method: "GET",
          path: `/search/repositories`,
          query: input,
          resource: "search",
        },
        tools.signal,
      );
      searchReposFields.totalCount.set(response.data.total_count);
      searchReposFields.incompleteResults.set(response.data.incomplete_results);
      searchReposFields.status.set(response.status);
      searchReposFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── search.users ────────────────────────────────────────────────────────────

const searchUsersInputSchema = baseSearchSchema.extend({
  sort: z.enum(["followers", "repositories", "joined"]).optional(),
});

export type SearchUsersInput = z.infer<typeof searchUsersInputSchema>;
export type SearchUsersOutput = Endpoints["GET /search/users"]["response"]["data"];

const searchUsersFields = observe.fields({
  query: observe.field<string>(),
  totalCount: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function searchUsers(transport: Transport) {
  return defineGithubOperation({
    name: "github.search.users",
    transport,
    input: fromSafeParse(searchUsersInputSchema),
    output: passthrough<SearchUsersOutput>(),
    fields: searchUsersFields,
    run: async (input, tools, t) => {
      searchUsersFields.query.set(input.q);
      const response = await t.request<SearchUsersOutput>(
        {
          method: "GET",
          path: `/search/users`,
          query: input,
          resource: "search",
        },
        tools.signal,
      );
      searchUsersFields.totalCount.set(response.data.total_count);
      searchUsersFields.status.set(response.status);
      searchUsersFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

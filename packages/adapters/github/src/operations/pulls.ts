/**
 * Pull request operations.
 *
 * The cluster covers the complete PR lifecycle: list, get, list-files,
 * get-diff (raw unified format), list comments (review + issue), create
 * a review with inline line-comments atomically, post issue-style
 * comments, react, request reviewers, update, merge. Closing is an
 * update to state="closed".
 *
 * Naming follows GitHub's REST surface: `pulls.get`, `pulls.list`,
 * `pulls.listFiles`, etc. The handler `name` field uses dot-paths
 * (`github.pulls.get`) for journal traceability.
 */

import { observe } from "@phyxiusjs/observe";
import { fromSafeParse, passthrough } from "@phyxiusjs/validate";
import type { Endpoints } from "@octokit/types";
import { z } from "zod";

import { defineGithubOperation } from "../define-operation.js";
import type { Transport } from "../transport.js";

// ── pulls.get ───────────────────────────────────────────────────────────────

const getInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
});

export type GetPullRequestInput = z.infer<typeof getInputSchema>;
export type GetPullRequestOutput = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}"]["response"]["data"];

const getFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  pullNumber: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getPullRequest(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.get",
    transport,
    input: fromSafeParse(getInputSchema),
    output: passthrough<GetPullRequestOutput>(),
    fields: getFields,
    run: async (input, tools, t) => {
      getFields.owner.set(input.owner);
      getFields.repo.set(input.repo);
      getFields.pullNumber.set(input.pull_number);
      const response = await t.request<GetPullRequestOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}`,
          resource: "core",
        },
        tools.signal,
      );
      getFields.status.set(response.status);
      getFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── pulls.list ──────────────────────────────────────────────────────────────

const listInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  state: z.enum(["open", "closed", "all"]).optional(),
  head: z.string().optional(),
  base: z.string().optional(),
  sort: z.enum(["created", "updated", "popularity", "long-running"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

export type ListPullRequestsInput = z.infer<typeof listInputSchema>;
export type ListPullRequestsOutput = Endpoints["GET /repos/{owner}/{repo}/pulls"]["response"]["data"];

const listFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  state: observe.field<string>(),
  count: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function listPullRequests(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.list",
    transport,
    input: fromSafeParse(listInputSchema),
    output: passthrough<ListPullRequestsOutput>(),
    fields: listFields,
    run: async (input, tools, t) => {
      listFields.owner.set(input.owner);
      listFields.repo.set(input.repo);
      if (input.state !== undefined) listFields.state.set(input.state);
      const { owner, repo, ...query } = input;
      const response = await t.request<ListPullRequestsOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/pulls`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      listFields.count.set(response.data.length);
      listFields.status.set(response.status);
      listFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── pulls.listFiles ─────────────────────────────────────────────────────────

const listFilesInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

export type ListPullRequestFilesInput = z.infer<typeof listFilesInputSchema>;
export type ListPullRequestFilesOutput =
  Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/files"]["response"]["data"];

const listFilesFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  pullNumber: observe.number(),
  fileCount: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function listPullRequestFiles(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.listFiles",
    transport,
    input: fromSafeParse(listFilesInputSchema),
    output: passthrough<ListPullRequestFilesOutput>(),
    fields: listFilesFields,
    run: async (input, tools, t) => {
      listFilesFields.owner.set(input.owner);
      listFilesFields.repo.set(input.repo);
      listFilesFields.pullNumber.set(input.pull_number);
      const { owner, repo, pull_number, ...query } = input;
      const response = await t.request<ListPullRequestFilesOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/pulls/${pull_number}/files`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      listFilesFields.fileCount.set(response.data.length);
      listFilesFields.status.set(response.status);
      listFilesFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── pulls.getDiff (raw unified diff via Accept header) ──────────────────────

const getDiffInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
});

export type GetPullRequestDiffInput = z.infer<typeof getDiffInputSchema>;

const getDiffFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  pullNumber: observe.number(),
  diffBytes: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getPullRequestDiff(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.getDiff",
    transport,
    input: fromSafeParse(getDiffInputSchema),
    output: passthrough<string>(),
    fields: getDiffFields,
    run: async (input, tools, t) => {
      getDiffFields.owner.set(input.owner);
      getDiffFields.repo.set(input.repo);
      getDiffFields.pullNumber.set(input.pull_number);
      const response = await t.request<string>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}`,
          acceptType: "diff",
          resource: "core",
        },
        tools.signal,
      );
      getDiffFields.diffBytes.set(response.data.length);
      getDiffFields.status.set(response.status);
      getDiffFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── pulls.listReviewComments ────────────────────────────────────────────────

const listReviewCommentsInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
  sort: z.enum(["created", "updated"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  since: z.string().optional(),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

export type ListPullRequestReviewCommentsInput = z.infer<typeof listReviewCommentsInputSchema>;
export type ListPullRequestReviewCommentsOutput =
  Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"]["response"]["data"];

const listReviewCommentsFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  pullNumber: observe.number(),
  count: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function listPullRequestReviewComments(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.listReviewComments",
    transport,
    input: fromSafeParse(listReviewCommentsInputSchema),
    output: passthrough<ListPullRequestReviewCommentsOutput>(),
    fields: listReviewCommentsFields,
    run: async (input, tools, t) => {
      listReviewCommentsFields.owner.set(input.owner);
      listReviewCommentsFields.repo.set(input.repo);
      listReviewCommentsFields.pullNumber.set(input.pull_number);
      const { owner, repo, pull_number, ...query } = input;
      const response = await t.request<ListPullRequestReviewCommentsOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/pulls/${pull_number}/comments`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      listReviewCommentsFields.count.set(response.data.length);
      listReviewCommentsFields.status.set(response.status);
      listReviewCommentsFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── pulls.createReview (atomic submission of a review with inline comments) ─

const reviewCommentSchema = z.object({
  path: z.string().min(1),
  body: z.string().min(1),
  // Two coordinate styles: legacy `position` (diff line index) or
  // newer `line` + `side` + optional multi-line `start_line` /
  // `start_side`. Either is accepted.
  position: z.number().int().positive().optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  start_line: z.number().int().positive().optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
});

const createReviewInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
  /** SHA of the commit the review was based on. Required if comments reference specific lines. */
  commit_id: z.string().optional(),
  /** Top-level review body. Optional when `event` is APPROVE/REQUEST_CHANGES. */
  body: z.string().optional(),
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
  comments: z.array(reviewCommentSchema).optional(),
});

export type CreatePullRequestReviewInput = z.infer<typeof createReviewInputSchema>;
export type CreatePullRequestReviewOutput =
  Endpoints["POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews"]["response"]["data"];

const createReviewFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  pullNumber: observe.number(),
  event: observe.field<string>(),
  commentCount: observe.number(),
  reviewId: observe.number(),
  status: observe.number(),
});

export function createPullRequestReview(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.createReview",
    transport,
    input: fromSafeParse(createReviewInputSchema),
    output: passthrough<CreatePullRequestReviewOutput>(),
    fields: createReviewFields,
    run: async (input, tools, t) => {
      createReviewFields.owner.set(input.owner);
      createReviewFields.repo.set(input.repo);
      createReviewFields.pullNumber.set(input.pull_number);
      if (input.event !== undefined) createReviewFields.event.set(input.event);
      createReviewFields.commentCount.set(input.comments?.length ?? 0);
      const { owner, repo, pull_number, ...body } = input;
      const response = await t.request<CreatePullRequestReviewOutput>(
        {
          method: "POST",
          path: `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      createReviewFields.reviewId.set(response.data.id);
      createReviewFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── pulls.createIssueComment (general PR comment, not line-specific) ────────

const createIssueCommentInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** PR or issue number — they share the issue-comment API. */
  issue_number: z.number().int().positive(),
  body: z.string().min(1),
});

export type CreatePullRequestIssueCommentInput = z.infer<typeof createIssueCommentInputSchema>;
export type CreatePullRequestIssueCommentOutput =
  Endpoints["POST /repos/{owner}/{repo}/issues/{issue_number}/comments"]["response"]["data"];

const createIssueCommentFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  issueNumber: observe.number(),
  bodyChars: observe.number(),
  commentId: observe.number(),
  status: observe.number(),
});

export function createPullRequestIssueComment(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.createIssueComment",
    transport,
    input: fromSafeParse(createIssueCommentInputSchema),
    output: passthrough<CreatePullRequestIssueCommentOutput>(),
    fields: createIssueCommentFields,
    run: async (input, tools, t) => {
      createIssueCommentFields.owner.set(input.owner);
      createIssueCommentFields.repo.set(input.repo);
      createIssueCommentFields.issueNumber.set(input.issue_number);
      createIssueCommentFields.bodyChars.set(input.body.length);
      const { owner, repo, issue_number, body } = input;
      const response = await t.request<CreatePullRequestIssueCommentOutput>(
        {
          method: "POST",
          path: `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
          body: { body },
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      createIssueCommentFields.commentId.set(response.data.id);
      createIssueCommentFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── pulls.create ────────────────────────────────────────────────────────────

const createInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1),
  body: z.string().optional(),
  maintainer_can_modify: z.boolean().optional(),
  draft: z.boolean().optional(),
});

export type CreatePullRequestInput = z.infer<typeof createInputSchema>;
export type CreatePullRequestOutput = Endpoints["POST /repos/{owner}/{repo}/pulls"]["response"]["data"];

const createFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  head: observe.field<string>(),
  base: observe.field<string>(),
  pullNumber: observe.number(),
  status: observe.number(),
});

export function createPullRequest(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.create",
    transport,
    input: fromSafeParse(createInputSchema),
    output: passthrough<CreatePullRequestOutput>(),
    fields: createFields,
    run: async (input, tools, t) => {
      createFields.owner.set(input.owner);
      createFields.repo.set(input.repo);
      createFields.head.set(input.head);
      createFields.base.set(input.base);
      const { owner, repo, ...body } = input;
      const response = await t.request<CreatePullRequestOutput>(
        {
          method: "POST",
          path: `/repos/${owner}/${repo}/pulls`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      createFields.pullNumber.set(response.data.number);
      createFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── pulls.update ────────────────────────────────────────────────────────────

const updateInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
  title: z.string().optional(),
  body: z.string().optional(),
  state: z.enum(["open", "closed"]).optional(),
  base: z.string().optional(),
  maintainer_can_modify: z.boolean().optional(),
});

export type UpdatePullRequestInput = z.infer<typeof updateInputSchema>;
export type UpdatePullRequestOutput = Endpoints["PATCH /repos/{owner}/{repo}/pulls/{pull_number}"]["response"]["data"];

const updateFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  pullNumber: observe.number(),
  state: observe.field<string>(),
  status: observe.number(),
});

export function updatePullRequest(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.update",
    transport,
    input: fromSafeParse(updateInputSchema),
    output: passthrough<UpdatePullRequestOutput>(),
    fields: updateFields,
    run: async (input, tools, t) => {
      updateFields.owner.set(input.owner);
      updateFields.repo.set(input.repo);
      updateFields.pullNumber.set(input.pull_number);
      if (input.state !== undefined) updateFields.state.set(input.state);
      const { owner, repo, pull_number, ...body } = input;
      const response = await t.request<UpdatePullRequestOutput>(
        {
          method: "PATCH",
          path: `/repos/${owner}/${repo}/pulls/${pull_number}`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      updateFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── pulls.merge ─────────────────────────────────────────────────────────────

const mergeInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
  commit_title: z.string().optional(),
  commit_message: z.string().optional(),
  sha: z.string().optional(),
  merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
});

export type MergePullRequestInput = z.infer<typeof mergeInputSchema>;
export type MergePullRequestOutput =
  Endpoints["PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"]["response"]["data"];

const mergeFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  pullNumber: observe.number(),
  method: observe.field<string>(),
  merged: observe.field<boolean>(),
  status: observe.number(),
});

export function mergePullRequest(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.merge",
    transport,
    input: fromSafeParse(mergeInputSchema),
    output: passthrough<MergePullRequestOutput>(),
    fields: mergeFields,
    run: async (input, tools, t) => {
      mergeFields.owner.set(input.owner);
      mergeFields.repo.set(input.repo);
      mergeFields.pullNumber.set(input.pull_number);
      if (input.merge_method !== undefined) mergeFields.method.set(input.merge_method);
      const { owner, repo, pull_number, ...body } = input;
      const response = await t.request<MergePullRequestOutput>(
        {
          method: "PUT",
          path: `/repos/${owner}/${repo}/pulls/${pull_number}/merge`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      mergeFields.merged.set(response.data.merged);
      mergeFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── pulls.requestReviewers ──────────────────────────────────────────────────

const requestReviewersInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
  reviewers: z.array(z.string()).optional(),
  team_reviewers: z.array(z.string()).optional(),
});

export type RequestReviewersInput = z.infer<typeof requestReviewersInputSchema>;
export type RequestReviewersOutput =
  Endpoints["POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers"]["response"]["data"];

const requestReviewersFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  pullNumber: observe.number(),
  reviewerCount: observe.number(),
  status: observe.number(),
});

export function requestReviewers(transport: Transport) {
  return defineGithubOperation({
    name: "github.pulls.requestReviewers",
    transport,
    input: fromSafeParse(requestReviewersInputSchema),
    output: passthrough<RequestReviewersOutput>(),
    fields: requestReviewersFields,
    run: async (input, tools, t) => {
      requestReviewersFields.owner.set(input.owner);
      requestReviewersFields.repo.set(input.repo);
      requestReviewersFields.pullNumber.set(input.pull_number);
      requestReviewersFields.reviewerCount.set((input.reviewers?.length ?? 0) + (input.team_reviewers?.length ?? 0));
      const { owner, repo, pull_number, ...body } = input;
      const response = await t.request<RequestReviewersOutput>(
        {
          method: "POST",
          path: `/repos/${owner}/${repo}/pulls/${pull_number}/requested_reviewers`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      requestReviewersFields.status.set(response.status);
      return response.data;
    },
  });
}

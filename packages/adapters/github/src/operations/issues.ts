/**
 * Issue operations.
 *
 * GitHub treats PRs as a kind of issue: every PR has a corresponding
 * issue record, and the issue-comments API serves both. This cluster
 * covers issue-shaped operations that the pulls cluster doesn't —
 * listing issues, creating + updating, label management, and the
 * comment listing that complements pulls.createIssueComment.
 */

import { observe } from "@phyxiusjs/observe";
import { fromSafeParse, passthrough } from "@phyxiusjs/validate";
import type { Endpoints } from "@octokit/types";
import { z } from "zod";

import { defineGithubOperation } from "../define-operation.js";
import type { Transport } from "../transport.js";

// ── issues.list ─────────────────────────────────────────────────────────────

const listInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  milestone: z.string().optional(),
  state: z.enum(["open", "closed", "all"]).optional(),
  assignee: z.string().optional(),
  creator: z.string().optional(),
  mentioned: z.string().optional(),
  labels: z.string().optional(),
  sort: z.enum(["created", "updated", "comments"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  since: z.string().optional(),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

export type ListIssuesInput = z.infer<typeof listInputSchema>;
export type ListIssuesOutput = Endpoints["GET /repos/{owner}/{repo}/issues"]["response"]["data"];

const listFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  count: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function listIssues(transport: Transport) {
  return defineGithubOperation({
    name: "github.issues.list",
    transport,
    input: fromSafeParse(listInputSchema),
    output: passthrough<ListIssuesOutput>(),
    fields: listFields,
    run: async (input, tools, t) => {
      listFields.owner.set(input.owner);
      listFields.repo.set(input.repo);
      const { owner, repo, ...query } = input;
      const response = await t.request<ListIssuesOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/issues`,
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

// ── issues.get ──────────────────────────────────────────────────────────────

const getInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
});

export type GetIssueInput = z.infer<typeof getInputSchema>;
export type GetIssueOutput = Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}"]["response"]["data"];

const getFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  issueNumber: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getIssue(transport: Transport) {
  return defineGithubOperation({
    name: "github.issues.get",
    transport,
    input: fromSafeParse(getInputSchema),
    output: passthrough<GetIssueOutput>(),
    fields: getFields,
    run: async (input, tools, t) => {
      getFields.owner.set(input.owner);
      getFields.repo.set(input.repo);
      getFields.issueNumber.set(input.issue_number);
      const response = await t.request<GetIssueOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/issues/${input.issue_number}`,
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

// ── issues.create ───────────────────────────────────────────────────────────

const createInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().int().positive().optional(),
  labels: z.array(z.string()).optional(),
});

export type CreateIssueInput = z.infer<typeof createInputSchema>;
export type CreateIssueOutput = Endpoints["POST /repos/{owner}/{repo}/issues"]["response"]["data"];

const createFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  issueNumber: observe.number(),
  status: observe.number(),
});

export function createIssue(transport: Transport) {
  return defineGithubOperation({
    name: "github.issues.create",
    transport,
    input: fromSafeParse(createInputSchema),
    output: passthrough<CreateIssueOutput>(),
    fields: createFields,
    run: async (input, tools, t) => {
      createFields.owner.set(input.owner);
      createFields.repo.set(input.repo);
      const { owner, repo, ...body } = input;
      const response = await t.request<CreateIssueOutput>(
        {
          method: "POST",
          path: `/repos/${owner}/${repo}/issues`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      createFields.issueNumber.set(response.data.number);
      createFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── issues.update ───────────────────────────────────────────────────────────

const updateInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  title: z.string().optional(),
  body: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  state: z.enum(["open", "closed"]).optional(),
  state_reason: z.enum(["completed", "not_planned", "reopened"]).optional(),
  milestone: z.number().int().positive().nullable().optional(),
  labels: z.array(z.string()).optional(),
});

export type UpdateIssueInput = z.infer<typeof updateInputSchema>;
export type UpdateIssueOutput = Endpoints["PATCH /repos/{owner}/{repo}/issues/{issue_number}"]["response"]["data"];

const updateFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  issueNumber: observe.number(),
  state: observe.field<string>(),
  status: observe.number(),
});

export function updateIssue(transport: Transport) {
  return defineGithubOperation({
    name: "github.issues.update",
    transport,
    input: fromSafeParse(updateInputSchema),
    output: passthrough<UpdateIssueOutput>(),
    fields: updateFields,
    run: async (input, tools, t) => {
      updateFields.owner.set(input.owner);
      updateFields.repo.set(input.repo);
      updateFields.issueNumber.set(input.issue_number);
      if (input.state !== undefined) updateFields.state.set(input.state);
      const { owner, repo, issue_number, ...body } = input;
      const response = await t.request<UpdateIssueOutput>(
        {
          method: "PATCH",
          path: `/repos/${owner}/${repo}/issues/${issue_number}`,
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

// ── issues.listComments ─────────────────────────────────────────────────────

const listCommentsInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  since: z.string().optional(),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

export type ListIssueCommentsInput = z.infer<typeof listCommentsInputSchema>;
export type ListIssueCommentsOutput =
  Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}/comments"]["response"]["data"];

const listCommentsFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  issueNumber: observe.number(),
  count: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function listIssueComments(transport: Transport) {
  return defineGithubOperation({
    name: "github.issues.listComments",
    transport,
    input: fromSafeParse(listCommentsInputSchema),
    output: passthrough<ListIssueCommentsOutput>(),
    fields: listCommentsFields,
    run: async (input, tools, t) => {
      listCommentsFields.owner.set(input.owner);
      listCommentsFields.repo.set(input.repo);
      listCommentsFields.issueNumber.set(input.issue_number);
      const { owner, repo, issue_number, ...query } = input;
      const response = await t.request<ListIssueCommentsOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      listCommentsFields.count.set(response.data.length);
      listCommentsFields.status.set(response.status);
      listCommentsFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── issues.addLabels / removeLabel ──────────────────────────────────────────

const addLabelsInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  labels: z.array(z.string().min(1)).min(1),
});

export type AddLabelsInput = z.infer<typeof addLabelsInputSchema>;
export type AddLabelsOutput = Endpoints["POST /repos/{owner}/{repo}/issues/{issue_number}/labels"]["response"]["data"];

const addLabelsFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  issueNumber: observe.number(),
  labelCount: observe.number(),
  status: observe.number(),
});

export function addLabels(transport: Transport) {
  return defineGithubOperation({
    name: "github.issues.addLabels",
    transport,
    input: fromSafeParse(addLabelsInputSchema),
    output: passthrough<AddLabelsOutput>(),
    fields: addLabelsFields,
    run: async (input, tools, t) => {
      addLabelsFields.owner.set(input.owner);
      addLabelsFields.repo.set(input.repo);
      addLabelsFields.issueNumber.set(input.issue_number);
      addLabelsFields.labelCount.set(input.labels.length);
      const response = await t.request<AddLabelsOutput>(
        {
          method: "POST",
          path: `/repos/${input.owner}/${input.repo}/issues/${input.issue_number}/labels`,
          body: { labels: input.labels },
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      addLabelsFields.status.set(response.status);
      return response.data;
    },
  });
}

const removeLabelInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  name: z.string().min(1),
});

export type RemoveLabelInput = z.infer<typeof removeLabelInputSchema>;
export type RemoveLabelOutput =
  Endpoints["DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}"]["response"]["data"];

const removeLabelFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  issueNumber: observe.number(),
  name: observe.field<string>(),
  status: observe.number(),
});

export function removeLabel(transport: Transport) {
  return defineGithubOperation({
    name: "github.issues.removeLabel",
    transport,
    input: fromSafeParse(removeLabelInputSchema),
    output: passthrough<RemoveLabelOutput>(),
    fields: removeLabelFields,
    run: async (input, tools, t) => {
      removeLabelFields.owner.set(input.owner);
      removeLabelFields.repo.set(input.repo);
      removeLabelFields.issueNumber.set(input.issue_number);
      removeLabelFields.name.set(input.name);
      const response = await t.request<RemoveLabelOutput>(
        {
          method: "DELETE",
          path: `/repos/${input.owner}/${input.repo}/issues/${input.issue_number}/labels/${encodeURIComponent(input.name)}`,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      removeLabelFields.status.set(response.status);
      return response.data;
    },
  });
}

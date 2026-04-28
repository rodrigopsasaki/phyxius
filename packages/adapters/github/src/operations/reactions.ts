/**
 * Reactions.
 *
 * Small but real UX for a PR-review bot: reacting with 👀 to a
 * just-arrived PR comment to signal "I see it, working on it",
 * then ✅ when the response is posted, leaves humans with a clear
 * read on the bot's state without spamming the conversation.
 *
 * GitHub's reaction API has three relevant surfaces (the only
 * three a PR-review bot actually uses):
 *   - issue comments  → POST /repos/{o}/{r}/issues/comments/{id}/reactions
 *   - PR review comments → POST /repos/{o}/{r}/pulls/comments/{id}/reactions
 *   - issues / PRs themselves → POST /repos/{o}/{r}/issues/{n}/reactions
 *
 * The valid `content` values are the same on all three. The
 * cluster keeps them as a strict union to avoid typos in
 * production.
 */

import { observe } from "@phyxiusjs/observe";
import { fromSafeParse, passthrough } from "@phyxiusjs/validate";
import type { Endpoints } from "@octokit/types";
import { z } from "zod";

import { defineGithubOperation } from "../define-operation.js";
import type { Transport } from "../transport.js";

const reactionContent = z.enum(["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"]);

// ── reactions.createForIssueComment ─────────────────────────────────────────

const issueCommentInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  comment_id: z.number().int().positive(),
  content: reactionContent,
});

export type CreateReactionForIssueCommentInput = z.infer<typeof issueCommentInputSchema>;
export type CreateReactionForIssueCommentOutput =
  Endpoints["POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"]["response"]["data"];

const issueCommentFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  commentId: observe.number(),
  content: observe.field<string>(),
  reactionId: observe.number(),
  status: observe.number(),
});

export function createReactionForIssueComment(transport: Transport) {
  return defineGithubOperation({
    name: "github.reactions.createForIssueComment",
    transport,
    input: fromSafeParse(issueCommentInputSchema),
    output: passthrough<CreateReactionForIssueCommentOutput>(),
    fields: issueCommentFields,
    run: async (input, tools, t) => {
      issueCommentFields.owner.set(input.owner);
      issueCommentFields.repo.set(input.repo);
      issueCommentFields.commentId.set(input.comment_id);
      issueCommentFields.content.set(input.content);
      const response = await t.request<CreateReactionForIssueCommentOutput>(
        {
          method: "POST",
          path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.comment_id}/reactions`,
          body: { content: input.content },
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      issueCommentFields.reactionId.set(response.data.id);
      issueCommentFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── reactions.createForPullRequestReviewComment ─────────────────────────────

const prReviewCommentInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  comment_id: z.number().int().positive(),
  content: reactionContent,
});

export type CreateReactionForPullRequestReviewCommentInput = z.infer<typeof prReviewCommentInputSchema>;
export type CreateReactionForPullRequestReviewCommentOutput =
  Endpoints["POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions"]["response"]["data"];

const prReviewCommentFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  commentId: observe.number(),
  content: observe.field<string>(),
  reactionId: observe.number(),
  status: observe.number(),
});

export function createReactionForPullRequestReviewComment(transport: Transport) {
  return defineGithubOperation({
    name: "github.reactions.createForPullRequestReviewComment",
    transport,
    input: fromSafeParse(prReviewCommentInputSchema),
    output: passthrough<CreateReactionForPullRequestReviewCommentOutput>(),
    fields: prReviewCommentFields,
    run: async (input, tools, t) => {
      prReviewCommentFields.owner.set(input.owner);
      prReviewCommentFields.repo.set(input.repo);
      prReviewCommentFields.commentId.set(input.comment_id);
      prReviewCommentFields.content.set(input.content);
      const response = await t.request<CreateReactionForPullRequestReviewCommentOutput>(
        {
          method: "POST",
          path: `/repos/${input.owner}/${input.repo}/pulls/comments/${input.comment_id}/reactions`,
          body: { content: input.content },
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      prReviewCommentFields.reactionId.set(response.data.id);
      prReviewCommentFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── reactions.createForIssue (works for PRs since they share the API) ───────

const issueInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  content: reactionContent,
});

export type CreateReactionForIssueInput = z.infer<typeof issueInputSchema>;
export type CreateReactionForIssueOutput =
  Endpoints["POST /repos/{owner}/{repo}/issues/{issue_number}/reactions"]["response"]["data"];

const issueFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  issueNumber: observe.number(),
  content: observe.field<string>(),
  reactionId: observe.number(),
  status: observe.number(),
});

export function createReactionForIssue(transport: Transport) {
  return defineGithubOperation({
    name: "github.reactions.createForIssue",
    transport,
    input: fromSafeParse(issueInputSchema),
    output: passthrough<CreateReactionForIssueOutput>(),
    fields: issueFields,
    run: async (input, tools, t) => {
      issueFields.owner.set(input.owner);
      issueFields.repo.set(input.repo);
      issueFields.issueNumber.set(input.issue_number);
      issueFields.content.set(input.content);
      const response = await t.request<CreateReactionForIssueOutput>(
        {
          method: "POST",
          path: `/repos/${input.owner}/${input.repo}/issues/${input.issue_number}/reactions`,
          body: { content: input.content },
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      issueFields.reactionId.set(response.data.id);
      issueFields.status.set(response.status);
      return response.data;
    },
  });
}

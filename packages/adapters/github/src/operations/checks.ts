/**
 * Checks and statuses operations.
 *
 * GitHub has two overlapping mechanisms for surfacing CI/CD signal
 * on a commit, and a real PR reviewer must understand both:
 *
 *   - **Check runs** (newer, richer): each CI system reports zero
 *     or more check runs per commit. Each carries name, status
 *     (queued / in_progress / completed), conclusion (success /
 *     failure / cancelled / etc.), output (title, summary, text,
 *     annotations), and timestamps. List via
 *     `/commits/{ref}/check-runs`.
 *
 *   - **Combined status** (older): each commit has a `state`
 *     (success / failure / pending / error) computed from a list
 *     of "statuses" posted via the statuses API. Older CI systems
 *     and some integrations still use this surface. List via
 *     `/commits/{ref}/status`.
 *
 * A bot that wants to know "is this PR healthy?" reads BOTH —
 * absence of failing check-runs AND combined status != "failure".
 * This cluster exposes both surfaces; the bot's policy is its own
 * call.
 *
 * The bot can also post its OWN check runs (e.g., "mycelium-review:
 * 5 advisory comments, 2 suggestions") via createCheckRun. This is
 * the recommended mechanism for non-blocking advisory output —
 * surfaces in the PR's check tab without spamming comments.
 */

import { observe } from "@phyxiusjs/observe";
import { fromSafeParse, passthrough } from "@phyxiusjs/validate";
import type { Endpoints } from "@octokit/types";
import { z } from "zod";

import { defineGithubOperation } from "../define-operation.js";
import type { Transport } from "../transport.js";

// ── checks.listForRef ───────────────────────────────────────────────────────

const listForRefInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
  check_name: z.string().optional(),
  status: z.enum(["queued", "in_progress", "completed"]).optional(),
  filter: z.enum(["latest", "all"]).optional(),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
  app_id: z.number().int().positive().optional(),
});

export type ListChecksForRefInput = z.infer<typeof listForRefInputSchema>;
export type ListChecksForRefOutput =
  Endpoints["GET /repos/{owner}/{repo}/commits/{ref}/check-runs"]["response"]["data"];

const listForRefFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  ref: observe.field<string>(),
  total: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function listChecksForRef(transport: Transport) {
  return defineGithubOperation({
    name: "github.checks.listForRef",
    transport,
    input: fromSafeParse(listForRefInputSchema),
    output: passthrough<ListChecksForRefOutput>(),
    fields: listForRefFields,
    run: async (input, tools, t) => {
      listForRefFields.owner.set(input.owner);
      listForRefFields.repo.set(input.repo);
      listForRefFields.ref.set(input.ref);
      const { owner, repo, ref, ...query } = input;
      const response = await t.request<ListChecksForRefOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/commits/${ref}/check-runs`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      listForRefFields.total.set(response.data.total_count);
      listForRefFields.status.set(response.status);
      listForRefFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── checks.get ──────────────────────────────────────────────────────────────

const getInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  check_run_id: z.number().int().positive(),
});

export type GetCheckRunInput = z.infer<typeof getInputSchema>;
export type GetCheckRunOutput = Endpoints["GET /repos/{owner}/{repo}/check-runs/{check_run_id}"]["response"]["data"];

const getFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  checkRunId: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getCheckRun(transport: Transport) {
  return defineGithubOperation({
    name: "github.checks.get",
    transport,
    input: fromSafeParse(getInputSchema),
    output: passthrough<GetCheckRunOutput>(),
    fields: getFields,
    run: async (input, tools, t) => {
      getFields.owner.set(input.owner);
      getFields.repo.set(input.repo);
      getFields.checkRunId.set(input.check_run_id);
      const response = await t.request<GetCheckRunOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/check-runs/${input.check_run_id}`,
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

// ── checks.getCombinedStatusForRef (legacy statuses API) ────────────────────

const combinedInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

export type GetCombinedStatusInput = z.infer<typeof combinedInputSchema>;
export type GetCombinedStatusOutput = Endpoints["GET /repos/{owner}/{repo}/commits/{ref}/status"]["response"]["data"];

const combinedFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  ref: observe.field<string>(),
  state: observe.field<string>(),
  totalCount: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getCombinedStatusForRef(transport: Transport) {
  return defineGithubOperation({
    name: "github.checks.getCombinedStatusForRef",
    transport,
    input: fromSafeParse(combinedInputSchema),
    output: passthrough<GetCombinedStatusOutput>(),
    fields: combinedFields,
    run: async (input, tools, t) => {
      combinedFields.owner.set(input.owner);
      combinedFields.repo.set(input.repo);
      combinedFields.ref.set(input.ref);
      const { owner, repo, ref, ...query } = input;
      const response = await t.request<GetCombinedStatusOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/commits/${ref}/status`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      combinedFields.state.set(response.data.state);
      combinedFields.totalCount.set(response.data.total_count);
      combinedFields.status.set(response.status);
      combinedFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── checks.create (the bot posting its own check run) ──────────────────────

const checkOutputSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    text: z.string().optional(),
    annotations: z
      .array(
        z.object({
          path: z.string(),
          start_line: z.number().int().positive(),
          end_line: z.number().int().positive(),
          start_column: z.number().int().positive().optional(),
          end_column: z.number().int().positive().optional(),
          annotation_level: z.enum(["notice", "warning", "failure"]),
          message: z.string(),
          title: z.string().optional(),
          raw_details: z.string().optional(),
        }),
      )
      .optional(),
    images: z
      .array(
        z.object({
          alt: z.string(),
          image_url: z.string(),
          caption: z.string().optional(),
        }),
      )
      .optional(),
  })
  .optional();

const createInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  name: z.string().min(1),
  head_sha: z.string().min(1),
  details_url: z.string().optional(),
  external_id: z.string().optional(),
  status: z.enum(["queued", "in_progress", "completed"]).optional(),
  started_at: z.string().optional(),
  conclusion: z
    .enum(["action_required", "cancelled", "failure", "neutral", "success", "skipped", "stale", "timed_out"])
    .optional(),
  completed_at: z.string().optional(),
  output: checkOutputSchema,
  actions: z
    .array(
      z.object({
        label: z.string().max(20),
        description: z.string().max(40),
        identifier: z.string().max(20),
      }),
    )
    .optional(),
});

export type CreateCheckRunInput = z.infer<typeof createInputSchema>;
export type CreateCheckRunOutput = Endpoints["POST /repos/{owner}/{repo}/check-runs"]["response"]["data"];

const createFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  name: observe.field<string>(),
  headSha: observe.field<string>(),
  status: observe.field<string>(),
  conclusion: observe.field<string>(),
  checkRunId: observe.number(),
  httpStatus: observe.number(),
});

export function createCheckRun(transport: Transport) {
  return defineGithubOperation({
    name: "github.checks.create",
    transport,
    input: fromSafeParse(createInputSchema),
    output: passthrough<CreateCheckRunOutput>(),
    fields: createFields,
    run: async (input, tools, t) => {
      createFields.owner.set(input.owner);
      createFields.repo.set(input.repo);
      createFields.name.set(input.name);
      createFields.headSha.set(input.head_sha);
      if (input.status !== undefined) createFields.status.set(input.status);
      if (input.conclusion !== undefined) createFields.conclusion.set(input.conclusion);
      const { owner, repo, ...body } = input;
      const response = await t.request<CreateCheckRunOutput>(
        {
          method: "POST",
          path: `/repos/${owner}/${repo}/check-runs`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      createFields.checkRunId.set(response.data.id);
      createFields.httpStatus.set(response.status);
      return response.data;
    },
  });
}

// ── checks.update ───────────────────────────────────────────────────────────

const updateInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  check_run_id: z.number().int().positive(),
  name: z.string().optional(),
  details_url: z.string().optional(),
  external_id: z.string().optional(),
  started_at: z.string().optional(),
  status: z.enum(["queued", "in_progress", "completed"]).optional(),
  conclusion: z
    .enum(["action_required", "cancelled", "failure", "neutral", "success", "skipped", "stale", "timed_out"])
    .optional(),
  completed_at: z.string().optional(),
  output: checkOutputSchema,
});

export type UpdateCheckRunInput = z.infer<typeof updateInputSchema>;
export type UpdateCheckRunOutput =
  Endpoints["PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}"]["response"]["data"];

const updateFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  checkRunId: observe.number(),
  status: observe.field<string>(),
  conclusion: observe.field<string>(),
  httpStatus: observe.number(),
});

export function updateCheckRun(transport: Transport) {
  return defineGithubOperation({
    name: "github.checks.update",
    transport,
    input: fromSafeParse(updateInputSchema),
    output: passthrough<UpdateCheckRunOutput>(),
    fields: updateFields,
    run: async (input, tools, t) => {
      updateFields.owner.set(input.owner);
      updateFields.repo.set(input.repo);
      updateFields.checkRunId.set(input.check_run_id);
      if (input.status !== undefined) updateFields.status.set(input.status);
      if (input.conclusion !== undefined) updateFields.conclusion.set(input.conclusion);
      const { owner, repo, check_run_id, ...body } = input;
      const response = await t.request<UpdateCheckRunOutput>(
        {
          method: "PATCH",
          path: `/repos/${owner}/${repo}/check-runs/${check_run_id}`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      updateFields.httpStatus.set(response.status);
      return response.data;
    },
  });
}

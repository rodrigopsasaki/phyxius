/**
 * Repository operations.
 *
 * Covers the repo-shaped surface a real consumer needs: metadata,
 * branch + ref listing, commit walking + diffs, file contents
 * (read + write + delete), README access, and tree fetches for
 * efficient codebase enumeration.
 *
 * The cluster is structured so that codebase ingest — the substrate
 * population pass — can be written entirely against this file plus
 * pagination utilities. listBranches → listCommits per branch →
 * getCommitDiff per commit walks an entire repo history.
 */

import { observe } from "@phyxiusjs/observe";
import { fromSafeParse, passthrough } from "@phyxiusjs/validate";
import type { Endpoints } from "@octokit/types";
import { z } from "zod";

import { defineGithubOperation } from "../define-operation.js";
import type { Transport } from "../transport.js";

// ── repos.get ───────────────────────────────────────────────────────────────

const getInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export type GetRepoInput = z.infer<typeof getInputSchema>;
export type GetRepoOutput = Endpoints["GET /repos/{owner}/{repo}"]["response"]["data"];

const getFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getRepo(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.get",
    transport,
    input: fromSafeParse(getInputSchema),
    output: passthrough<GetRepoOutput>(),
    fields: getFields,
    run: async (input, tools, t) => {
      getFields.owner.set(input.owner);
      getFields.repo.set(input.repo);
      const response = await t.request<GetRepoOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}`,
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

// ── repos.listBranches ──────────────────────────────────────────────────────

const listBranchesInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  protected: z.boolean().optional(),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

export type ListBranchesInput = z.infer<typeof listBranchesInputSchema>;
export type ListBranchesOutput = Endpoints["GET /repos/{owner}/{repo}/branches"]["response"]["data"];

const listBranchesFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  count: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function listBranches(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.listBranches",
    transport,
    input: fromSafeParse(listBranchesInputSchema),
    output: passthrough<ListBranchesOutput>(),
    fields: listBranchesFields,
    run: async (input, tools, t) => {
      listBranchesFields.owner.set(input.owner);
      listBranchesFields.repo.set(input.repo);
      const { owner, repo, ...query } = input;
      const response = await t.request<ListBranchesOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/branches`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      listBranchesFields.count.set(response.data.length);
      listBranchesFields.status.set(response.status);
      listBranchesFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.getBranch ─────────────────────────────────────────────────────────

const getBranchInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
});

export type GetBranchInput = z.infer<typeof getBranchInputSchema>;
export type GetBranchOutput = Endpoints["GET /repos/{owner}/{repo}/branches/{branch}"]["response"]["data"];

const getBranchFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  branch: observe.field<string>(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getBranch(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.getBranch",
    transport,
    input: fromSafeParse(getBranchInputSchema),
    output: passthrough<GetBranchOutput>(),
    fields: getBranchFields,
    run: async (input, tools, t) => {
      getBranchFields.owner.set(input.owner);
      getBranchFields.repo.set(input.repo);
      getBranchFields.branch.set(input.branch);
      const response = await t.request<GetBranchOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/branches/${encodeURIComponent(input.branch)}`,
          resource: "core",
        },
        tools.signal,
      );
      getBranchFields.status.set(response.status);
      getBranchFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.listCommits ───────────────────────────────────────────────────────

const listCommitsInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  sha: z.string().optional(),
  path: z.string().optional(),
  author: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  per_page: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

export type ListCommitsInput = z.infer<typeof listCommitsInputSchema>;
export type ListCommitsOutput = Endpoints["GET /repos/{owner}/{repo}/commits"]["response"]["data"];

const listCommitsFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  count: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function listCommits(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.listCommits",
    transport,
    input: fromSafeParse(listCommitsInputSchema),
    output: passthrough<ListCommitsOutput>(),
    fields: listCommitsFields,
    run: async (input, tools, t) => {
      listCommitsFields.owner.set(input.owner);
      listCommitsFields.repo.set(input.repo);
      const { owner, repo, ...query } = input;
      const response = await t.request<ListCommitsOutput>(
        {
          method: "GET",
          path: `/repos/${owner}/${repo}/commits`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      listCommitsFields.count.set(response.data.length);
      listCommitsFields.status.set(response.status);
      listCommitsFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.getCommit ─────────────────────────────────────────────────────────

const getCommitInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
});

export type GetCommitInput = z.infer<typeof getCommitInputSchema>;
export type GetCommitOutput = Endpoints["GET /repos/{owner}/{repo}/commits/{ref}"]["response"]["data"];

const getCommitFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  ref: observe.field<string>(),
  fileCount: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getCommit(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.getCommit",
    transport,
    input: fromSafeParse(getCommitInputSchema),
    output: passthrough<GetCommitOutput>(),
    fields: getCommitFields,
    run: async (input, tools, t) => {
      getCommitFields.owner.set(input.owner);
      getCommitFields.repo.set(input.repo);
      getCommitFields.ref.set(input.ref);
      const response = await t.request<GetCommitOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/commits/${input.ref}`,
          resource: "core",
        },
        tools.signal,
      );
      getCommitFields.fileCount.set(response.data.files?.length ?? 0);
      getCommitFields.status.set(response.status);
      getCommitFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.getCommitDiff (raw diff via Accept header) ────────────────────────

const getCommitDiffInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
});

export type GetCommitDiffInput = z.infer<typeof getCommitDiffInputSchema>;

const getCommitDiffFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  ref: observe.field<string>(),
  diffBytes: observe.number(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getCommitDiff(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.getCommitDiff",
    transport,
    input: fromSafeParse(getCommitDiffInputSchema),
    output: passthrough<string>(),
    fields: getCommitDiffFields,
    run: async (input, tools, t) => {
      getCommitDiffFields.owner.set(input.owner);
      getCommitDiffFields.repo.set(input.repo);
      getCommitDiffFields.ref.set(input.ref);
      const response = await t.request<string>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/commits/${input.ref}`,
          acceptType: "diff",
          resource: "core",
        },
        tools.signal,
      );
      getCommitDiffFields.diffBytes.set(response.data.length);
      getCommitDiffFields.status.set(response.status);
      getCommitDiffFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.compareCommits ────────────────────────────────────────────────────

const compareInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  basehead: z.string().min(1),
});

export type CompareCommitsInput = z.infer<typeof compareInputSchema>;
export type CompareCommitsOutput = Endpoints["GET /repos/{owner}/{repo}/compare/{basehead}"]["response"]["data"];

const compareFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  basehead: observe.field<string>(),
  status: observe.number(),
  aheadBy: observe.number(),
  behindBy: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function compareCommits(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.compareCommits",
    transport,
    input: fromSafeParse(compareInputSchema),
    output: passthrough<CompareCommitsOutput>(),
    fields: compareFields,
    run: async (input, tools, t) => {
      compareFields.owner.set(input.owner);
      compareFields.repo.set(input.repo);
      compareFields.basehead.set(input.basehead);
      const response = await t.request<CompareCommitsOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/compare/${input.basehead}`,
          resource: "core",
        },
        tools.signal,
      );
      compareFields.status.set(response.status);
      compareFields.aheadBy.set(response.data.ahead_by);
      compareFields.behindBy.set(response.data.behind_by);
      compareFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.getContents (file or dir at a path/ref) ───────────────────────────

const getContentsInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string(),
  ref: z.string().optional(),
});

export type GetContentsInput = z.infer<typeof getContentsInputSchema>;
export type GetContentsOutput = Endpoints["GET /repos/{owner}/{repo}/contents/{path}"]["response"]["data"];

const getContentsFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  path: observe.field<string>(),
  ref: observe.field<string>(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getContents(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.getContents",
    transport,
    input: fromSafeParse(getContentsInputSchema),
    output: passthrough<GetContentsOutput>(),
    fields: getContentsFields,
    run: async (input, tools, t) => {
      getContentsFields.owner.set(input.owner);
      getContentsFields.repo.set(input.repo);
      getContentsFields.path.set(input.path);
      if (input.ref !== undefined) getContentsFields.ref.set(input.ref);
      const query: Record<string, string> = {};
      if (input.ref !== undefined) query["ref"] = input.ref;
      const response = await t.request<GetContentsOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/contents/${encodePath(input.path)}`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      getContentsFields.status.set(response.status);
      getContentsFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.getReadme ─────────────────────────────────────────────────────────

const getReadmeInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().optional(),
});

export type GetReadmeInput = z.infer<typeof getReadmeInputSchema>;
export type GetReadmeOutput = Endpoints["GET /repos/{owner}/{repo}/readme"]["response"]["data"];

const getReadmeFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  ref: observe.field<string>(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getReadme(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.getReadme",
    transport,
    input: fromSafeParse(getReadmeInputSchema),
    output: passthrough<GetReadmeOutput>(),
    fields: getReadmeFields,
    run: async (input, tools, t) => {
      getReadmeFields.owner.set(input.owner);
      getReadmeFields.repo.set(input.repo);
      if (input.ref !== undefined) getReadmeFields.ref.set(input.ref);
      const query: Record<string, string> = {};
      if (input.ref !== undefined) query["ref"] = input.ref;
      const response = await t.request<GetReadmeOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/readme`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      getReadmeFields.status.set(response.status);
      getReadmeFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.getTree (efficient enumeration of a ref's files) ──────────────────

const getTreeInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  tree_sha: z.string().min(1),
  recursive: z.boolean().optional(),
});

export type GetTreeInput = z.infer<typeof getTreeInputSchema>;
export type GetTreeOutput = Endpoints["GET /repos/{owner}/{repo}/git/trees/{tree_sha}"]["response"]["data"];

const getTreeFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  treeSha: observe.field<string>(),
  recursive: observe.field<boolean>(),
  entryCount: observe.number(),
  truncated: observe.field<boolean>(),
  status: observe.number(),
  fromCache: observe.field<boolean>(),
});

export function getTree(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.getTree",
    transport,
    input: fromSafeParse(getTreeInputSchema),
    output: passthrough<GetTreeOutput>(),
    fields: getTreeFields,
    run: async (input, tools, t) => {
      getTreeFields.owner.set(input.owner);
      getTreeFields.repo.set(input.repo);
      getTreeFields.treeSha.set(input.tree_sha);
      getTreeFields.recursive.set(input.recursive ?? false);
      const query: Record<string, string> = {};
      if (input.recursive === true) query["recursive"] = "1";
      const response = await t.request<GetTreeOutput>(
        {
          method: "GET",
          path: `/repos/${input.owner}/${input.repo}/git/trees/${input.tree_sha}`,
          query,
          resource: "core",
        },
        tools.signal,
      );
      getTreeFields.entryCount.set(response.data.tree.length);
      getTreeFields.truncated.set(response.data.truncated);
      getTreeFields.status.set(response.status);
      getTreeFields.fromCache.set(response.fromCache);
      return response.data;
    },
  });
}

// ── repos.createOrUpdateFileContents ────────────────────────────────────────

const createOrUpdateFileInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().min(1),
  message: z.string().min(1),
  /** Base64-encoded file contents. */
  content: z.string().min(1),
  /** Required when updating an existing file; the SHA of the file being replaced. */
  sha: z.string().optional(),
  branch: z.string().optional(),
  committer: z
    .object({
      name: z.string(),
      email: z.string(),
    })
    .optional(),
  author: z
    .object({
      name: z.string(),
      email: z.string(),
    })
    .optional(),
});

export type CreateOrUpdateFileInput = z.infer<typeof createOrUpdateFileInputSchema>;
export type CreateOrUpdateFileOutput = Endpoints["PUT /repos/{owner}/{repo}/contents/{path}"]["response"]["data"];

const createOrUpdateFileFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  path: observe.field<string>(),
  branch: observe.field<string>(),
  isUpdate: observe.field<boolean>(),
  status: observe.number(),
});

export function createOrUpdateFile(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.createOrUpdateFile",
    transport,
    input: fromSafeParse(createOrUpdateFileInputSchema),
    output: passthrough<CreateOrUpdateFileOutput>(),
    fields: createOrUpdateFileFields,
    run: async (input, tools, t) => {
      createOrUpdateFileFields.owner.set(input.owner);
      createOrUpdateFileFields.repo.set(input.repo);
      createOrUpdateFileFields.path.set(input.path);
      if (input.branch !== undefined) createOrUpdateFileFields.branch.set(input.branch);
      createOrUpdateFileFields.isUpdate.set(input.sha !== undefined);
      const { owner, repo, path, ...body } = input;
      const response = await t.request<CreateOrUpdateFileOutput>(
        {
          method: "PUT",
          path: `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      createOrUpdateFileFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── repos.deleteFile ────────────────────────────────────────────────────────

const deleteFileInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().min(1),
  message: z.string().min(1),
  sha: z.string().min(1),
  branch: z.string().optional(),
  committer: z.object({ name: z.string(), email: z.string() }).optional(),
  author: z.object({ name: z.string(), email: z.string() }).optional(),
});

export type DeleteFileInput = z.infer<typeof deleteFileInputSchema>;
export type DeleteFileOutput = Endpoints["DELETE /repos/{owner}/{repo}/contents/{path}"]["response"]["data"];

const deleteFileFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  path: observe.field<string>(),
  status: observe.number(),
});

export function deleteFile(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.deleteFile",
    transport,
    input: fromSafeParse(deleteFileInputSchema),
    output: passthrough<DeleteFileOutput>(),
    fields: deleteFileFields,
    run: async (input, tools, t) => {
      deleteFileFields.owner.set(input.owner);
      deleteFileFields.repo.set(input.repo);
      deleteFileFields.path.set(input.path);
      const { owner, repo, path, ...body } = input;
      const response = await t.request<DeleteFileOutput>(
        {
          method: "DELETE",
          path: `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      deleteFileFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── repos.createRef (create a branch / tag) ─────────────────────────────────

const createRefInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** Full ref, e.g. `refs/heads/feature-x` or `refs/tags/v1.0.0`. */
  ref: z.string().min(1),
  sha: z.string().min(1),
});

export type CreateRefInput = z.infer<typeof createRefInputSchema>;
export type CreateRefOutput = Endpoints["POST /repos/{owner}/{repo}/git/refs"]["response"]["data"];

const createRefFields = observe.fields({
  owner: observe.field<string>(),
  repo: observe.field<string>(),
  ref: observe.field<string>(),
  status: observe.number(),
});

export function createRef(transport: Transport) {
  return defineGithubOperation({
    name: "github.repos.createRef",
    transport,
    input: fromSafeParse(createRefInputSchema),
    output: passthrough<CreateRefOutput>(),
    fields: createRefFields,
    run: async (input, tools, t) => {
      createRefFields.owner.set(input.owner);
      createRefFields.repo.set(input.repo);
      createRefFields.ref.set(input.ref);
      const { owner, repo, ...body } = input;
      const response = await t.request<CreateRefOutput>(
        {
          method: "POST",
          path: `/repos/${owner}/${repo}/git/refs`,
          body,
          resource: "core",
          cacheable: false,
        },
        tools.signal,
      );
      createRefFields.status.set(response.status);
      return response.data;
    },
  });
}

// ── Internal: encode a path like "src/foo.ts" without breaking slashes ──────

function encodePath(path: string): string {
  // Encode each segment separately so slashes survive. This matches
  // GitHub's expectation: path is part of the URL hierarchy.
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

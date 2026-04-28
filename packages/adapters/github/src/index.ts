/**
 * `@phyxiusjs/github` — the GitHub connector for phyxius.
 *
 * Public surface, organized by what callers actually compose:
 *
 *   1. Configuration: `GithubConfig`, `GithubAuth` and friends.
 *   2. Transport: `createTransport(config)` — one transport per
 *      account, shared across operations.
 *   3. Operations: factory functions that take a transport and
 *      return a phyxius `HandlerSpec`. Spawn each one against your
 *      runtime and invoke as a function.
 *   4. Webhooks: `verifyWebhook(input)` for the receiver side.
 *   5. Pagination: `paginate` and `paginateGraphQL` for bounded
 *      iteration when an operation returns a single page.
 *   6. Errors: `GithubHttpError` for catching pre-translation,
 *      and re-exports of `ConnectorError` / `ConnectorFailure` /
 *      `isConnectorFailure` from `@phyxiusjs/connector` so callers
 *      don't need to import the upstream package directly.
 *
 * Example wiring (one transport, three operations):
 *
 *     import { createSystemClock, ms } from "@phyxiusjs/clock";
 *     import { Journal } from "@phyxiusjs/journal";
 *     import { spawn, type HandlerEvent } from "@phyxiusjs/handler";
 *     import {
 *       createTransport,
 *       getPullRequest,
 *       listPullRequestFiles,
 *       createPullRequestReview,
 *     } from "@phyxiusjs/github";
 *
 *     const clock = createSystemClock();
 *     const journal = new Journal<HandlerEvent>({ clock, maxEntries: 10_000 });
 *
 *     const transport = createTransport({
 *       config: {
 *         auth: { kind: "pat", token: process.env.GITHUB_TOKEN! },
 *       },
 *     });
 *
 *     const getPR = await spawn(getPullRequest(transport), { clock, journal });
 *     const listFiles = await spawn(listPullRequestFiles(transport), { clock, journal });
 *     const review = await spawn(createPullRequestReview(transport), { clock, journal });
 */

// ── Spine ────────────────────────────────────────────────────────────────────

export type {
  GithubAuth,
  GithubConfig,
  OAuthTokenStorage,
  OAuthTokenSnapshot,
  EtagCache,
  EtagCacheEntry,
  RateLimitBudget,
  RateLimitResource,
  RateLimitTracker,
  GithubErrorCategory,
  GraphQLError,
  VerifiedWebhookEvent,
} from "./types.js";
export { GithubHttpError } from "./types.js";

export { createEtagCache, type EtagCacheOptions } from "./etag-cache.js";
export { createRateLimitTracker } from "./rate-limits.js";
export { createAuthManager, type AuthContext, type AuthManager, type AuthManagerOptions } from "./auth.js";
export {
  createTransport,
  type Transport,
  type TransportOptions,
  type RequestInput,
  type ResponseEnvelope,
  type AcceptType,
  categorizeError,
} from "./transport.js";

export { mapGithubError } from "./mapError.js";

// ── Operation primitive ──────────────────────────────────────────────────────

export { defineGithubOperation, type GithubOperationOptions } from "./define-operation.js";

// ── Pagination utilities ────────────────────────────────────────────────────

export {
  parseLinkHeader,
  paginate,
  paginateGraphQL,
  type LinkRelations,
  type PageInfo,
  type FetchPage,
  type FetchGraphQLPage,
  type PaginateOptions,
} from "./pagination.js";

// ── Webhook receiver ────────────────────────────────────────────────────────

export {
  verifyWebhook,
  WebhookVerificationError,
  createInMemoryReplayStore,
  type ReplayStore,
  type ReplayStoreOptions,
  type VerifyWebhookInput,
  type VerifyWebhookOptions,
  type WebhookVerificationFailure,
} from "./webhooks.js";

// ── ConnectorError re-exports (so callers don't need a separate import) ─────

export { ConnectorFailure, isConnectorFailure, type ConnectorError, type ConnectorSpec } from "@phyxiusjs/connector";

// ── Operations: pulls ────────────────────────────────────────────────────────

export {
  getPullRequest,
  listPullRequests,
  listPullRequestFiles,
  getPullRequestDiff,
  listPullRequestReviewComments,
  createPullRequestReview,
  createPullRequestIssueComment,
  createPullRequest,
  updatePullRequest,
  mergePullRequest,
  requestReviewers,
  type GetPullRequestInput,
  type GetPullRequestOutput,
  type ListPullRequestsInput,
  type ListPullRequestsOutput,
  type ListPullRequestFilesInput,
  type ListPullRequestFilesOutput,
  type GetPullRequestDiffInput,
  type ListPullRequestReviewCommentsInput,
  type ListPullRequestReviewCommentsOutput,
  type CreatePullRequestReviewInput,
  type CreatePullRequestReviewOutput,
  type CreatePullRequestIssueCommentInput,
  type CreatePullRequestIssueCommentOutput,
  type CreatePullRequestInput,
  type CreatePullRequestOutput,
  type UpdatePullRequestInput,
  type UpdatePullRequestOutput,
  type MergePullRequestInput,
  type MergePullRequestOutput,
  type RequestReviewersInput,
  type RequestReviewersOutput,
} from "./operations/pulls.js";

// ── Operations: repos ───────────────────────────────────────────────────────

export {
  getRepo,
  listBranches,
  getBranch,
  listCommits,
  getCommit,
  getCommitDiff,
  compareCommits,
  getContents,
  getReadme,
  getTree,
  createOrUpdateFile,
  deleteFile,
  createRef,
  type GetRepoInput,
  type GetRepoOutput,
  type ListBranchesInput,
  type ListBranchesOutput,
  type GetBranchInput,
  type GetBranchOutput,
  type ListCommitsInput,
  type ListCommitsOutput,
  type GetCommitInput,
  type GetCommitOutput,
  type GetCommitDiffInput,
  type CompareCommitsInput,
  type CompareCommitsOutput,
  type GetContentsInput,
  type GetContentsOutput,
  type GetReadmeInput,
  type GetReadmeOutput,
  type GetTreeInput,
  type GetTreeOutput,
  type CreateOrUpdateFileInput,
  type CreateOrUpdateFileOutput,
  type DeleteFileInput,
  type DeleteFileOutput,
  type CreateRefInput,
  type CreateRefOutput,
} from "./operations/repos.js";

// ── Operations: issues ──────────────────────────────────────────────────────

export {
  listIssues,
  getIssue,
  createIssue,
  updateIssue,
  listIssueComments,
  addLabels,
  removeLabel,
  type ListIssuesInput,
  type ListIssuesOutput,
  type GetIssueInput,
  type GetIssueOutput,
  type CreateIssueInput,
  type CreateIssueOutput,
  type UpdateIssueInput,
  type UpdateIssueOutput,
  type ListIssueCommentsInput,
  type ListIssueCommentsOutput,
  type AddLabelsInput,
  type AddLabelsOutput,
  type RemoveLabelInput,
  type RemoveLabelOutput,
} from "./operations/issues.js";

// ── Operations: search ──────────────────────────────────────────────────────

export {
  searchCode,
  searchIssuesAndPullRequests,
  searchRepositories,
  searchUsers,
  type SearchCodeInput,
  type SearchCodeOutput,
  type SearchIssuesInput,
  type SearchIssuesOutput,
  type SearchReposInput,
  type SearchReposOutput,
  type SearchUsersInput,
  type SearchUsersOutput,
} from "./operations/search.js";

// ── Operations: graphql ─────────────────────────────────────────────────────

export { graphql, type GraphQLQueryInput, type GraphQLResponse } from "./operations/graphql.js";

// ── Operations: checks ──────────────────────────────────────────────────────

export {
  listChecksForRef,
  getCheckRun,
  getCombinedStatusForRef,
  createCheckRun,
  updateCheckRun,
  type ListChecksForRefInput,
  type ListChecksForRefOutput,
  type GetCheckRunInput,
  type GetCheckRunOutput,
  type GetCombinedStatusInput,
  type GetCombinedStatusOutput,
  type CreateCheckRunInput,
  type CreateCheckRunOutput,
  type UpdateCheckRunInput,
  type UpdateCheckRunOutput,
} from "./operations/checks.js";

// ── Operations: reactions ───────────────────────────────────────────────────

export {
  createReactionForIssueComment,
  createReactionForPullRequestReviewComment,
  createReactionForIssue,
  type CreateReactionForIssueCommentInput,
  type CreateReactionForIssueCommentOutput,
  type CreateReactionForPullRequestReviewCommentInput,
  type CreateReactionForPullRequestReviewCommentOutput,
  type CreateReactionForIssueInput,
  type CreateReactionForIssueOutput,
} from "./operations/reactions.js";

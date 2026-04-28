/**
 * GraphQL operation.
 *
 * GitHub's GraphQL API is often the right choice for queries that
 * would otherwise require many REST calls — fetching a PR plus its
 * reviews plus its commits plus its check runs in one request, for
 * example. The GraphQL endpoint has its own rate-limit budget
 * (point-based, not request-count: a single query can cost up to
 * 5000 points, and the budget refills 5000 points/hour).
 *
 * This operation is intentionally generic: caller supplies the
 * query and variables, gets back the typed `data` payload. The
 * transport layer detects `errors` in the response body and
 * surfaces them as `GithubHttpError(githubCategory: "graphql-errors")`,
 * which `mapGithubError` translates to VALIDATION (correct: re-
 * issuing the same query won't change the result).
 *
 * For typed wrappers around specific GraphQL queries, build them
 * on top of this operation. The connector itself doesn't ship
 * pre-baked queries because each application's query catalog is
 * its own concern.
 */

import { observe } from "@phyxiusjs/observe";
import { fromSafeParse, passthrough } from "@phyxiusjs/validate";
import { z } from "zod";

import { defineGithubOperation } from "../define-operation.js";
import type { Transport } from "../transport.js";

// ── graphql.query ───────────────────────────────────────────────────────────

const graphqlInputSchema = z.object({
  query: z.string().min(1),
  variables: z.record(z.unknown()).optional(),
});

export type GraphQLQueryInput = z.infer<typeof graphqlInputSchema>;

/**
 * The shape every successful GraphQL response has. `data` is the
 * caller-shaped payload; the connector returns `data` typed as
 * whatever generic the caller specifies. When `errors` is present
 * the transport throws before we get here, so this type doesn't
 * need to model it.
 */
export interface GraphQLResponse<TData> {
  readonly data: TData;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

const graphqlFields = observe.fields({
  queryChars: observe.number(),
  variableCount: observe.number(),
  status: observe.number(),
});

/**
 * Generic GraphQL operation. Callers parameterize the response
 * type at the call site:
 *
 *     const queryUser = await spawn(graphql<{ viewer: { login: string } }>(transport), runtime);
 *     const result = await queryUser({ query: 'query { viewer { login } }' });
 *     // result.data.viewer.login is typed
 *
 * The default execution uses POST to the GraphQL endpoint with the
 * standard JSON body. Caller's `variables` map is sent as-is.
 */
export function graphql<TData = unknown>(transport: Transport) {
  return defineGithubOperation({
    name: "github.graphql.query",
    transport,
    input: fromSafeParse(graphqlInputSchema),
    output: passthrough<GraphQLResponse<TData>>(),
    fields: graphqlFields,
    run: async (input, tools, t) => {
      graphqlFields.queryChars.set(input.query.length);
      graphqlFields.variableCount.set(Object.keys(input.variables ?? {}).length);
      // Build body inline so we send `{ query, variables? }` —
      // GraphQL endpoint dislikes a literal `variables: undefined`.
      const body: { query: string; variables?: Record<string, unknown> } = { query: input.query };
      if (input.variables !== undefined) body.variables = input.variables;
      const response = await t.request<GraphQLResponse<TData>>(
        {
          method: "POST",
          path: "",
          baseUrl: t.graphqlUrl,
          body,
          resource: "graphql",
          cacheable: false,
        },
        tools.signal,
      );
      graphqlFields.status.set(response.status);
      return response.data;
    },
  });
}

/**
 * Pagination idioms for GitHub.
 *
 * GitHub's REST API uses RFC 5988 Link headers for pagination. Each
 * paginated response carries a `Link` header like:
 *
 *   Link: <https://api.github.com/repos/o/r/issues?page=2>; rel="next",
 *         <https://api.github.com/repos/o/r/issues?page=42>; rel="last",
 *         <https://api.github.com/repos/o/r/issues?page=1>; rel="first"
 *
 * Some endpoints use cursor-based pagination via the same Link
 * header but with `before` / `after` query parameters instead of
 * `page`. The Link header parsing is identical; the iteration
 * loop just uses whatever URL the server hands back.
 *
 * GraphQL connections are paginated with `pageInfo { endCursor,
 * hasNextPage }` in the response body. That's per-query and doesn't
 * use Link headers.
 *
 * Activity feeds (events, notifications) often use a `?since=<ISO>`
 * query parameter to fetch only newer items than a known timestamp.
 * That's not pagination per se — it's incremental sync — but lives
 * here for completeness.
 *
 * `sd-no-unboundedness` applied: this module does NOT auto-paginate.
 * The connector exposes utilities for the application to paginate
 * with explicit bounds. Auto-pagination of a 5000-item issue list
 * is exactly the unbounded-loop failure mode the framework refuses
 * to silently produce.
 */

// ── Link header parsing ─────────────────────────────────────────────────────

/**
 * Parsed Link relations. Only the four standard rels are surfaced;
 * non-standard rels are silently dropped (we've never seen GitHub
 * emit one, but the parser is robust to it).
 */
export interface LinkRelations {
  readonly next?: string;
  readonly prev?: string;
  readonly first?: string;
  readonly last?: string;
}

/**
 * Parse an RFC 5988 Link header value. Returns an object with the
 * four standard rel URLs that were present; missing rels are
 * undefined.
 *
 * Robust to:
 *   - extra whitespace between commas
 *   - rel values with or without quotes
 *   - URLs containing commas inside angle brackets
 *   - additional parameters (e.g., `; type="application/json"`)
 *
 * Returns an empty object for null / undefined / empty / malformed
 * input.
 */
export function parseLinkHeader(header: string | null | undefined): LinkRelations {
  if (header === null || header === undefined) return {};
  const trimmed = header.trim();
  if (trimmed.length === 0) return {};

  const result: { next?: string; prev?: string; first?: string; last?: string } = {};

  // Split on commas that are NOT inside angle brackets. We do this
  // by scanning rather than regex-splitting because URLs commonly
  // contain commas.
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "<") depth += 1;
    else if (ch === ">") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(trimmed.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(trimmed.slice(start));

  for (const part of parts) {
    const segment = part.trim();
    if (segment.length === 0) continue;
    const urlEnd = segment.indexOf(">");
    if (segment[0] !== "<" || urlEnd < 0) continue;
    const url = segment.slice(1, urlEnd);
    const params = segment.slice(urlEnd + 1);
    const rel = extractRel(params);
    if (rel === undefined) continue;
    if (rel === "next" || rel === "prev" || rel === "first" || rel === "last") {
      result[rel] = url;
    }
  }

  return result;
}

function extractRel(params: string): string | undefined {
  // Match `rel="value"` or `rel=value` (RFC allows both).
  const match = /(?:^|;)\s*rel\s*=\s*("?)([^";\s]+)\1/i.exec(params);
  if (match === null) return undefined;
  return match[2];
}

// ── Bounded iteration over Link-paginated endpoints ─────────────────────────

/**
 * The shape of a single paginated request the iterator drives.
 * The operation wraps `transport.request` with whatever input
 * shape it needs; the iterator just calls `fetchPage` repeatedly,
 * giving it the URL of the next page each iteration.
 */
export type FetchPage<TItem> = (
  url: string,
) => Promise<{ readonly items: ReadonlyArray<TItem>; readonly linkHeader: string | null }>;

export interface PaginateOptions {
  /**
   * Hard upper bound on the number of pages to fetch. Default: 10.
   * Set higher when the caller has thought about the total request
   * cost; never set to Infinity (per `sd-no-unboundedness`).
   */
  readonly maxPages?: number;

  /**
   * Hard upper bound on the total items collected across pages.
   * Default: 1000. Stops mid-page when reached, returning a partial
   * final page.
   */
  readonly maxItems?: number;
}

/**
 * Paginate a Link-header-driven endpoint with explicit bounds.
 * Returns the concatenated items across all fetched pages plus a
 * boolean indicating whether more pages were available beyond the
 * bound.
 *
 * The bounds are not optional in spirit — the defaults exist so the
 * common case has a sensible cap, not because unbounded pagination
 * is acceptable. Callers that want to enumerate a large list
 * should set maxPages explicitly with a number they've reasoned
 * about.
 */
export async function paginate<TItem>(
  initialUrl: string,
  fetchPage: FetchPage<TItem>,
  options: PaginateOptions = {},
): Promise<{ readonly items: ReadonlyArray<TItem>; readonly hasMore: boolean }> {
  const maxPages = options.maxPages ?? 10;
  const maxItems = options.maxItems ?? 1000;
  if (maxPages <= 0) {
    throw new Error(`paginate: maxPages must be positive, got ${maxPages}`);
  }
  if (maxItems <= 0) {
    throw new Error(`paginate: maxItems must be positive, got ${maxItems}`);
  }

  const collected: TItem[] = [];
  let url: string | undefined = initialUrl;
  let pages = 0;
  let hasMore = false;

  while (url !== undefined && pages < maxPages) {
    const { items, linkHeader } = await fetchPage(url);
    pages += 1;

    for (const item of items) {
      if (collected.length >= maxItems) {
        hasMore = true;
        break;
      }
      collected.push(item);
    }

    if (collected.length >= maxItems) break;

    const {next} = parseLinkHeader(linkHeader);
    if (next === undefined) {
      // Server reports no further pages.
      url = undefined;
    } else {
      url = next;
      if (pages >= maxPages) {
        // We're stopping because of the page bound, not because we
        // ran out — flag hasMore.
        hasMore = true;
      }
    }
  }

  return { items: collected, hasMore };
}

// ── GraphQL cursor pagination ───────────────────────────────────────────────

/**
 * Standard GraphQL Connection pageInfo shape per the Relay spec
 * that GitHub follows.
 */
export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage?: boolean;
  readonly endCursor?: string | null;
  readonly startCursor?: string | null;
}

export type FetchGraphQLPage<TItem> = (
  cursor: string | undefined,
) => Promise<{ readonly items: ReadonlyArray<TItem>; readonly pageInfo: PageInfo }>;

/**
 * GraphQL cursor-driven pagination with explicit bounds. Same
 * shape and discipline as `paginate` — bounded by default,
 * surfaces hasMore truthfully when stopping because of a bound
 * versus because the server signaled completion.
 */
export async function paginateGraphQL<TItem>(
  fetchPage: FetchGraphQLPage<TItem>,
  options: PaginateOptions = {},
): Promise<{ readonly items: ReadonlyArray<TItem>; readonly hasMore: boolean }> {
  const maxPages = options.maxPages ?? 10;
  const maxItems = options.maxItems ?? 1000;
  if (maxPages <= 0) {
    throw new Error(`paginateGraphQL: maxPages must be positive, got ${maxPages}`);
  }
  if (maxItems <= 0) {
    throw new Error(`paginateGraphQL: maxItems must be positive, got ${maxItems}`);
  }

  const collected: TItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let hasMore = false;

  while (pages < maxPages) {
    const { items, pageInfo } = await fetchPage(cursor);
    pages += 1;

    for (const item of items) {
      if (collected.length >= maxItems) {
        hasMore = true;
        break;
      }
      collected.push(item);
    }

    if (collected.length >= maxItems) break;
    if (!pageInfo.hasNextPage) break;
    if (pageInfo.endCursor === undefined || pageInfo.endCursor === null) break;

    cursor = pageInfo.endCursor;

    if (pages >= maxPages) {
      hasMore = true;
    }
  }

  return { items: collected, hasMore };
}

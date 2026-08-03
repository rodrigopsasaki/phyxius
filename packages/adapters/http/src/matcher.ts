import type { HttpMethod, HttpRoute, MatchResult } from "./types.js";

// ── Pattern compilation ────────────────────────────────────────────────────

/**
 * Compiled route pattern. Segments are either literal strings or `:param`
 * placeholders; params are extracted into a name map at match time.
 *
 * No wildcards, no regex, no optional segments — deliberate minimalism. If a
 * route needs richer matching, decode it from a broader pattern and inspect
 * inside the handler.
 */
export interface CompiledPattern {
  readonly method: HttpMethod;
  readonly segments: ReadonlyArray<Segment>;
  /** Static segment count — higher = more specific, used for sort ordering. */
  readonly staticCount: number;
}

export type Segment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

export function compilePattern(method: HttpMethod, path: string): CompiledPattern {
  if (!path.startsWith("/")) {
    throw new Error(`HTTP route path must start with "/" (got ${JSON.stringify(path)})`);
  }

  const raw = path.slice(1); // drop leading /
  const parts = raw === "" ? [] : raw.split("/");
  const segments: Segment[] = [];
  let staticCount = 0;

  for (const part of parts) {
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (name.length === 0) {
        throw new Error(`Empty param name in path "${path}"`);
      }
      segments.push({ kind: "param", name });
    } else {
      segments.push({ kind: "literal", value: part });
      staticCount += 1;
    }
  }

  return { method, segments, staticCount };
}

// ── Matching ───────────────────────────────────────────────────────────────

/**
 * Match a method+path against a compiled pattern. Returns the extracted
 * params on success, or `null` on mismatch.
 */
export function matchPattern(
  pattern: CompiledPattern,
  method: HttpMethod,
  path: string,
): Record<string, string> | null {
  if (pattern.method !== method) return null;

  const parts = path.startsWith("/") ? path.slice(1).split("/") : path.split("/");
  // Handle leading / edge case: "/" produces parts = [""]; normalize.
  const normalized = parts.length === 1 && parts[0] === "" ? [] : parts;

  if (normalized.length !== pattern.segments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.segments.length; i++) {
    const segment = pattern.segments[i];
    const part = normalized[i];
    if (!segment || part === undefined) return null;

    if (segment.kind === "literal") {
      if (segment.value !== part) return null;
    } else {
      params[segment.name] = decodeURIComponent(part);
    }
  }

  return params;
}

// ── Route table ────────────────────────────────────────────────────────────

/**
 * Pairs compiled patterns with their routes. Sorted by specificity so that
 * more specific routes (more literal segments) match first.
 */
export interface CompiledRoutes {
  readonly entries: ReadonlyArray<{
    readonly pattern: CompiledPattern;
    readonly route: HttpRoute<unknown, unknown>;
  }>;
}

export function compileRoutes(routes: ReadonlyArray<HttpRoute<unknown, unknown>>): CompiledRoutes {
  const entries = routes.map((route) => ({
    pattern: compilePattern(route.method, route.path),
    route,
  }));

  // Sort: more specific first. Tiebreak by longer paths first.
  entries.sort((a, b) => {
    if (b.pattern.staticCount !== a.pattern.staticCount) {
      return b.pattern.staticCount - a.pattern.staticCount;
    }
    return b.pattern.segments.length - a.pattern.segments.length;
  });

  return { entries };
}

export function matchRoute(compiled: CompiledRoutes, method: HttpMethod, path: string): MatchResult {
  let pathMatchedAnyMethod = false;

  for (const entry of compiled.entries) {
    // The real check: this entry's OWN declared method against the request.
    const result = matchPattern(entry.pattern, method, path);
    if (result !== null) {
      return { found: true, route: entry.route, params: result };
    }

    // No match — was it the method, or the path? Re-check with the entry's
    // own method (trivially true) to test the path shape alone; a path-only
    // match on a DIFFERENT method flags 405-candidacy without ever treating
    // this entry as a real match for the request.
    if (!pathMatchedAnyMethod && matchPattern(entry.pattern, entry.pattern.method, path) !== null) {
      pathMatchedAnyMethod = true;
    }
  }

  return pathMatchedAnyMethod ? { found: false, reason: "method_not_allowed" } : { found: false, reason: "not_found" };
}

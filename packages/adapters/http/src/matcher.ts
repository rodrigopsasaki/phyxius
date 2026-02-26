import type { HttpMethod, RoutePattern, RouteParams, MatchResult, HttpRoute } from "./types.js";

/**
 * Parse a path string into a compiled RoutePattern.
 * Supports:
 *   - Static segments: `/users/profile`
 *   - Named parameters: `/users/:id`
 *   - Wildcards: `/files/*rest`
 *
 * Specificity ordering: static (+100/segment) > parameterized (-50/param) > wildcard (-1000)
 *
 * @throws Never — returns null on invalid paths; callers should validate paths upfront.
 */
export function parseRoutePattern(method: HttpMethod, path: string): RoutePattern | null {
  if (!path.startsWith("/")) {
    return null;
  }

  const segments = path.split("/").filter(Boolean);
  const paramNames: string[] = [];
  const seenNames = new Set<string>();
  const regexParts: string[] = ["^"];

  let specificity = 0;

  // Handle root path
  if (path === "/") {
    regexParts.push("/?$");
    return {
      method,
      path,
      specificity,
      paramNames: Object.freeze(paramNames),
      pathRegex: new RegExp(regexParts.join("")),
    };
  }

  for (let i = 0; i < segments.length; i++) {
    regexParts.push("/");
    const segment = segments[i]!;

    if (segment.startsWith(":")) {
      const paramName = segment.slice(1);
      if (!paramName || seenNames.has(paramName)) {
        return null;
      }
      seenNames.add(paramName);
      paramNames.push(paramName);
      regexParts.push("([^/]+)");
      // Parameterized segments reduce specificity
    } else if (segment.startsWith("*")) {
      const paramName = segment.slice(1) || "wildcard";
      if (seenNames.has(paramName)) {
        return null;
      }
      seenNames.add(paramName);
      paramNames.push(paramName);
      regexParts.push("(.*)");
      specificity -= 1000;
      break; // Wildcard must be last
    } else {
      regexParts.push(escapeRegex(segment));
      specificity += 100;
    }
  }

  regexParts.push("$");

  // Apply segment count bonus and param penalty
  specificity += segments.length * 10;
  specificity -= paramNames.length * 50;

  return {
    method,
    path,
    specificity,
    paramNames: Object.freeze(paramNames),
    pathRegex: new RegExp(regexParts.join("")),
  };
}

/**
 * Match a request method + path against a compiled RoutePattern.
 * Returns extracted params on match, null on miss.
 */
export function matchPattern(pattern: RoutePattern, method: HttpMethod, path: string): RouteParams | null {
  if (pattern.method !== method) {
    return null;
  }

  const match = pattern.pathRegex.exec(path);
  if (!match) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.paramNames.length; i++) {
    const name = pattern.paramNames[i]!;
    const value = match[i + 1];
    if (value !== undefined) {
      params[name] = decodeURIComponent(value);
    }
  }

  return Object.freeze(params);
}

/**
 * Compare two RoutePatterns for specificity-descending sort.
 * Higher specificity routes are matched first.
 */
export function compareSpecificity(a: RoutePattern, b: RoutePattern): number {
  return b.specificity - a.specificity;
}

/**
 * Match an incoming method + path against a sorted list of compiled routes.
 * Returns the match result — found with params, 404, or 405.
 */
export function matchRoutes(
  sortedRoutes: ReadonlyArray<{ pattern: RoutePattern; route: HttpRoute }>,
  method: HttpMethod,
  path: string,
): MatchResult {
  let pathMatchedOnDifferentMethod = false;

  for (const { pattern, route } of sortedRoutes) {
    // Check if path matches ignoring method first (for 405 detection)
    const pathOnlyMatch = pattern.pathRegex.exec(path);
    if (pathOnlyMatch) {
      pathMatchedOnDifferentMethod = true;
      const params = matchPattern(pattern, method, path);
      if (params !== null) {
        return { found: true, route, params };
      }
    }
  }

  return {
    found: false,
    reason: pathMatchedOnDifferentMethod ? "method_not_allowed" : "not_found",
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

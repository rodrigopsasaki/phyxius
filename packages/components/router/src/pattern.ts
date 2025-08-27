import type { RoutePattern, RouteParams, HttpMethod, RouterResult } from "./types.js";
import { ok, err } from "@phyxiusjs/fp";
import { RouterError } from "./types.js";

export function parseRoutePattern(method: HttpMethod, path: string): RouterResult<RoutePattern> {
  if (!path.startsWith("/")) {
    return err(new RouterError(`Route path must start with '/': ${path}`, "INVALID_ROUTE_PATTERN", { method, path }));
  }

  const segments = path.split("/").filter(Boolean);
  const paramNames: string[] = [];
  const regexParts: string[] = ["^"];

  let specificity = 0;

  // Pre-validate parameter names to catch duplicates
  const allParamNames: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(":")) {
      const paramName = segment.slice(1);
      if (!paramName) {
        return err(
          new RouterError(`Invalid parameter name in path: ${path}`, "INVALID_ROUTE_PATTERN", {
            method,
            path,
            segment,
          }),
        );
      }
      if (allParamNames.includes(paramName)) {
        return err(
          new RouterError(`Duplicate parameter name '${paramName}' in path: ${path}`, "INVALID_ROUTE_PATTERN", {
            method,
            path,
            paramName,
          }),
        );
      }
      allParamNames.push(paramName);
    } else if (segment.startsWith("*")) {
      const paramName = segment.slice(1) || "wildcard";
      if (allParamNames.includes(paramName)) {
        return err(
          new RouterError(`Duplicate parameter name '${paramName}' in path: ${path}`, "INVALID_ROUTE_PATTERN", {
            method,
            path,
            paramName,
          }),
        );
      }
      allParamNames.push(paramName);
    }
  }

  // Handle root route specially
  if (path === "/") {
    regexParts.push("/");
  }

  for (let i = 0; i < segments.length; i++) {
    regexParts.push("/");
    const segment = segments[i]!;

    if (segment.startsWith(":")) {
      const paramName = segment.slice(1);
      if (!paramName) {
        return err(
          new RouterError(`Invalid parameter name in path: ${path}`, "INVALID_ROUTE_PATTERN", {
            method,
            path,
            segment,
          }),
        );
      }
      if (paramNames.includes(paramName)) {
        return err(
          new RouterError(`Duplicate parameter name '${paramName}' in path: ${path}`, "INVALID_ROUTE_PATTERN", {
            method,
            path,
            paramName,
          }),
        );
      }
      paramNames.push(paramName);
      regexParts.push("([^/]+)");
    } else if (segment.startsWith("*")) {
      const paramName = segment.slice(1) || "wildcard";
      if (paramNames.includes(paramName)) {
        return err(
          new RouterError(`Duplicate parameter name '${paramName}' in path: ${path}`, "INVALID_ROUTE_PATTERN", {
            method,
            path,
            paramName,
          }),
        );
      }
      paramNames.push(paramName);
      regexParts.push("(.*)");
      specificity -= 1000;
      break;
    } else {
      regexParts.push(escapeRegex(segment));
      specificity += 100;
    }
  }

  regexParts.push("$");
  const pathRegex = new RegExp(regexParts.join(""));

  specificity += segments.length * 10;
  specificity -= paramNames.length * 50;

  return ok({
    method,
    path,
    specificity,
    paramNames: Object.freeze(paramNames),
    pathRegex,
  } as const);
}

export function matchRoute(pattern: RoutePattern, method: HttpMethod, path: string): RouteParams | null {
  if (pattern.method !== method) {
    return null;
  }

  const match = pattern.pathRegex.exec(path);
  if (!match) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.paramNames.length; i++) {
    const paramName = pattern.paramNames[i]!;
    const paramValue = match[i + 1];
    if (paramValue !== undefined) {
      params[paramName] = decodeURIComponent(paramValue);
    }
  }

  return Object.freeze(params);
}

export function compareRouteSpecificity(a: RoutePattern, b: RoutePattern): number {
  return b.specificity - a.specificity;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

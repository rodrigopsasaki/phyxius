import { ok, err, type Result } from "@phyxiusjs/fp";
import type { ConfigError, EnvParserOptions } from "../types.js";

/**
 * Parse environment variables into nested configuration object
 */
export function parseEnv(
  envVars: NodeJS.ProcessEnv,
  options: EnvParserOptions = {},
): Result<Record<string, unknown>, ConfigError> {
  const { prefix = "", convention = "dbt", delimiter = "_" } = options;

  try {
    const filtered = filterEnvVars(envVars, prefix);

    if (convention === "dbt") {
      return ok(parseDBTConvention(filtered, prefix));
    } else {
      return ok(parseFlatConvention(filtered, prefix, delimiter));
    }
  } catch (error) {
    return err({
      type: "PARSE_ERROR",
      source: "environment",
      message: error instanceof Error ? error.message : "Failed to parse environment variables",
    });
  }
}

/**
 * Filter environment variables by prefix
 */
function filterEnvVars(envVars: NodeJS.ProcessEnv, prefix: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    if (value !== undefined && key.startsWith(prefix)) {
      // Remove prefix from key
      const cleanKey = prefix ? key.slice(prefix.length) : key;
      result[cleanKey] = value;
    }
  }

  return result;
}

/**
 * Parse dbt-style double underscore convention
 * SERVER__PORT=3000 -> { server: { port: 3000 } }
 */
function parseDBTConvention(envVars: Record<string, string>, _prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(envVars)) {
    // Split by double underscore
    const pathParts = key.split("__");

    // Convert each part from SCREAMING_SNAKE to camelCase
    const camelParts = pathParts.map((part) => snakeToCamel(part));

    // Build nested object
    setNestedValue(result, camelParts, parseValue(value));
  }

  return result;
}

/**
 * Parse flat convention with custom delimiter
 * SERVER_PORT=3000 -> { serverPort: 3000 }
 */
function parseFlatConvention(
  envVars: Record<string, string>,
  _prefix: string,
  _delimiter: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(envVars)) {
    // Convert entire key to camelCase
    const camelKey = snakeToCamel(key);
    result[camelKey] = parseValue(value);
  }

  return result;
}

/**
 * Convert SCREAMING_SNAKE_CASE to camelCase
 */
function snakeToCamel(str: string): string {
  return str.toLowerCase().replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Parse string value to appropriate type
 */
function parseValue(value: string): unknown {
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;

  // Null/undefined
  if (value === "null") return null;
  if (value === "undefined") return undefined;

  // Empty string
  if (value === "") return "";

  // Number (including floats and negative numbers)
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    // Check for safe integer range
    if (!Number.isNaN(num) && Number.isFinite(num)) {
      return num;
    }
  }

  // Array notation (check for numeric index pattern)
  // This will be handled by setNestedValue when it sees numeric keys

  // Default to string
  return value;
}

/**
 * Set a value in a nested object structure
 */
function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return;

  let current: Record<string, unknown> = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (key === undefined || nextKey === undefined) continue;

    // Check if next key is numeric (array index)
    const isNextNumeric = /^\d+$/.test(nextKey);

    if (!(key in current)) {
      current[key] = isNextNumeric ? [] : {};
    } else if (isNextNumeric && !Array.isArray(current[key])) {
      current[key] = [];
    } else if (!isNextNumeric && Array.isArray(current[key])) {
      current[key] = {};
    }

    current = current[key] as Record<string, unknown>;
  }

  const lastKey = path[path.length - 1];
  if (lastKey === undefined) return;

  // Handle array index
  if (/^\d+$/.test(lastKey)) {
    const index = parseInt(lastKey, 10);
    if (Array.isArray(current)) {
      while (current.length <= index) {
        current.push(undefined);
      }
      current[index] = value;
    } else {
      current[lastKey] = value;
    }
  } else {
    current[lastKey] = value;
  }
}

/**
 * Generate environment variable example from schema paths
 */
export function generateEnvExample(
  paths: Array<{ path: string; type: string; required: boolean; defaultValue?: unknown }>,
  options: EnvParserOptions = {},
): string {
  const { prefix = "", convention = "dbt" } = options;
  const lines: string[] = [];

  lines.push("# Generated environment variable example");
  lines.push(`# Convention: ${convention === "dbt" ? "dbt (double underscore)" : "flat"}`);
  if (prefix) {
    lines.push(`# Prefix: ${prefix}`);
  }
  lines.push("");

  for (const { path, type, required, defaultValue } of paths) {
    const envKey = pathToEnvKey(path, convention, prefix);
    const value = defaultValue !== undefined ? String(defaultValue) : "";
    const comment = `# ${path}: ${type}${required ? " (required)" : ""}`;

    lines.push(comment);
    lines.push(`${envKey}=${value}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Convert dot notation path to environment variable key
 */
function pathToEnvKey(path: string, convention: "dbt" | "flat", prefix: string): string {
  const parts = path.split(".");

  if (convention === "dbt") {
    // Convert to SCREAMING_SNAKE_CASE with double underscore
    const screamingParts = parts.map((part) => camelToScreamingSnake(part));
    return prefix + screamingParts.join("__");
  } else {
    // Flat convention - join with underscore
    const screamingParts = parts.map((part) => camelToScreamingSnake(part));
    return prefix + screamingParts.join("_");
  }
}

/**
 * Convert camelCase to SCREAMING_SNAKE_CASE
 */
function camelToScreamingSnake(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

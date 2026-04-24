import { ok, err, type Result } from "@phyxiusjs/fp";
import { readFileSync, existsSync } from "fs";
import { extname } from "path";
import type { ConfigError, FileLoaderOptions } from "../types.js";
import { parseEnv } from "./env.js";

/**
 * Load and parse configuration from a file.
 *
 * Supported formats:
 *   - **json** — valid JSON object at the root
 *   - **env** — KEY=VALUE lines (same parser as `parseEnv`)
 *
 * YAML is NOT supported: a correct YAML implementation is beyond the scope
 * of a config primitive. If you need YAML, pre-process with `js-yaml` and
 * pass the result as `{ type: "object", data: ... }`.
 */
export function loadFile(path: string, options: FileLoaderOptions = {}): Result<Record<string, unknown>, ConfigError> {
  const { format, encoding = "utf-8" } = options;

  if (!existsSync(path)) {
    return err({ type: "FILE_NOT_FOUND", path });
  }

  let content: string;
  try {
    content = readFileSync(path, encoding);
  } catch (error) {
    return err({
      type: "SOURCE_ERROR",
      source: path,
      message: error instanceof Error ? error.message : "Failed to read file",
      cause: error,
    });
  }

  const detected = format ?? detectFormat(path);
  switch (detected) {
    case "json":
      return parseJSON(content);
    case "env":
      return parseDotEnv(content);
    default:
      return err({
        type: "PARSE_ERROR",
        source: path,
        message: `Unsupported file format: ${detected}. Use .json or .env, or preprocess other formats and pass as { type: "object" }.`,
      });
  }
}

function detectFormat(path: string): "json" | "env" | "unknown" {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".env") return "env";
  // Allow filenames like ".env.production"
  if (path.includes(".env")) return "env";
  return "unknown";
}

function parseJSON(content: string): Result<Record<string, unknown>, ConfigError> {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    return err({
      type: "PARSE_ERROR",
      source: "json",
      message: error instanceof Error ? error.message : "Invalid JSON",
    });
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return err({
      type: "PARSE_ERROR",
      source: "json",
      message: "JSON root must be an object",
    });
  }

  return ok(data as Record<string, unknown>);
}

function parseDotEnv(content: string): Result<Record<string, unknown>, ConfigError> {
  const envVars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    // Strip surrounding quotes if both ends match
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    envVars[key] = value;
  }

  // Delegate to env parser with dbt convention — treats DOUBLE__UNDERSCORES
  // as nesting and coerces "true"/"false"/numbers.
  return parseEnv(envVars as NodeJS.ProcessEnv, { convention: "dbt" });
}

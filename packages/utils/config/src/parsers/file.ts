import { ok, err, type Result } from "@phyxiusjs/fp";
import { readFileSync, existsSync } from "fs";
import { extname } from "path";
import type { ConfigError, FileLoaderOptions } from "../types";
import { parseEnv } from "./env";

/**
 * Load and parse configuration from file
 */
export function loadFile(
  path: string,
  options: FileLoaderOptions = {}
): Result<Record<string, unknown>, ConfigError> {
  const { format, encoding = "utf-8" } = options;

  // Check if file exists
  if (!existsSync(path)) {
    return err({
      type: "FILE_NOT_FOUND",
      path
    });
  }

  try {
    const content = readFileSync(path, encoding);
    const detectedFormat = format || detectFormat(path);

    switch (detectedFormat) {
      case "json":
        return parseJSON(content);
      case "yaml":
        return parseYAML(content);
      case "env":
        return parseDotEnv(content);
      default:
        return err({
          type: "PARSE_ERROR",
          source: path,
          message: `Unsupported file format: ${detectedFormat}`
        });
    }
  } catch (error) {
    return err({
      type: "SOURCE_ERROR",
      source: path,
      message: error instanceof Error ? error.message : "Failed to load file",
      cause: error
    });
  }
}

/**
 * Detect file format from extension
 */
function detectFormat(path: string): "json" | "yaml" | "env" | "unknown" {
  const ext = extname(path).toLowerCase();
  
  switch (ext) {
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".env":
      return "env";
    default:
      // Try to detect from filename
      if (path.includes(".env")) {
        return "env";
      }
      return "unknown";
  }
}

/**
 * Parse JSON content
 */
function parseJSON(content: string): Result<Record<string, unknown>, ConfigError> {
  try {
    const data = JSON.parse(content);
    
    if (typeof data !== "object" || data === null) {
      return err({
        type: "PARSE_ERROR",
        source: "json",
        message: "JSON must be an object"
      });
    }
    
    // Check for circular references
    const checkResult = checkCircularReferences(data);
    if (checkResult._tag === "Err") {
      return checkResult;
    }
    
    return ok(data as Record<string, unknown>);
  } catch (error) {
    return err({
      type: "PARSE_ERROR",
      source: "json",
      message: error instanceof Error ? error.message : "Invalid JSON"
    });
  }
}

/**
 * Parse YAML content
 */
function parseYAML(content: string): Result<Record<string, unknown>, ConfigError> {
  // Simple YAML parser for basic use cases
  // For production, you'd want to use a proper YAML library
  try {
    const lines = content.split("\n");
    const result: Record<string, unknown> = {};
    const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
      { obj: result, indent: -1 }
    ];
    
    for (const line of lines) {
      // Skip empty lines and comments
      if (!line.trim() || line.trim().startsWith("#")) {
        continue;
      }
      
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();
      
      // Handle key-value pairs
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex === -1) continue;
      
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();
      
      // Pop stack to current indent level
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      
      const current = stack[stack.length - 1].obj;
      
      if (value) {
        // Simple value
        current[key] = parseYAMLValue(value);
      } else {
        // Nested object
        const nested: Record<string, unknown> = {};
        current[key] = nested;
        stack.push({ obj: nested, indent });
      }
    }
    
    return ok(result);
  } catch (error) {
    return err({
      type: "PARSE_ERROR",
      source: "yaml",
      message: error instanceof Error ? error.message : "Invalid YAML"
    });
  }
}

/**
 * Parse YAML value
 */
function parseYAMLValue(value: string): unknown {
  // Remove quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;
  
  // Null
  if (value === "null" || value === "~") return null;
  
  // Number
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (!Number.isNaN(num) && Number.isFinite(num)) {
      return num;
    }
  }
  
  // Array (simple case)
  if (value.startsWith("[") && value.endsWith("]")) {
    const items = value.slice(1, -1).split(",").map(item => parseYAMLValue(item.trim()));
    return items;
  }
  
  return value;
}

/**
 * Parse .env file content
 */
function parseDotEnv(content: string): Result<Record<string, unknown>, ConfigError> {
  const lines = content.split("\n");
  const envVars: Record<string, string> = {};
  
  for (const line of lines) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    
    // Parse KEY=VALUE format
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    envVars[key] = value;
  }
  
  // Use env parser with dbt convention for .env files
  return parseEnv(envVars as NodeJS.ProcessEnv, { convention: "dbt" });
}

/**
 * Check for circular references in object
 */
function checkCircularReferences(
  obj: unknown,
  seen = new WeakSet()
): Result<void, ConfigError> {
  if (obj === null || typeof obj !== "object") {
    return ok(undefined);
  }
  
  if (seen.has(obj)) {
    return err({
      type: "CIRCULAR_REFERENCE",
      path: "unknown"
    });
  }
  
  seen.add(obj);
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = checkCircularReferences(item, seen);
      if (result._tag === "Err") return result;
    }
  } else {
    for (const value of Object.values(obj)) {
      const result = checkCircularReferences(value, seen);
      if (result._tag === "Err") return result;
    }
  }
  
  return ok(undefined);
}
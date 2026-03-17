import { ok, err, type Result } from "@phyxiusjs/fp";
import type { ConfigSource, ConfigError, ConfigLoader } from "./types";
import { parseEnv } from "./parsers/env";
import { loadFile } from "./parsers/file";
import { watchFile, unwatchFile, type Stats } from "fs";

/**
 * Create a config loader for all source types
 */
export function createLoader(): ConfigLoader {
  return {
    load(source: ConfigSource): Result<unknown, ConfigError> {
      switch (source.type) {
        case "env":
          return parseEnv(process.env, {
            prefix: source.prefix,
            convention: source.convention
          });
          
        case "file":
          return loadFile(source.path, {
            format: source.format
          });
          
        case "object":
          return ok(source.data);
          
        case "defaults":
          // Defaults are extracted from schema, return empty object
          return ok({});
          
        default:
          return err({
            type: "SOURCE_ERROR",
            source: "unknown",
            message: `Unknown source type`
          });
      }
    },

    watch(source: ConfigSource, callback: (data: unknown) => void): () => void {
      if (source.type !== "file") {
        // Only file sources can be watched
        return () => {};
      }

      let debounceTimer: ReturnType<typeof setTimeout> | undefined;

      const handleChange = () => {
        // Debounce rapid changes
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          const result = loadFile(source.path, {
            format: source.format
          });

          if (result._tag === "Ok") {
            callback(result.value);
          }
        }, 20);
      };

      // Use polling via watchFile for reliable cross-platform file change detection
      const handleStatChange = (curr: Stats, prev: Stats) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
          handleChange();
        }
      };

      try {
        watchFile(source.path, { interval: 5, persistent: false }, handleStatChange);
      } catch (error) {
        // Failed to watch, silently ignore
        console.warn(`Failed to watch config file: ${source.path}`, error);
      }

      // Return cleanup function
      return () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        unwatchFile(source.path, handleStatChange);
      };
    }
  };
}

/**
 * Merge multiple configuration objects with precedence
 * Earlier sources have higher precedence
 */
export function mergeConfigs(
  configs: unknown[],
  schemas: Array<{ hasDefaults: boolean; getDefaults: () => unknown }> = []
): Result<unknown, ConfigError> {
  // Start with schema defaults if available
  let result: Record<string, unknown> = {};
  
  for (const schema of schemas) {
    if (schema.hasDefaults) {
      const defaults = schema.getDefaults();
      if (typeof defaults === "object" && defaults !== null) {
        result = deepMerge(result, defaults as Record<string, unknown>);
      }
    }
  }
  
  // Apply configs in order — later sources override earlier ones
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    if (typeof config === "object" && config !== null) {
      result = deepMerge(result, config as Record<string, unknown>);
    }
  }
  
  return ok(result);
}

/**
 * Deep merge two objects
 * Values from source override values in target
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      // Skip undefined values
      continue;
    }
    
    if (value === null) {
      // Null explicitly overrides
      result[key] = null;
      continue;
    }
    
    if (typeof value === "object" && !Array.isArray(value)) {
      // Merge nested objects
      const targetValue = result[key];
      if (typeof targetValue === "object" && targetValue !== null && !Array.isArray(targetValue)) {
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          value as Record<string, unknown>
        );
      } else {
        result[key] = value;
      }
    } else {
      // Direct assignment for primitives and arrays
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Extract value at path from object
 */
export function getValueAtPath(
  obj: unknown,
  path: string
): Result<unknown, ConfigError> {
  if (typeof obj !== "object" || obj === null) {
    return err({
      type: "PATH_NOT_FOUND",
      path
    });
  }
  
  const parts = path.split(".");
  let current: unknown = obj;
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    
    if (typeof current !== "object" || current === null) {
      return err({
        type: "PATH_NOT_FOUND",
        path: parts.slice(0, i + 1).join(".")
      });
    }
    
    if (Array.isArray(current)) {
      // Handle array index
      const index = parseInt(part, 10);
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        return err({
          type: "PATH_NOT_FOUND",
          path: parts.slice(0, i + 1).join(".")
        });
      }
      current = current[index];
    } else {
      // Handle object property
      const objCurrent = current as Record<string, unknown>;
      if (!(part in objCurrent)) {
        return err({
          type: "PATH_NOT_FOUND",
          path: parts.slice(0, i + 1).join(".")
        });
      }
      current = objCurrent[part];
    }
  }
  
  return ok(current);
}
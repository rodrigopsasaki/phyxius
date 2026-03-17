import type { Result } from "@phyxiusjs/fp";
import type { Clock } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";

/**
 * Contract for any validator that can parse input data.
 * Compatible with Zod schemas and custom validators.
 */
export interface Validator<T> {
  parse(input: unknown): T;
}

/**
 * Configuration error types
 */
export type ConfigError =
  | { type: "VALIDATION_ERROR"; path?: string; message: string; details?: unknown }
  | { type: "SOURCE_ERROR"; source: string; message: string; cause?: unknown }
  | { type: "PATH_NOT_FOUND"; path: string }
  | { type: "TYPE_MISMATCH"; path: string; expected: string; actual: string }
  | { type: "PARSE_ERROR"; source: string; message: string }
  | { type: "FILE_NOT_FOUND"; path: string }
  | { type: "CIRCULAR_REFERENCE"; path: string };

/**
 * Configuration source types
 */
export type ConfigSource =
  | { type: "env"; prefix?: string; convention?: "dbt" | "flat" }
  | { type: "file"; path: string; format?: "json" | "yaml" | "env" }
  | { type: "object"; data: unknown }
  | { type: "defaults" };

/**
 * Configuration change event
 */
export interface ConfigChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Configuration event types
 */
export type ConfigEvent =
  | { type: "CONFIG_LOADED"; timestamp: { wallMs: number; monoMs: number } }
  | { type: "CONFIG_RELOADED"; changes: ConfigChange[]; timestamp: { wallMs: number; monoMs: number } }
  | { type: "CONFIG_ERROR"; error: ConfigError; timestamp: { wallMs: number; monoMs: number } }
  | { type: "WATCH_STARTED"; path: string; timestamp: { wallMs: number; monoMs: number } }
  | { type: "WATCH_STOPPED"; path: string; timestamp: { wallMs: number; monoMs: number } };

/**
 * Configuration options
 */
export interface ConfigOptions {
  /**
   * Configuration sources in precedence order (first wins)
   */
  sources: ConfigSource[];

  /**
   * Clock instance for time operations
   */
  clock: Clock;

  /**
   * Enable hot reloading for file sources
   */
  watch?: boolean;

  /**
   * Journal for event logging
   */
  journal?: Journal<ConfigEvent>;

  /**
   * Environment name (e.g., "development", "production")
   */
  environment?: string;
}

/**
 * Configuration instance interface
 */
export interface ConfigInstance<T> {
  /**
   * Get a value at the specified path
   */
  get<K extends PathKeys<T>>(path: K): Result<PathValue<T, K>, ConfigError>;

  /**
   * Get a value or return default if not found
   */
  getOrDefault<K extends PathKeys<T>, D>(path: K, defaultValue: D): PathValue<T, K> | D;

  /**
   * Get the entire configuration
   */
  getAll(): Result<T, ConfigError>;

  /**
   * Reload configuration from sources
   */
  reload(): Result<void, ConfigError>;

  /**
   * Subscribe to configuration changes
   */
  subscribe(callback: (event: ConfigEvent) => void): () => void;

  /**
   * Generate example configuration
   */
  generateExample(): string;

  /**
   * Get current configuration metadata
   */
  getMetadata(): ConfigMetadata;
}

/**
 * Configuration metadata
 */
export interface ConfigMetadata {
  loadedAt: { wallMs: number; monoMs: number };
  sources: ConfigSource[];
  environment?: string;
  watchEnabled: boolean;
  lastReloadAt?: { wallMs: number; monoMs: number };
  reloadCount: number;
}

/**
 * Internal configuration state
 */
export interface ConfigState<T> {
  data: T;
  metadata: ConfigMetadata;
  errors: ConfigError[];
}

/**
 * Path extraction types for dot notation
 */
export type PathKeys<T> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends object
          ? K | `${K}.${PathKeys<T[K]>}`
          : K
        : never;
    }[keyof T]
  : never;

/**
 * Extract value type from path
 */
export type PathValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? Rest extends PathKeys<T[K]>
      ? PathValue<T[K], Rest>
      : never
    : never
  : P extends keyof T
  ? T[P]
  : never;

/**
 * Configuration loader interface
 */
export interface ConfigLoader {
  /**
   * Load configuration from source
   */
  load(source: ConfigSource): Result<unknown, ConfigError>;

  /**
   * Watch source for changes (if applicable)
   */
  watch?(source: ConfigSource, callback: (data: unknown) => void): () => void;
}

/**
 * Environment variable parser options
 */
export interface EnvParserOptions {
  /**
   * Prefix to filter environment variables
   */
  prefix?: string;

  /**
   * Convention for parsing nested values
   */
  convention?: "dbt" | "flat";

  /**
   * Custom delimiter for nested paths (only for flat convention)
   */
  delimiter?: string;
}

/**
 * File loader options
 */
export interface FileLoaderOptions {
  /**
   * File format (auto-detected if not specified)
   */
  format?: "json" | "yaml" | "env";

  /**
   * Encoding for file reading
   */
  encoding?: BufferEncoding;
}

/**
 * Schema validation result
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: Array<{
    path?: string;
    message: string;
  }>;
}
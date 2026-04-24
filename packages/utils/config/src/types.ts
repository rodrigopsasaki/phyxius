import type { Result } from "@phyxiusjs/fp";
import type { Clock, Instant } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";

// ── Schema validation ──────────────────────────────────────────────────────

/**
 * Contract for any validator that can parse input data.
 * Compatible with Zod schemas and custom validators — anything with a
 * `parse(input): T` method that throws on validation failure.
 */
export interface Validator<T> {
  parse(input: unknown): T;
}

// ── Typed path access ──────────────────────────────────────────────────────

/**
 * Dot-notation paths into a schema type. Only object sub-paths are enumerated;
 * arrays are treated as leaf values (no numeric-index paths).
 *
 * @example
 * ```ts
 * type Shape = { server: { port: number; host: string }; db: { url: string } };
 * type P = Path<Shape>;
 * // "server" | "server.port" | "server.host" | "db" | "db.url"
 * ```
 */
export type Path<T> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends ReadonlyArray<unknown>
          ? K
          : T[K] extends object
            ? K | `${K}.${Path<T[K]>}`
            : K
        : never;
    }[keyof T]
  : never;

/**
 * Resolve the value type at a dot-notation path into a schema type.
 *
 * @example
 * ```ts
 * type Shape = { server: { port: number } };
 * type V = PathValue<Shape, "server.port">; // number
 * ```
 */
export type PathValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? PathValue<T[K], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Structured config errors. Every error carries enough context to act on
 * without re-parsing strings.
 */
export type ConfigError =
  | { type: "VALIDATION_ERROR"; message: string; details?: unknown }
  | { type: "SOURCE_ERROR"; source: string; message: string; cause?: unknown }
  | { type: "PARSE_ERROR"; source: string; message: string }
  | { type: "FILE_NOT_FOUND"; path: string }
  | { type: "PATH_NOT_FOUND"; path: string };

// ── Sources ────────────────────────────────────────────────────────────────

export type ConfigSource =
  | { type: "env"; prefix?: string; convention?: "dbt" | "flat" }
  | { type: "file"; path: string; format?: "json" | "env" }
  | { type: "object"; data: unknown }
  | { type: "defaults" };

// ── Events ─────────────────────────────────────────────────────────────────

export interface ConfigChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

export type ConfigEvent =
  | { type: "CONFIG_LOADED"; at: Instant }
  | { type: "CONFIG_RELOADED"; changes: ConfigChange[]; at: Instant }
  | { type: "CONFIG_ERROR"; error: ConfigError; at: Instant }
  | { type: "WATCH_STARTED"; path: string; at: Instant }
  | { type: "WATCH_STOPPED"; path: string; at: Instant };

// ── Loader ─────────────────────────────────────────────────────────────────

/**
 * Pluggable source loader. The default loader handles env / file / object /
 * defaults; provide your own to support custom sources (e.g., Consul, Vault,
 * AWS SSM) or to inject test data.
 */
export interface ConfigLoader {
  load(source: ConfigSource): Result<unknown, ConfigError>;
  watch?(source: ConfigSource, callback: (data: unknown) => void): () => void;
}

// ── Options ────────────────────────────────────────────────────────────────

export interface ConfigOptions {
  /**
   * Configuration sources in precedence order — the FIRST source wins.
   * Typical order: `[{ type: "env" }, { type: "file", path: ".env" }, { type: "defaults" }]`.
   */
  sources: ConfigSource[];

  /** Clock for timestamps and the file-watch debounce. */
  clock: Clock;

  /** Enable file-watch hot reload for file sources. Default false. */
  watch?: boolean;

  /** Optional journal for event logging — every ConfigEvent is appended. */
  journal?: Journal<ConfigEvent>;

  /** Environment name for metadata (e.g., "development", "production"). */
  environment?: string;

  /** Inject a custom loader. Defaults to `createLoader({ clock })`. */
  loader?: ConfigLoader;
}

// ── Instance ───────────────────────────────────────────────────────────────

export interface ConfigInstance<T> {
  /** Get a value at a typed path. */
  get<P extends Path<T>>(path: P): Result<PathValue<T, P>, ConfigError>;

  /** Get a value at an untyped string path (escape hatch for dynamic access). */
  getPath(path: string): Result<unknown, ConfigError>;

  /** Get a value with a fallback default. */
  getOrDefault<P extends Path<T>, D>(path: P, defaultValue: D): PathValue<T, P> | D;

  /** Get the entire validated configuration. */
  getAll(): Result<T, ConfigError>;

  /** Reload configuration from all sources. */
  reload(): Result<void, ConfigError>;

  /** Subscribe to configuration events. Returns an unsubscribe function. */
  subscribe(callback: (event: ConfigEvent) => void): () => void;

  /** Current metadata. */
  getMetadata(): ConfigMetadata;

  /** Tear down watchers and release subscribers. Idempotent. */
  dispose(): void;
}

export interface ConfigMetadata {
  loadedAt: Instant;
  sources: ConfigSource[];
  environment?: string;
  watchEnabled: boolean;
  lastReloadAt?: Instant;
  reloadCount: number;
}

export interface ConfigState<T> {
  data: T;
  metadata: ConfigMetadata;
  /** The most recent error, or null. A single slot — not an accumulator. */
  lastError: ConfigError | null;
}

// ── Parser options ─────────────────────────────────────────────────────────

export interface EnvParserOptions {
  prefix?: string;
  convention?: "dbt" | "flat";
  delimiter?: string;
}

export interface FileLoaderOptions {
  format?: "json" | "env";
  encoding?: BufferEncoding;
}

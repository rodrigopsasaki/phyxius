/**
 * @phyxiusjs/config - Type-safe configuration management
 * 
 * A comprehensive configuration management library for Phyxius applications
 * featuring hot reloading, multiple sources, and full observability.
 */

// Main config creation function
export { createConfig } from "./config";

// Types
export type {
  ConfigInstance,
  ConfigOptions,
  ConfigSource,
  ConfigError,
  ConfigEvent,
  ConfigState,
  ConfigMetadata,
  ConfigChange,
  ConfigLoader,
  EnvParserOptions,
  FileLoaderOptions
} from "./types";

// Parsers (for advanced use cases)
export { parseEnv, generateEnvExample } from "./parsers/env";
export { loadFile } from "./parsers/file";

// Loaders (for custom implementations)
export { createLoader, mergeConfigs, getValueAtPath } from "./loaders";

// Re-export commonly used Result types for convenience
export type { Result } from "@phyxiusjs/fp";
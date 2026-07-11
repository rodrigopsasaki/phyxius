/**
 * @phyxiusjs/config - Type-safe configuration management
 *
 * A comprehensive configuration management library for Phyxius applications
 * featuring hot reloading, multiple sources, and full observability.
 */

// Main config creation function
export { createConfig } from "./config.js";

// Types
export type {
  Validator,
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
  FileLoaderOptions,
} from "./types.js";

// Parsers (for advanced use cases)
export { parseEnv, generateEnvExample } from "./parsers/env.js";
export { loadFile } from "./parsers/file.js";
export { resolveGate, type GateState } from "./parsers/gate.js";

// Loaders (for custom implementations)
export { createLoader, mergeConfigs, getValueAtPath } from "./loaders.js";

// Re-export commonly used Result types for convenience
export type { Result } from "@phyxiusjs/fp";

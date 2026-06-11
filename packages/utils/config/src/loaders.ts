import { ok, err, type Result } from "@phyxiusjs/fp";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { debounce as temporalDebounce } from "@phyxiusjs/temporal";
import type { ConfigSource, ConfigError, ConfigLoader } from "./types.js";
import { parseEnv } from "./parsers/env.js";
import { loadFile } from "./parsers/file.js";
import { watch as fsWatch, watchFile, unwatchFile, type Stats } from "fs";

const DEFAULT_WATCH_POLL_INTERVAL_MS = 100;
const DEFAULT_WATCH_DEBOUNCE_MS = 20;

/**
 * Create a config loader for all source types.
 *
 * @param options.clock - Injected Clock used to pace the file-watch debounce.
 *   The loader's own timing never touches `Date.now()` or `setTimeout`; tests
 *   with a controlled clock are deterministic.
 * @param options.watchPollIntervalMs - Fallback `fs.watchFile` poll interval
 *   (ms). Only used if the OS-native `fs.watch` (kqueue/inotify) fails. The
 *   native watcher is event-driven and doesn't depend on timer latency.
 */
export function createLoader(options?: { clock?: Clock; watchPollIntervalMs?: number }): ConfigLoader {
  const clock = options?.clock;
  const watchPollIntervalMs = options?.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS;

  return {
    load(source: ConfigSource): Result<unknown, ConfigError> {
      switch (source.type) {
        case "env": {
          const envOpts: Parameters<typeof parseEnv>[1] = {};
          if (source.prefix !== undefined) envOpts.prefix = source.prefix;
          if (source.convention !== undefined) envOpts.convention = source.convention;
          return parseEnv(process.env, envOpts);
        }

        case "file": {
          const fileOpts: Parameters<typeof loadFile>[1] = {};
          if (source.format !== undefined) fileOpts.format = source.format;
          return loadFile(source.path, fileOpts);
        }

        case "object":
          return ok(source.data);

        case "defaults":
          // Defaults are extracted from schema, return empty object
          return ok({});

        default:
          return err({
            type: "SOURCE_ERROR",
            source: "unknown",
            message: `Unknown source type`,
          });
      }
    },

    watch(source: ConfigSource, callback: (data: unknown) => void): () => void {
      if (source.type !== "file") {
        // Only file sources can be watched
        return () => {};
      }

      // Debounce is Clock-controlled when a clock is injected. With an
      // injected ControlledClock, tests that use this loader are deterministic
      // on the debounce axis (the OS notification axis is still real-time —
      // that's inherent to filesystem watching).
      const debounced = clock
        ? temporalDebounce(
            () => {
              const fileOpts: Parameters<typeof loadFile>[1] = {};
              if (source.format !== undefined) fileOpts.format = source.format;
              const result = loadFile(source.path, fileOpts);
              if (result._tag === "Ok") {
                callback(result.value);
              }
            },
            DEFAULT_WATCH_DEBOUNCE_MS as Millis,
            clock,
          )
        : (() => {
            // Fallback: no clock injected, debounce against setTimeout.
            let timer: ReturnType<typeof setTimeout> | undefined;
            return () => {
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => {
                const fileOpts: Parameters<typeof loadFile>[1] = {};
                if (source.format !== undefined) fileOpts.format = source.format;
                const result = loadFile(source.path, fileOpts);
                if (result._tag === "Ok") {
                  callback(result.value);
                }
              }, DEFAULT_WATCH_DEBOUNCE_MS);
            };
          })();

      // Hold the fs.watch error (if any) so the stat-polling fallback can
      // report both failures if it also fails.
      let watchError: unknown;

      // Primary: event-driven `fs.watch` (kqueue on macOS, inotify on Linux,
      // ReadDirectoryChangesW on Windows). No timer latency — changes are
      // pushed as the OS sees them.
      //
      // Fallback: if `fs.watch` throws (unusual filesystems, permission
      // issues), drop to `fs.watchFile` stat-polling. Slower, but universal.
      try {
        const watcher = fsWatch(source.path, { persistent: false }, (eventType) => {
          if (eventType === "change" || eventType === "rename") {
            debounced();
          }
        });
        watcher.on("error", () => {
          // Silent — the watcher is best-effort; the caller can always
          // explicitly `reload()` if it suspects drift.
        });
        return () => {
          try {
            watcher.close();
          } catch {
            // close() can throw if already closed; ignore.
          }
        };
      } catch (e) {
        watchError = e;
        // Fall through to stat-polling fallback below.
      }

      const handleStatChange = (curr: Stats, prev: Stats) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
          debounced();
        }
      };

      try {
        watchFile(source.path, { interval: watchPollIntervalMs, persistent: false }, handleStatChange);
      } catch (statError) {
        // Both fs.watch and fs.watchFile failed. No watcher is active.
        // Surface the error so the caller knows the watch is non-functional;
        // they can still explicitly reload().
        console.error(
          `[@phyxiusjs/config] File watchers are inactive for "${source.path}". ` +
            `fs.watch: ${(watchError as Error)?.message ?? String(watchError)}. ` +
            `fs.watchFile: ${(statError as Error)?.message ?? String(statError)}. ` +
            `Call reload() explicitly to refresh configuration.`,
        );
        return () => {};
      }

      return () => {
        unwatchFile(source.path, handleStatChange);
      };
    },
  };
}

/**
 * Merge multiple configuration objects with precedence.
 *
 * Earlier configs in the array have HIGHER precedence (first wins). The
 * sources list in `ConfigOptions.sources` is likewise ordered high-to-low:
 * `[env, file, defaults]` means env wins over file wins over defaults.
 *
 * Implementation: iterate from lowest priority (last) to highest priority
 * (first). Each `deepMerge` lets the second argument override the first, so
 * applying high-priority sources last means they override the layers below.
 */
export function mergeConfigs(configs: unknown[]): Result<unknown, ConfigError> {
  let result: Record<string, unknown> = {};

  for (let i = configs.length - 1; i >= 0; i--) {
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
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
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
        result[key] = deepMerge(targetValue as Record<string, unknown>, value as Record<string, unknown>);
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
export function getValueAtPath(obj: unknown, path: string): Result<unknown, ConfigError> {
  if (typeof obj !== "object" || obj === null) {
    return err({
      type: "PATH_NOT_FOUND",
      path,
    });
  }

  const parts = path.split(".");
  let current: unknown = obj;

  for (const [i, segment] of parts.entries()) {
    if (typeof current !== "object" || current === null) {
      return err({
        type: "PATH_NOT_FOUND",
        path: parts.slice(0, i + 1).join("."),
      });
    }

    if (Array.isArray(current)) {
      // Handle array index
      const index = parseInt(segment, 10);
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        return err({
          type: "PATH_NOT_FOUND",
          path: parts.slice(0, i + 1).join("."),
        });
      }
      current = current[index];
    } else {
      // Handle object property
      const objCurrent = current as Record<string, unknown>;
      if (!(segment in objCurrent)) {
        return err({
          type: "PATH_NOT_FOUND",
          path: parts.slice(0, i + 1).join("."),
        });
      }
      current = objCurrent[segment];
    }
  }

  return ok(current);
}

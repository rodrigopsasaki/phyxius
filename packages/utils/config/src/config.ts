import { ok, err, type Result } from "@phyxiusjs/fp";
import { createAtom, type Atom } from "@phyxiusjs/atom";
import type {
  Validator,
  ConfigInstance,
  ConfigOptions,
  ConfigError,
  ConfigEvent,
  ConfigState,
  ConfigMetadata,
  ConfigChange,
  ConfigLoader,
  ConfigSource,
  Path,
  PathValue,
} from "./types.js";
import { createLoader, mergeConfigs, getValueAtPath } from "./loaders.js";

/**
 * Create a configuration instance with validation and type safety.
 *
 * Sources are evaluated in precedence order — the FIRST source wins. Pass
 * sources as `[runtimeOverrides, env, file, defaults]` (highest → lowest).
 */
export function createConfig<T>(schema: Validator<T>, options: ConfigOptions): ConfigInstance<T> {
  const { sources, clock, watch = false, journal, environment, loader: injectedLoader } = options;

  const loader: ConfigLoader = injectedLoader ?? createLoader({ clock });

  // ── State ───────────────────────────────────────────────────────────────

  const initialMetadata: ConfigMetadata = {
    loadedAt: clock.now(),
    sources,
    watchEnabled: watch,
    reloadCount: 0,
  };
  if (environment !== undefined) initialMetadata.environment = environment;

  const stateAtom: Atom<ConfigState<T>> = createAtom<ConfigState<T>>(
    {
      data: {} as T,
      metadata: initialMetadata,
      lastError: null,
    },
    clock,
  );

  const watchCleanups: Array<() => void> = [];
  const subscribers = new Set<(event: ConfigEvent) => void>();
  let disposed = false;
  // The most recent event is replayed to new subscribers so they observe
  // current state without race conditions around subscribe vs initial load.
  let lastEvent: ConfigEvent | undefined;

  // ── Event emission ──────────────────────────────────────────────────────

  function emit(event: ConfigEvent): void {
    lastEvent = event;
    journal?.append(event);

    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        // A subscriber threw. Route through the journal so it's observable,
        // but never crash or pollute stderr — subscriber isolation is the
        // contract.
        journal?.append({
          type: "CONFIG_ERROR",
          error: {
            type: "SOURCE_ERROR",
            source: "subscriber",
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          },
          at: clock.now(),
        });
      }
    }
  }

  // ── Load + validate pipeline ────────────────────────────────────────────

  function loadAndValidate(): Result<T, ConfigError> {
    const configs: unknown[] = [];

    for (const source of sources) {
      const result = loader.load(source);
      if (result._tag === "Ok") {
        configs.push(result.value);
      } else if (source.type !== "defaults") {
        return result as Result<T, ConfigError>;
      }
    }

    const merged = mergeConfigs(configs);
    if (merged._tag === "Err") {
      return merged as Result<T, ConfigError>;
    }

    try {
      return ok(schema.parse(merged.value));
    } catch (error) {
      return err({
        type: "VALIDATION_ERROR",
        message: error instanceof Error ? error.message : "Validation failed",
        details: error,
      });
    }
  }

  // ── Initial load ────────────────────────────────────────────────────────

  const initial = loadAndValidate();
  if (initial._tag === "Ok") {
    stateAtom.swap((state) => ({
      data: initial.value,
      metadata: { ...state.metadata, loadedAt: clock.now() },
      lastError: null,
    }));
    emit({ type: "CONFIG_LOADED", at: clock.now() });
  } else {
    stateAtom.swap((state) => ({ ...state, lastError: initial.error }));
    emit({ type: "CONFIG_ERROR", error: initial.error, at: clock.now() });
  }

  // ── File watching ───────────────────────────────────────────────────────

  if (watch) {
    for (const source of sources) {
      if (source.type !== "file") continue;

      const cleanup = loader.watch?.(source, () => onSourceChanged(source));
      if (cleanup) {
        watchCleanups.push(cleanup);
        emit({ type: "WATCH_STARTED", path: source.path, at: clock.now() });
      }
    }
  }

  function onSourceChanged(source: ConfigSource): void {
    if (source.type !== "file") return;

    const oldData = stateAtom.deref().data;
    const reloaded = loadAndValidate();

    if (reloaded._tag === "Ok") {
      const changes = detectChanges(oldData, reloaded.value);
      stateAtom.swap((state) => ({
        data: reloaded.value,
        metadata: {
          ...state.metadata,
          lastReloadAt: clock.now(),
          reloadCount: state.metadata.reloadCount + 1,
        },
        lastError: null,
      }));
      emit({ type: "CONFIG_RELOADED", changes, at: clock.now() });
    } else {
      stateAtom.swap((state) => ({ ...state, lastError: reloaded.error }));
      emit({ type: "CONFIG_ERROR", error: reloaded.error, at: clock.now() });
    }
  }

  // ── Instance API ────────────────────────────────────────────────────────

  function readPath<P extends Path<T>>(path: P): Result<PathValue<T, P>, ConfigError> {
    const state = stateAtom.deref();
    if (state.lastError !== null) {
      return err(state.lastError);
    }
    return getValueAtPath(state.data, path) as Result<PathValue<T, P>, ConfigError>;
  }

  const instance: ConfigInstance<T> = {
    get<P extends Path<T>>(path: P): Result<PathValue<T, P>, ConfigError> {
      return readPath(path);
    },

    getPath(path: string): Result<unknown, ConfigError> {
      const state = stateAtom.deref();
      if (state.lastError !== null) {
        return err(state.lastError);
      }
      return getValueAtPath(state.data, path);
    },

    getOrDefault<P extends Path<T>, D>(path: P, defaultValue: D): PathValue<T, P> | D {
      const result = readPath(path);
      return result._tag === "Ok" ? result.value : defaultValue;
    },

    getAll(): Result<T, ConfigError> {
      const state = stateAtom.deref();
      if (state.lastError !== null) {
        return err(state.lastError);
      }
      return ok(state.data);
    },

    reload(): Result<void, ConfigError> {
      const oldData = stateAtom.deref().data;
      const result = loadAndValidate();

      if (result._tag === "Ok") {
        const changes = detectChanges(oldData, result.value);
        stateAtom.swap((state) => ({
          data: result.value,
          metadata: {
            ...state.metadata,
            lastReloadAt: clock.now(),
            reloadCount: state.metadata.reloadCount + 1,
          },
          lastError: null,
        }));
        emit({ type: "CONFIG_RELOADED", changes, at: clock.now() });
        return ok(undefined);
      }

      stateAtom.swap((state) => ({ ...state, lastError: result.error }));
      emit({ type: "CONFIG_ERROR", error: result.error, at: clock.now() });
      return err(result.error);
    },

    subscribe(callback: (event: ConfigEvent) => void): () => void {
      subscribers.add(callback);

      // Replay the most recent event so new subscribers observe current state.
      if (lastEvent !== undefined) {
        try {
          callback(lastEvent);
        } catch {
          // Swallow — subscriber's problem. Deliberately not logged to stderr.
        }
      }

      return () => {
        subscribers.delete(callback);
      };
    },

    getMetadata(): ConfigMetadata {
      return stateAtom.deref().metadata;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;

      for (const cleanup of watchCleanups) {
        try {
          cleanup();
        } catch {
          // Cleanup errors shouldn't cascade.
        }
      }
      watchCleanups.length = 0;
      subscribers.clear();
    },
  };

  // Intentionally NO process exit handlers. Callers dispose explicitly.
  // Auto-registration leaks listeners on the process emitter for every
  // config created, and silently extends lifetimes past the caller's intent.

  return instance;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function detectChanges<T>(oldData: T, newData: T, path = ""): ConfigChange[] {
  const changes: ConfigChange[] = [];
  if (oldData === newData) return changes;

  if (typeof oldData !== "object" || typeof newData !== "object" || oldData === null || newData === null) {
    changes.push({ path: path || "root", oldValue: oldData, newValue: newData });
    return changes;
  }

  const allKeys = new Set([...Object.keys(oldData as object), ...Object.keys(newData as object)]);
  for (const key of allKeys) {
    const oldValue = (oldData as Record<string, unknown>)[key];
    const newValue = (newData as Record<string, unknown>)[key];
    const keyPath = path ? `${path}.${key}` : key;

    if (oldValue !== newValue) {
      if (typeof oldValue === "object" && typeof newValue === "object" && oldValue !== null && newValue !== null) {
        changes.push(...detectChanges(oldValue as T, newValue as T, keyPath));
      } else {
        changes.push({ path: keyPath, oldValue, newValue });
      }
    }
  }

  return changes;
}

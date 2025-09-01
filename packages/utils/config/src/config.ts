import { ok, err, type Result, map, flatMap, pipe } from "@phyxiusjs/fp";
import { createAtom, type Atom } from "@phyxiusjs/atom";
import type { Validator } from "@phyxiusjs/validate";
import type { Clock } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";
import type {
  ConfigInstance,
  ConfigOptions,
  ConfigSource,
  ConfigError,
  ConfigEvent,
  ConfigState,
  ConfigMetadata,
  ConfigChange
} from "./types";
import { createLoader, mergeConfigs, getValueAtPath } from "./loaders";
import { generateEnvExample } from "./parsers/env";

/**
 * Create a configuration instance with validation and type safety
 */
export function createConfig<T>(
  schema: Validator<T>,
  options: ConfigOptions
): ConfigInstance<T> {
  const { sources, clock, watch = false, journal, environment } = options;
  
  // Initialize state atom
  const stateAtom: Atom<ConfigState<T>> = createAtom<ConfigState<T>>(
    {
      data: {} as T,
      metadata: {
        loadedAt: clock.now(),
        sources,
        environment,
        watchEnabled: watch,
        reloadCount: 0
      },
      errors: []
    },
    clock
  );
  
  // Create loader
  const loader = createLoader(clock);
  
  // Watch cleanup functions
  const watchCleanups: Array<() => void> = [];
  
  // Event subscribers
  const subscribers = new Set<(event: ConfigEvent) => void>();
  
  /**
   * Emit event to subscribers and journal
   */
  function emitEvent(event: ConfigEvent): void {
    // Log to journal if provided
    if (journal) {
      journal.append(event);
    }
    
    // Notify subscribers
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        // Subscriber error shouldn't break others
        console.error("Config subscriber error:", error);
      }
    }
  }
  
  /**
   * Load configuration from all sources
   */
  function loadConfig(): Result<T, ConfigError> {
    const configs: unknown[] = [];
    const errors: ConfigError[] = [];
    
    // Load from each source
    for (const source of sources) {
      const result = loader.load(source);
      
      if (result._tag === "Ok") {
        configs.push(result.value);
      } else if (source.type !== "defaults") {
        // Defaults are optional, other sources report errors
        errors.push(result.error);
      }
    }
    
    // Merge all configs
    const mergeResult = mergeConfigs(configs);
    if (mergeResult._tag === "Err") {
      return mergeResult as Result<T, ConfigError>;
    }
    
    // Validate against schema
    try {
      const validated = schema.parse(mergeResult.value);
      return ok(validated);
    } catch (error) {
      return err({
        type: "VALIDATION_ERROR",
        message: error instanceof Error ? error.message : "Validation failed",
        details: error
      });
    }
  }
  
  /**
   * Initial load
   */
  const initialLoad = loadConfig();
  if (initialLoad._tag === "Ok") {
    stateAtom.reset({
      data: initialLoad.value,
      metadata: {
        loadedAt: clock.now(),
        sources,
        environment,
        watchEnabled: watch,
        reloadCount: 0
      },
      errors: []
    });
    
    emitEvent({
      type: "CONFIG_LOADED",
      timestamp: clock.now()
    });
  } else {
    stateAtom.swap(state => ({
      ...state,
      errors: [initialLoad.error]
    }));
    
    emitEvent({
      type: "CONFIG_ERROR",
      error: initialLoad.error,
      timestamp: clock.now()
    });
  }
  
  /**
   * Set up file watching if enabled
   */
  if (watch) {
    for (const source of sources) {
      if (source.type === "file") {
        const cleanup = loader.watch?.(source, () => {
          // Reload on file change
          const oldData = stateAtom.deref().data;
          const reloadResult = loadConfig();
          
          if (reloadResult._tag === "Ok") {
            const newData = reloadResult.value;
            const changes = detectChanges(oldData, newData);
            
            stateAtom.swap(state => ({
              data: newData,
              metadata: {
                ...state.metadata,
                lastReloadAt: clock.now(),
                reloadCount: state.metadata.reloadCount + 1
              },
              errors: []
            }));
            
            emitEvent({
              type: "CONFIG_RELOADED",
              changes,
              timestamp: clock.now()
            });
          } else {
            stateAtom.swap(state => ({
              ...state,
              errors: [...state.errors, reloadResult.error]
            }));
            
            emitEvent({
              type: "CONFIG_ERROR",
              error: reloadResult.error,
              timestamp: clock.now()
            });
          }
        });
        
        if (cleanup) {
          watchCleanups.push(cleanup);
          
          emitEvent({
            type: "WATCH_STARTED",
            path: source.path,
            timestamp: clock.now()
          });
        }
      }
    }
  }
  
  /**
   * Detect changes between old and new config
   */
  function detectChanges(oldData: T, newData: T, path = ""): ConfigChange[] {
    const changes: ConfigChange[] = [];
    
    if (oldData === newData) {
      return changes;
    }
    
    if (typeof oldData !== "object" || typeof newData !== "object" ||
        oldData === null || newData === null) {
      changes.push({
        path: path || "root",
        oldValue: oldData,
        newValue: newData
      });
      return changes;
    }
    
    const allKeys = new Set([
      ...Object.keys(oldData as object),
      ...Object.keys(newData as object)
    ]);
    
    for (const key of allKeys) {
      const oldValue = (oldData as Record<string, unknown>)[key];
      const newValue = (newData as Record<string, unknown>)[key];
      const keyPath = path ? `${path}.${key}` : key;
      
      if (oldValue !== newValue) {
        if (typeof oldValue === "object" && typeof newValue === "object" &&
            oldValue !== null && newValue !== null) {
          // Recursive check for nested objects
          changes.push(...detectChanges(oldValue as T, newValue as T, keyPath));
        } else {
          changes.push({
            path: keyPath,
            oldValue,
            newValue
          });
        }
      }
    }
    
    return changes;
  }
  
  // Create the config instance
  const instance: ConfigInstance<T> = {
    get(path: string): Result<unknown, ConfigError> {
      const state = stateAtom.deref();
      
      if (state.errors.length > 0) {
        return err(state.errors[0]);
      }
      
      return getValueAtPath(state.data, path);
    },
    
    getOrDefault<D>(path: string, defaultValue: D): unknown | D {
      const result = this.get(path);
      return result._tag === "Ok" ? result.value : defaultValue;
    },
    
    getAll(): Result<T, ConfigError> {
      const state = stateAtom.deref();
      
      if (state.errors.length > 0) {
        return err(state.errors[0]);
      }
      
      return ok(state.data);
    },
    
    reload(): Result<void, ConfigError> {
      const oldData = stateAtom.deref().data;
      const result = loadConfig();
      
      if (result._tag === "Ok") {
        const changes = detectChanges(oldData, result.value);
        
        stateAtom.swap(state => ({
          data: result.value,
          metadata: {
            ...state.metadata,
            lastReloadAt: clock.now(),
            reloadCount: state.metadata.reloadCount + 1
          },
          errors: []
        }));
        
        emitEvent({
          type: "CONFIG_RELOADED",
          changes,
          timestamp: clock.now()
        });
        
        return ok(undefined);
      } else {
        stateAtom.swap(state => ({
          ...state,
          errors: [...state.errors, result.error]
        }));
        
        emitEvent({
          type: "CONFIG_ERROR",
          error: result.error,
          timestamp: clock.now()
        });
        
        return err(result.error);
      }
    },
    
    subscribe(callback: (event: ConfigEvent) => void): () => void {
      subscribers.add(callback);
      
      return () => {
        subscribers.delete(callback);
      };
    },
    
    generateExample(): string {
      // Extract schema information for example generation
      const paths: Array<{
        path: string;
        type: string;
        required: boolean;
        defaultValue?: unknown;
      }> = [];
      
      // This would need schema introspection
      // For now, return a simple example
      return generateEnvExample(paths, {
        convention: "dbt",
        prefix: ""
      });
    },
    
    getMetadata(): ConfigMetadata {
      return stateAtom.deref().metadata;
    }
  };
  
  // Clean up on process exit
  if (typeof process !== "undefined") {
    const cleanup = () => {
      for (const cleanupFn of watchCleanups) {
        cleanupFn();
      }
    };
    
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  
  return instance;
}
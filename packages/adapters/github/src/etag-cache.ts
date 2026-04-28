/**
 * Default in-memory LRU implementation of `EtagCache`.
 *
 * Why this matters: GitHub's primary REST budget is 5000 requests
 * per hour authenticated. Conditional requests via `If-None-Match`
 * still count against that budget — but only the 304 case avoids
 * actually transferring the body, and more importantly, it lets the
 * connector detect "no change" cheaply. For high-traffic apertures
 * (continuously polling for new PR comments, watching repos for
 * pushes), conditional requests dramatically reduce the
 * post-processing work even when they don't reduce request count.
 *
 * `sd-no-unboundedness` applied: this cache always declares its
 * overflow policy. Default policy is LRU with `maxEntries: 1024`.
 * Callers that want a different bound or a different store (e.g.,
 * Redis-backed for cross-process sharing) implement `EtagCache`
 * themselves and pass it on `GithubConfig.etagCache`.
 */

import type { EtagCache, EtagCacheEntry } from "./types.js";

const DEFAULT_MAX_ENTRIES = 1024;

export interface EtagCacheOptions {
  /** Hard upper bound on entries. Default: 1024. */
  readonly maxEntries?: number;
}

/**
 * Build a default LRU ETag cache. Constructed once per
 * `GithubConfig`; shared across all operations on that config.
 *
 * Uses Map insertion-order as the recency list: every `get` that
 * hits and every `set` re-inserts the key, making it most-recent.
 * On overflow, we delete the oldest (first iterator key).
 */
export function createEtagCache(options: EtagCacheOptions = {}): EtagCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (maxEntries <= 0) {
    throw new Error(`EtagCache maxEntries must be positive, got ${maxEntries}`);
  }

  const store = new Map<string, EtagCacheEntry>();

  function get(key: string): EtagCacheEntry | undefined {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    // Move to most-recent position by re-inserting.
    store.delete(key);
    store.set(key, entry);
    return entry;
  }

  function set<T>(key: string, entry: EtagCacheEntry<T>): void {
    // Re-insert promotes to most-recent; if already present this
    // updates the value AND the recency.
    if (store.has(key)) store.delete(key);
    store.set(key, entry as EtagCacheEntry);

    // Evict oldest while over capacity. The Map iterator yields keys
    // in insertion order, so the first key is the least-recent.
    while (store.size > maxEntries) {
      const firstKey = store.keys().next().value;
      if (firstKey === undefined) break;
      store.delete(firstKey);
    }
  }

  function deleteEntry(key: string): void {
    store.delete(key);
  }

  function clear(): void {
    store.clear();
  }

  return {
    get,
    set,
    delete: deleteEntry,
    clear,
    get size() {
      return store.size;
    },
  };
}

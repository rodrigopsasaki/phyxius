import type { Resource, UseFn } from "./types.js";

// ── parallel ───────────────────────────────────────────────────────────────

/**
 * Acquire all resources concurrently; if any acquisition fails, release the
 * ones that succeeded before re-throwing. During the `use()` phase all
 * values are available together. Release fires on all resources in parallel
 * when `use()` completes (or fails).
 *
 * Use `parallel` when resources are independent of each other (no
 * acquire-order or release-order constraints) — e.g. opening two DB
 * connections to different servers, or a Redis client plus a log file.
 *
 * For resources that depend on each other (B's acquire needs A live,
 * and B must be released before A), use `sequence`.
 */
export function parallel<const T extends readonly Resource<unknown>[]>(
  resources: T,
): Resource<{ readonly [K in keyof T]: T[K] extends Resource<infer V> ? V : never }> {
  type Values = { readonly [K in keyof T]: T[K] extends Resource<infer V> ? V : never };

  const self: Resource<Values> = {
    async use<R>(fn: UseFn<Values, R>): Promise<R> {
      if (resources.length === 0) {
        return fn([] as unknown as Values);
      }

      // Each inner `resource.use()` call owns its own acquire → release
      // lifecycle. To run them concurrently with a shared body, we gate
      // each inner body on a single "release" promise that resolves only
      // after the outer `fn()` has settled. That way every inner release
      // fires after the outer body — exact parallel bracket semantics
      // for every resource, with per-resource event emission preserved.
      let signalRelease!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        signalRelease = resolve;
      });

      const acquiredValues: unknown[] = new Array(resources.length);
      const barriers = resources.map(() => {
        let resolveAcquired!: () => void;
        let rejectAcquired!: (err: unknown) => void;
        const acquired = new Promise<void>((resolve, reject) => {
          resolveAcquired = resolve;
          rejectAcquired = reject;
        });
        return { acquired, resolveAcquired, rejectAcquired };
      });

      const innerPromises = resources.map((r, i) =>
        r
          .use(async (value) => {
            acquiredValues[i] = value;
            barriers[i]!.resolveAcquired();
            // Hold inner resource open until the outer body finishes.
            await releaseGate;
          })
          .catch((err) => {
            barriers[i]!.rejectAcquired(err);
            throw err;
          }),
      );

      // Wait until all acquire phases have completed — or any single
      // acquire has failed.
      try {
        await Promise.all(barriers.map((b) => b.acquired));
      } catch (acquireErr) {
        // One failed. Tell the already-acquired resources to release.
        signalRelease();
        await Promise.allSettled(innerPromises);
        throw acquireErr;
      }

      // All acquired — run the user's body.
      let result: R;
      let userError: unknown;
      try {
        result = await fn(acquiredValues as unknown as Values);
      } catch (err) {
        userError = err;
        result = undefined as R; // never read; useError is thrown below
      }

      // Trigger parallel release and wait for all of them to finish.
      signalRelease();
      await Promise.allSettled(innerPromises);

      if (userError !== undefined) throw userError;
      return result;
    },

    map<U>(transform: (values: Values) => U): Resource<U> {
      return mappedResource(self, transform);
    },
  };

  return self;
}

// ── sequence ───────────────────────────────────────────────────────────────

/**
 * Acquire resources in order; release them in reverse order. If any acquire
 * fails, the resources already acquired are released (in reverse) before
 * the error propagates.
 *
 * `sequence` is the correct choice when resources have a dependency chain —
 * a transaction depends on its connection, a file depends on its directory,
 * a channel depends on its subscription. Reverse-order release respects
 * those dependencies: the outer layer stays alive while the inner layer
 * tears down.
 */
export function sequence<const T extends readonly Resource<unknown>[]>(
  resources: T,
): Resource<{ readonly [K in keyof T]: T[K] extends Resource<infer V> ? V : never }> {
  type Values = { readonly [K in keyof T]: T[K] extends Resource<infer V> ? V : never };

  const self: Resource<Values> = {
    async use<R>(fn: UseFn<Values, R>): Promise<R> {
      return acquireInOrder(
        resources,
        0,
        [] as unknown[],
        fn as unknown as (v: unknown) => Promise<unknown>,
      ) as Promise<R>;
    },
    map<U>(transform: (values: Values) => U): Resource<U> {
      return mappedResource(self, transform);
    },
  };

  return self;
}

// Recursive acquire: each resource's `use` scope contains the next one's
// `use` scope. Reverse-order release is implicit — the outer `use` returns
// only after the inner `use` has settled, so the inner release always fires
// first.
async function acquireInOrder(
  resources: readonly Resource<unknown>[],
  index: number,
  accum: unknown[],
  fn: (values: unknown) => Promise<unknown>,
): Promise<unknown> {
  if (index >= resources.length) {
    return fn(accum);
  }
  const r = resources[index]!;
  return r.use(async (value) => {
    const nextAccum = [...accum, value];
    return acquireInOrder(resources, index + 1, nextAccum, fn);
  });
}

// ── Shared: mapped resource (for parallel/sequence) ────────────────────────

function mappedResource<T, U>(source: Resource<T>, transform: (value: T) => U): Resource<U> {
  const self: Resource<U> = {
    use<R>(fn: UseFn<U, R>): Promise<R> {
      return source.use((value) => fn(transform(value)));
    },
    map<V>(innerTransform: (value: U) => V): Resource<V> {
      return mappedResource(source, (value) => innerTransform(transform(value)));
    },
  };
  return self;
}

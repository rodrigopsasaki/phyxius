import type { Acquire, Release, Resource, ResourceEvent, ResourceOptions, UseFn } from "./types.js";

// ── Public: make ───────────────────────────────────────────────────────────

/**
 * Build a resource from an acquire / release pair.
 *
 * The returned resource is pure data until `use()` is called — no allocation
 * or I/O happens at construction time. Multiple `use()` calls are
 * independent: each acquires and releases its own value.
 */
export function make<T>(acquire: Acquire<T>, release: Release<T>, options: ResourceOptions = {}): Resource<T> {
  const self: Resource<T> = {
    use<R>(fn: UseFn<T, R>): Promise<R> {
      return runUse(acquire, release, fn, options);
    },
    map<U>(transform: (value: T) => U): Resource<U> {
      return mapped(self, transform);
    },
  };
  return self;
}

/**
 * Map a resource by wrapping its `use` — the original resource stays
 * responsible for release. This avoids the bug where constructing a
 * mapped resource as a new acquire/release pair would lose the reference
 * to the original value and skip the real cleanup.
 */
function mapped<T, U>(source: Resource<T>, transform: (value: T) => U): Resource<U> {
  const self: Resource<U> = {
    use<R>(fn: UseFn<U, R>): Promise<R> {
      return source.use((value) => fn(transform(value)));
    },
    map<V>(innerTransform: (value: U) => V): Resource<V> {
      return mapped(source, (value) => innerTransform(transform(value)));
    },
  };
  return self;
}

// ── Public: of ─────────────────────────────────────────────────────────────

/**
 * A resource that holds an already-acquired value and does nothing on
 * release. Useful for composing unconditional values alongside real
 * resources in `parallel` / `sequence`.
 */
export function of<T>(value: T, options: ResourceOptions = {}): Resource<T> {
  return make(
    () => value,
    () => undefined,
    options,
  );
}

// ── Public: bracket ────────────────────────────────────────────────────────

/**
 * One-shot convenience for `make(acquire, release).use(fn)`. Identical
 * semantics; shorter at the call site for single-use patterns.
 */
export async function bracket<T, R>(
  acquire: Acquire<T>,
  release: Release<T>,
  fn: UseFn<T, R>,
  options: ResourceOptions = {},
): Promise<R> {
  return runUse(acquire, release, fn, options);
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * The bracket core. The entire guarantee — that release fires exactly once
 * for every successful acquire, and release errors can't mask use errors —
 * lives here.
 */
async function runUse<T, R>(
  acquire: Acquire<T>,
  release: Release<T>,
  fn: UseFn<T, R>,
  options: ResourceOptions,
): Promise<R> {
  const { name, clock, emit } = options;

  const acquireStartMono = clock?.now().monoMs;

  let value: T;
  try {
    value = await acquire();
  } catch (cause) {
    if (emit && clock) {
      safeEmit(emit, {
        type: "resource:acquire-failed",
        name,
        at: clock.now(),
        cause,
      });
    }
    throw cause;
  }

  if (emit && clock && acquireStartMono !== undefined) {
    const now = clock.now();
    safeEmit(emit, {
      type: "resource:acquired",
      name,
      at: now,
      durationMs: now.monoMs - acquireStartMono,
    });
  }

  // Track whether `fn` threw so release-failure emission can report context.
  let useError: unknown = undefined;
  let result: R;
  try {
    result = await fn(value);
  } catch (cause) {
    useError = cause;
    // fall through to release, then re-throw below.
    result = undefined as R; // satisfies the type; never read
  }

  const releaseStartMono = clock?.now().monoMs;

  try {
    await release(value);
    if (emit && clock && releaseStartMono !== undefined) {
      const now = clock.now();
      safeEmit(emit, {
        type: "resource:released",
        name,
        at: now,
        durationMs: now.monoMs - releaseStartMono,
      });
    }
  } catch (releaseCause) {
    // Release failures are visible via events but never thrown — throwing
    // here would mask `useError` and produce confusing stack traces.
    if (emit && clock) {
      safeEmit(emit, {
        type: "resource:release-failed",
        name,
        at: clock.now(),
        cause: releaseCause,
        duringUseError: useError !== undefined,
      });
    }
  }

  if (useError !== undefined) throw useError;
  return result;
}

function safeEmit(emit: (event: ResourceEvent) => void, event: ResourceEvent): void {
  try {
    emit(event);
  } catch {
    // Emitter failures are the emitter's problem; never cascade.
  }
}

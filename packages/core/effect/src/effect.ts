import { randomUUID } from "node:crypto";
import type { Effect, EffectFn, EffectEnv, Result, EmitFn, Fiber, RetryPolicy } from "./types.js";
import { createCancelToken } from "./cancelToken.js";
import { Scope } from "./finalizers.js";
import { createFiber } from "./fiber.js";

export class EffectImpl<E, A> implements Effect<E, A> {
  private readonly id = randomUUID();
  private readonly fn: EffectFn<E, A>;
  private readonly emit: EmitFn | undefined;

  constructor(fn: EffectFn<E, A>, emit?: EmitFn) {
    this.fn = fn;
    this.emit = emit;
  }

  // Public method to access the function for internal use
  public runFn(env: EffectEnv): Promise<Result<E, A>> {
    return this.fn(env);
  }

  async unsafeRunPromise(env: Partial<Omit<EffectEnv, "cancel" | "scope">> = {}): Promise<Result<E, A>> {
    const rootCancel = createCancelToken();
    const rootScope = new Scope();

    const effectEnv: EffectEnv = {
      ...env,
      cancel: rootCancel,
      scope: rootScope,
    };

    this.emit?.({
      type: "effect:start",
      effectId: this.id,
      timestamp: env.clock?.now().wallMs ?? 0,
    });

    let result: Result<E, A>;

    try {
      result = await this.fn(effectEnv);

      if (rootCancel.isCanceled()) {
        result = { _tag: "Err", error: { _tag: "Interrupted" } as E };
      }

      this.emit?.({
        type: "effect:success",
        effectId: this.id,
        timestamp: env.clock?.now().wallMs ?? 0,
      });
    } catch (error) {
      result = { _tag: "Err", error: error as E };

      this.emit?.({
        type: "effect:error",
        effectId: this.id,
        error,
        timestamp: env.clock?.now().wallMs ?? 0,
      });
    }

    // Always run finalizers
    let cause: "interrupted" | "error" | "ok";
    if (rootCancel.isCanceled()) {
      cause = "interrupted";
    } else if (result._tag === "Err") {
      cause = "error";
    } else {
      cause = "ok";
    }

    try {
      await rootScope.close(cause);
    } catch {
      // Ignore finalizer errors
    }

    return result;
  }

  map<B>(fn: (value: A) => B): Effect<E, B> {
    return new EffectImpl<E, B>(async (env) => {
      const result = await this.fn(env);
      if (result._tag === "Err") return result;

      try {
        const mapped = fn(result.value);
        return { _tag: "Ok", value: mapped };
      } catch (error) {
        return { _tag: "Err", error: error as E };
      }
    }, this.emit);
  }

  flatMap<E2, B>(fn: (value: A) => Effect<E2, B>): Effect<E | E2, B> {
    return new EffectImpl<E | E2, B>(async (env) => {
      const result = await this.fn(env);
      if (result._tag === "Err") return result;

      const nextEffect = fn(result.value);
      return (nextEffect as EffectImpl<E2, B>).runFn(env);
    }, this.emit);
  }

  catch<E2, B>(fn: (error: E) => Effect<E2, B>): Effect<E2, A | B> {
    return new EffectImpl<E2, A | B>(async (env) => {
      const result = await this.fn(env);
      if (result._tag === "Ok") return result;

      const recoveryEffect = fn(result.error);
      return (recoveryEffect as EffectImpl<E2, B>).runFn(env);
    }, this.emit);
  }

  timeout(ms: number): Effect<E | { _tag: "Timeout" }, A> {
    return new EffectImpl<E | { _tag: "Timeout" }, A>(async (env) => {
      const childCancel = createCancelToken(env.cancel);
      const childScope = new Scope();
      const childEnv = { ...env, cancel: childCancel, scope: childScope };

      this.emit?.({
        type: "effect:timeout:start",
        effectId: this.id,
        timeoutMs: ms,
        timestamp: env.clock?.now().wallMs ?? 0,
      });

      // timeoutHandle no longer needed since we don't use setTimeout
      let timeoutPromise: Promise<Result<E | { _tag: "Timeout" }, A>>;

      if (env.clock && typeof env.clock.sleep === "function") {
        // Use controlled clock
        timeoutPromise = env.clock.sleep(ms).then(() => {
          childCancel.cancel({ _tag: "Timeout" });
          this.emit?.({
            type: "effect:timeout:triggered",
            effectId: this.id,
            timeoutMs: ms,
            timestamp: env.clock?.now().wallMs ?? 0,
          });
          return { _tag: "Err", error: { _tag: "Timeout" } } as Result<E | { _tag: "Timeout" }, A>;
        });
      } else {
        // Fallback when no clock provided (should not happen in well-formed Effect environments)
        throw new Error("Effect environment must provide a Clock instance");
      }

      // Start effect
      const effectPromise = this.fn(childEnv);

      // Race them
      const result = await Promise.race([effectPromise, timeoutPromise]);

      // Cancel child to clean up any remaining operations
      if (!childCancel.isCanceled()) {
        childCancel.cancel("completed");
      }

      // Cleanup child scope
      let cause: "interrupted" | "error" | "ok";
      if (
        childCancel.isCanceled() &&
        result._tag === "Err" &&
        (result.error as { _tag?: string })?._tag === "Timeout"
      ) {
        cause = "interrupted";
      } else if (result._tag === "Err") {
        cause = "error";
      } else {
        cause = "ok";
      }
      await childScope.close(cause);

      return result;
    }, this.emit);
  }

  fork(): Effect<never, Fiber<E, A>> {
    return this.forkInternal(true);
  }

  onInterrupt(cleanup: () => Effect<never, void>): Effect<E, A> {
    return new EffectImpl<E, A>(async (env) => {
      // Register the cleanup to run on interruption
      const unsubscribe = env.cancel.onCancel(async () => {
        try {
          await cleanup().unsafeRunPromise({ clock: env.clock! });
          // Ignore cleanup result - interruption cleanup should not fail the effect
        } catch {
          // Ignore cleanup errors during interruption
        }
      });

      try {
        const result = await this.fn(env);
        unsubscribe(); // Clean up the cancel listener if we complete normally
        return result;
      } catch (error) {
        unsubscribe(); // Clean up the cancel listener on error
        throw error;
      }
    }, this.emit);
  }

  retry(policy: RetryPolicy): Effect<E | { _tag: "Interrupted" }, A> {
    return new EffectImpl<E | { _tag: "Interrupted" }, A>(async (env) => {
      let lastError: E | undefined;
      let attempt = 0;

      while (attempt < policy.maxAttempts) {
        // Check if we're cancelled before each attempt
        if (env.cancel.isCanceled()) {
          return { _tag: "Err", error: { _tag: "Interrupted" } };
        }

        this.emit?.({
          type: "effect:retry:attempt",
          effectId: this.id,
          attempt: attempt + 1,
          maxAttempts: policy.maxAttempts,
          timestamp: env.clock?.now().wallMs ?? 0,
        });

        const result = await this.fn(env);

        if (result._tag === "Ok") {
          this.emit?.({
            type: "effect:retry:success",
            effectId: this.id,
            attempt: attempt + 1,
            timestamp: env.clock?.now().wallMs ?? 0,
          });
          return result;
        }

        lastError = result.error;
        attempt++;

        // Don't sleep after the last attempt
        if (attempt < policy.maxAttempts) {
          // Calculate delay with exponential backoff
          const baseDelay = policy.baseDelayMs;
          const backoffFactor = policy.backoffFactor ?? 2;
          const maxDelay = policy.maxDelayMs ?? baseDelay * Math.pow(backoffFactor, policy.maxAttempts - 1);

          // Calculate delay: after attempt N, delay = baseDelay * backoffFactor^(N-1)
          const delay = Math.min(baseDelay * Math.pow(backoffFactor, attempt - 1), maxDelay);

          this.emit?.({
            type: "effect:retry:delay",
            effectId: this.id,
            attempt,
            delayMs: delay,
            timestamp: env.clock?.now().wallMs ?? 0,
          });

          // Sleep with the calculated delay
          const sleepResult = await sleep(delay).unsafeRunPromise(env);
          if (sleepResult._tag === "Err") {
            return { _tag: "Err", error: { _tag: "Interrupted" } };
          }

          // If sleep was interrupted, return interrupted
          if (env.cancel.isCanceled()) {
            return { _tag: "Err", error: { _tag: "Interrupted" } };
          }
        }
      }

      this.emit?.({
        type: "effect:retry:exhausted",
        effectId: this.id,
        attempts: policy.maxAttempts,
        timestamp: env.clock?.now().wallMs ?? 0,
      });

      return { _tag: "Err", error: lastError! };
    }, this.emit);
  }

  public forkInternal(registerWithParent: boolean = true): Effect<never, Fiber<E, A>> {
    return effect(async (env) => {
      // Create child cancel token that inherits from parent
      const childCancel = createCancelToken(env.cancel);
      const childScope = new Scope();
      const childEnv = { ...env, cancel: childCancel, scope: childScope };

      // Start the effect in the background
      const promise = this.fn(childEnv).then(async (result) => {
        // Close child scope when effect completes
        let cause: "interrupted" | "error" | "ok";
        if (childCancel.isCanceled()) {
          cause = "interrupted";
        } else if (result._tag === "Err") {
          cause = "error";
        } else {
          cause = "ok";
        }
        try {
          await childScope.close(cause);
        } catch {
          // Ignore finalizer errors
        }
        return result;
      });

      // Create fiber with interrupt capability
      const fiber = createFiber(promise, () => childCancel.cancel("interrupted"));

      // Optionally register fiber with parent scope for automatic cleanup
      if (registerWithParent) {
        env.scope.push(async () => {
          if (!childCancel.isCanceled()) {
            childCancel.cancel("parent-interrupted");
          }
        });
      }

      return { _tag: "Ok", value: fiber };
    });
  }
}

export function effect<E, A>(fn: EffectFn<E, A>, options?: { emit?: EmitFn }): Effect<E, A> {
  return new EffectImpl(fn, options?.emit);
}

export function succeed<A>(value: A, options?: { emit?: EmitFn }): Effect<never, A> {
  return effect(async () => ({ _tag: "Ok", value }), options);
}

export function fail<E>(error: E, options?: { emit?: EmitFn }): Effect<E, never> {
  return effect(async () => ({ _tag: "Err", error }), options);
}

export function fromPromise<A>(promise: Promise<A>, options?: { emit?: EmitFn }): Effect<unknown, A> {
  return effect(async () => {
    try {
      const value = await promise;
      return { _tag: "Ok", value };
    } catch (error) {
      return { _tag: "Err", error };
    }
  }, options);
}

export function sleep(ms: number, options?: { emit?: EmitFn }): Effect<never, void> {
  return effect(async (env) => {
    return new Promise<Result<never, void>>((resolve) => {
      let completed = false;
      const cleanupFns: (() => void)[] = [];

      // Register cancel handler to short-circuit sleep
      const unsubscribe = env.cancel.onCancel(() => {
        if (!completed) {
          completed = true;
          cleanupFns.forEach((cleanup) => cleanup());
          resolve({ _tag: "Ok", value: undefined });
        }
      });

      cleanupFns.push(unsubscribe);

      if (env.clock && typeof env.clock.sleep === "function") {
        // Use controlled clock
        env.clock
          .sleep(ms)
          .then(() => {
            if (!completed) {
              completed = true;
              cleanupFns.forEach((cleanup) => cleanup());
              resolve({ _tag: "Ok", value: undefined });
            }
          })
          .catch(() => {
            // Clock sleep was interrupted, likely by cancellation
            if (!completed) {
              completed = true;
              cleanupFns.forEach((cleanup) => cleanup());
              resolve({ _tag: "Ok", value: undefined });
            }
          });
      } else {
        // Fallback when no clock provided (should not happen in well-formed Effect environments)
        if (!completed) {
          completed = true;
          cleanupFns.forEach((cleanup) => cleanup());
          resolve({ _tag: "Err", error: new Error("Effect environment must provide a Clock instance") } as Result<
            never,
            void
          >);
        }
      }
    });
  }, options);
}

export function all<T extends readonly Effect<unknown, unknown>[]>(
  effects: T,
  options?: { emit?: EmitFn },
): Effect<unknown, unknown[]> {
  return effect(async (env) => {
    if (effects.length === 0) {
      return { _tag: "Ok", value: [] };
    }

    if (effects.length === 1) {
      const result = await effects[0]!.unsafeRunPromise({ clock: env.clock! });
      if (result._tag === "Err") return result;
      return { _tag: "Ok", value: [result.value] };
    }

    const envPartial = env.clock ? { clock: env.clock } : {};

    // Convert each effect to a promise that throws on error for fail-fast behavior
    const promises = effects.map(async (eff, index) => {
      const result = await eff.unsafeRunPromise(envPartial);
      if (result._tag === "Err") {
        // Throw the error to make Promise.all fail fast
        throw { index, error: result.error };
      }
      return { index, value: result.value };
    });

    try {
      const results = await Promise.all(promises);

      // Sort by index to maintain order
      results.sort((a, b) => a.index - b.index);

      return { _tag: "Ok", value: results.map((r) => r.value) };
    } catch (errorInfo: unknown) {
      const errorData = errorInfo as { index: number; error: unknown };
      // Return the first error that occurred
      return { _tag: "Err", error: errorData.error };
    }
  }, options);
}

export function acquireUseRelease<R, E, A, E2>(
  acquire: Effect<E, R>,
  use: (resource: R) => Effect<E2, A>,
  release: (resource: R, cause: "ok" | "error" | "interrupted") => Effect<never, void>,
  options?: { emit?: EmitFn },
): Effect<E | E2, A> {
  return effect<E | E2, A>(async (env) => {
    // First acquire the resource
    const acquireResult = await (acquire as EffectImpl<E, R>).runFn(env);
    if (acquireResult._tag === "Err") {
      return acquireResult;
    }

    const resource = acquireResult.value;

    // Register the release to run when the scope closes - with cause propagation
    env.scope.push(async (cause) => {
      try {
        await (release(resource, cause) as EffectImpl<never, void>).runFn(env);
        // Ignore release result
      } catch {
        // Ignore release errors - they shouldn't fail the effect
      }
    });

    // Use the resource
    try {
      const useResult = await (use(resource) as EffectImpl<E2, A>).runFn(env);
      return useResult;
    } catch (error) {
      // Use failed, but release will still be called via the finalizer
      return { _tag: "Err", error: error as E | E2 };
    }
  }, options);
}

export function race<T extends readonly Effect<unknown, unknown>[]>(
  effects: T,
  options?: { emit?: EmitFn },
): Effect<unknown, unknown> {
  return effect(async (env) => {
    if (effects.length === 0) {
      // Empty race - hang forever (this is the standard behavior)
      return new Promise(() => {});
    }

    if (effects.length === 1) {
      // Single effect - just run it
      return (effects[0] as EffectImpl<unknown, unknown>).runFn(env);
    }

    // Fork all effects to run them concurrently (without parent scope auto-cleanup)
    const forkResults = await Promise.all(
      effects.map(async (effect) => {
        const forkResult = await (effect as EffectImpl<unknown, unknown>)
          .forkInternal(false)
          .unsafeRunPromise({ clock: env.clock! });
        if (forkResult._tag === "Err") throw forkResult.error;
        return forkResult.value;
      }),
    );

    const fibers = forkResults;
    let raceCompleted = false;

    // Register a finalizer to cancel all fibers if the race itself is cancelled
    env.scope.push(async (cause) => {
      // Only cancel on interruption, not on normal completion
      if (cause === "interrupted") {
        const cancelPromises = fibers.map(async (fiber) => {
          try {
            await fiber.interrupt().unsafeRunPromise({ clock: env.clock! });
          } catch {
            // Ignore interrupt errors
          }
        });
        await Promise.allSettled(cancelPromises);
      }
    });

    try {
      // Race all the fiber results
      const winnerResult = await Promise.race(
        fibers.map(async (fiber, index) => {
          const result = await fiber.join().unsafeRunPromise({ clock: env.clock! });
          return { result, index };
        }),
      );

      raceCompleted = true;

      // Cancel all other fibers (the losers) but NOT the winner
      const cancelPromises = fibers.map(async (fiber, index) => {
        if (index !== winnerResult.index) {
          try {
            await fiber.interrupt().unsafeRunPromise({ clock: env.clock! });
          } catch {
            // Ignore interrupt errors
          }
        }
      });

      await Promise.allSettled(cancelPromises);

      return winnerResult.result;
    } catch (error) {
      // If something goes wrong, cancel all fibers
      if (!raceCompleted) {
        const cancelPromises = fibers.map(async (fiber) => {
          try {
            await fiber.interrupt().unsafeRunPromise({ clock: env.clock! });
          } catch {
            // Ignore interrupt errors
          }
        });

        await Promise.allSettled(cancelPromises);
      }
      throw error;
    }
  }, options);
}

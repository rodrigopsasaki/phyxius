import { randomUUID } from "node:crypto";
import type { Effect, EffectFn, Context, EmitFn } from "./types.js";
import { createContext } from "./context.js";
import { createScope } from "./scope.js";

export class EffectImpl<T> implements Effect<T> {
  private readonly id = randomUUID();
  private readonly fn: EffectFn<T>;
  private readonly emit: EmitFn | undefined;

  constructor(fn: EffectFn<T>, emit?: EmitFn) {
    this.fn = fn;
    this.emit = emit;
  }

  async run(context: Context = createContext()): Promise<T> {
    const scope = createScope();

    this.emit?.({
      type: "effect:start",
      effectId: this.id,
      scopeId: scope.id,
      timestamp: Date.now(),
    });

    try {
      const result = await this.fn(context);

      this.emit?.({
        type: "effect:success",
        effectId: this.id,
        scopeId: scope.id,
        timestamp: Date.now(),
      });

      return result;
    } catch (error) {
      this.emit?.({
        type: "effect:error",
        effectId: this.id,
        scopeId: scope.id,
        error,
        timestamp: Date.now(),
      });

      throw error;
    } finally {
      if (!scope.isCancelled()) {
        scope.cancel();
      }
    }
  }

  map<U>(fn: (value: T) => U): Effect<U> {
    return new EffectImpl<U>(async (context) => {
      const value = await this.fn(context);
      return fn(value);
    }, this.emit);
  }

  flatMap<U>(fn: (value: T) => Effect<U>): Effect<U> {
    return new EffectImpl<U>(async (context) => {
      const value = await this.fn(context);
      const nextEffect = fn(value);
      return nextEffect.run(context);
    }, this.emit);
  }

  catch<U>(fn: (error: Error) => Effect<U>): Effect<T | U> {
    return new EffectImpl<T | U>(async (context) => {
      try {
        return await this.fn(context);
      } catch (error) {
        if (error instanceof Error) {
          const recoveryEffect = fn(error);
          return recoveryEffect.run(context);
        }
        throw error;
      }
    }, this.emit);
  }

  timeout(ms: number): Effect<T> {
    return new EffectImpl<T>(async (context) => {
      const scope = createScope();
      let timeoutId: NodeJS.Timeout;

      this.emit?.({
        type: "effect:timeout:start",
        effectId: this.id,
        timeoutMs: ms,
        timestamp: Date.now(),
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          scope.cancel();
          this.emit?.({
            type: "effect:timeout:triggered",
            effectId: this.id,
            timeoutMs: ms,
            timestamp: Date.now(),
          });
          reject(new Error(`Effect timed out after ${ms}ms`));
        }, ms);
      });

      const effectPromise = this.fn(context).finally(() => {
        clearTimeout(timeoutId);
      });

      scope.onCancel(() => {
        clearTimeout(timeoutId);
      });

      return Promise.race([effectPromise, timeoutPromise]);
    }, this.emit);
  }

  withContext<U>(key: string, value: U): Effect<T> {
    return new EffectImpl<T>(async (context) => {
      const newContext = context.with(key, value);
      return this.fn(newContext);
    }, this.emit);
  }
}

export function effect<T>(fn: EffectFn<T>, options?: { emit?: EmitFn }): Effect<T> {
  return new EffectImpl(fn, options?.emit);
}

export function succeed<T>(value: T, options?: { emit?: EmitFn }): Effect<T> {
  return effect(async () => value, options);
}

export function fail<T = never>(error: Error, options?: { emit?: EmitFn }): Effect<T> {
  return effect(async () => {
    throw error;
  }, options);
}

export function fromPromise<T>(promise: Promise<T>, options?: { emit?: EmitFn }): Effect<T> {
  return effect(async () => promise, options);
}

export function all<T extends readonly Effect<any>[]>(
  effects: T,
  options?: { emit?: EmitFn },
): Effect<{ [K in keyof T]: T[K] extends Effect<infer U> ? U : never }> {
  return effect(async (context) => {
    const promises = effects.map((eff) => eff.run(context));
    return Promise.all(promises) as any;
  }, options);
}

export function race<T extends readonly Effect<any>[]>(
  effects: T,
  options?: { emit?: EmitFn },
): Effect<T[number] extends Effect<infer U> ? U : never> {
  return effect(async (context) => {
    const promises = effects.map((eff) => eff.run(context));
    return Promise.race(promises) as any;
  }, options);
}

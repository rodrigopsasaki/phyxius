import { randomUUID } from "node:crypto";
import type { Fiber, Effect, Result } from "./types.js";
import { effect } from "./effect.js";

export class FiberImpl<E, A> implements Fiber<E, A> {
  readonly id: string;
  private promise: Promise<Result<E, A>>;
  private result: Result<E, A> | undefined;
  private readonly cancelFn: () => void;
  private interruptPromise: Promise<void> | undefined;

  constructor(promise: Promise<Result<E, A>>, cancelFn: () => void) {
    this.id = randomUUID();
    this.promise = promise;
    this.cancelFn = cancelFn;

    // Store result when promise completes - use queueMicrotask for immediate scheduling
    promise
      .then((result) => {
        queueMicrotask(() => {
          this.result = result;
        });
      })
      .catch((error) => {
        queueMicrotask(() => {
          this.result = { _tag: "Err", error };
        });
      });
  }

  join(): Effect<E, A> {
    return effect(async () => {
      const result = await this.promise;
      return result;
    });
  }

  interrupt(): Effect<never, void> {
    return effect(async () => {
      if (!this.interruptPromise) {
        this.interruptPromise = this._performInterrupt();
      }
      await this.interruptPromise;
      return { _tag: "Ok", value: undefined };
    });
  }

  private async _performInterrupt(): Promise<void> {
    this.cancelFn();
    // Wait for the fiber's promise to complete (including finalizers)
    // Note: This method is internal and should only be called from interrupt() which has access to Effect environment
    // For now, we'll use immediate resolution since proper timeout requires Clock from Effect environment
    try {
      await Promise.race([
        this.promise.catch(() => {
          // Ignore the result, we just want to wait for completion
        }),
        Promise.resolve(), // Complete immediately rather than using setTimeout
      ]);
    } catch {
      // Ignore any errors during interrupt
    }
  }

  poll(): Effect<never, Result<E, A> | undefined> {
    return effect(async () => {
      // Check if promise is already resolved
      if (this.result !== undefined) {
        return { _tag: "Ok", value: this.result };
      }

      // Try to get the result without blocking
      const settled = await Promise.race([
        this.promise.then((result) => ({ resolved: true, result })),
        Promise.resolve({ resolved: false, result: undefined }),
      ]);

      if (settled.resolved) {
        this.result = settled.result;
        return { _tag: "Ok", value: settled.result };
      }

      return { _tag: "Ok", value: undefined };
    });
  }
}

export function createFiber<E, A>(promise: Promise<Result<E, A>>, cancelFn: () => void): Fiber<E, A> {
  return new FiberImpl(promise, cancelFn);
}

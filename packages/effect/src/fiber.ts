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

    // Store result when promise completes
    promise
      .then((result) => {
        this.result = result;
      })
      .catch((error) => {
        this.result = { _tag: "Err", error };
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
    // Use a reasonable timeout to avoid hanging indefinitely
    try {
      await Promise.race([
        this.promise.catch(() => {
          // Ignore the result, we just want to wait for completion
        }),
        new Promise((resolve) => setTimeout(resolve, 100)), // 100ms timeout
      ]);
    } catch {
      // Ignore any errors during interrupt
    }
  }

  poll(): Effect<never, Result<E, A> | undefined> {
    return effect(async () => {
      return { _tag: "Ok", value: this.result };
    });
  }
}

export function createFiber<E, A>(promise: Promise<Result<E, A>>, cancelFn: () => void): Fiber<E, A> {
  return new FiberImpl(promise, cancelFn);
}

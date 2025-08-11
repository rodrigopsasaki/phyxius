import { randomUUID } from "node:crypto";
import type { Fiber, Effect, Result } from "./types.js";
import { effect } from "./effect.js";

export class FiberImpl<E, A> implements Fiber<E, A> {
  readonly id: string;
  private promise: Promise<Result<E, A>>;
  private result: Result<E, A> | undefined;
  private readonly cancelFn: () => void;

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
      this.cancelFn();
      return { _tag: "Ok", value: undefined };
    });
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

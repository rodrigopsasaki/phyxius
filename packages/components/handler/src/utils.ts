import type { Effect } from "@phyxiusjs/effect";
import { HandlerError } from "./types.js";

/**
 * Simple Promise to Effect converter.
 * Creates basic Effects without full composition support.
 */
export function promiseToEffect<T>(promise: Promise<T>): Effect<HandlerError, T> {
  return {
    unsafeRunPromise: async () => {
      try {
        const value = await promise;
        return { _tag: "Ok", value };
      } catch (error) {
        // If it's already a HandlerError, preserve it
        if (error instanceof HandlerError) {
          return { _tag: "Err", error };
        }

        return {
          _tag: "Err",
          error: new HandlerError(error instanceof Error ? error.message : "Unknown error", "PROCESSOR_ERROR", error),
        };
      }
    },
    // Minimal implementations to satisfy the interface
    map: () => {
      throw new Error("Map not implemented in simple utils");
    },
    flatMap: () => {
      throw new Error("FlatMap not implemented in simple utils");
    },
    catch: () => {
      throw new Error("Catch not implemented in simple utils");
    },
    timeout: () => {
      throw new Error("Timeout not implemented in simple utils");
    },
    fork: () => {
      throw new Error("Fork not implemented in simple utils");
    },
    onInterrupt: () => {
      throw new Error("OnInterrupt not implemented in simple utils");
    },
    retry: () => {
      throw new Error("Retry not implemented in simple utils");
    },
  };
}

/**
 * Utility functions for Handler operations.
 */
export class EffectUtils {
  /**
   * Convert a Promise to an Effect.
   */
  static fromPromise<T>(promise: Promise<T>): Effect<HandlerError, T> {
    return promiseToEffect(promise);
  }

  /**
   * Create a successful Effect.
   */
  static succeed<T>(value: T): Effect<never, T> {
    return promiseToEffect(Promise.resolve(value)) as Effect<never, T>;
  }

  /**
   * Create a failed Effect.
   */
  static fail<E>(error: E): Effect<E, never> {
    return promiseToEffect(Promise.reject(error)) as Effect<E, never>;
  }
}

/**
 * Generate unique correlation IDs for work units.
 */
export function generateCorrelationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2);
  return `${timestamp}-${random}`;
}

/**
 * Generate unique handler IDs.
 */
export function generateHandlerId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2);
  return `handler-${timestamp}-${random}`;
}

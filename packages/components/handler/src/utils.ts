import type { Effect } from "@phyxiusjs/effect";
import { effect, fromPromise, fail } from "@phyxiusjs/effect";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { ok, err, type Result } from "@phyxiusjs/fp";
import { HandlerError } from "./types.js";

/**
 * Convert a Promise to an Effect with proper error handling.
 */
export function promiseToEffect<T>(promise: Promise<T>): Effect<HandlerError, T> {
  return fromPromise(promise).catch((error: unknown) => {
    if (error instanceof HandlerError) {
      return fail(error);
    }
    return fail(new HandlerError(error instanceof Error ? error.message : "Unknown error", "PROCESSOR_ERROR", error));
  });
}

/**
 * Generate unique correlation IDs using Clock for time operations.
 */
export function generateCorrelationId(clock: Clock): string {
  const timestamp = clock.now().monoMs.toString(36);
  const random = Math.random().toString(36).substring(2);
  return `${timestamp}-${random}`;
}

/**
 * Generate unique handler IDs using Clock for time operations.
 */
export function generateHandlerId(clock: Clock): string {
  const timestamp = clock.now().monoMs.toString(36);
  const random = Math.random().toString(36).substring(2);
  return `handler-${timestamp}-${random}`;
}

/**
 * Create an Effect that delays execution using Clock.
 */
export function delay<T>(delayMs: Millis, value: T, clock: Clock): Effect<HandlerError, T> {
  return effect(async () => {
    await clock.sleep(delayMs);
    return { _tag: "Ok", value };
  });
}

/**
 * Utility for safely parsing JSON with Result type.
 */
export function safeJsonParse<T>(jsonString: string): Result<T, HandlerError> {
  try {
    const parsed = JSON.parse(jsonString) as T;
    return ok(parsed);
  } catch (error) {
    return err(
      new HandlerError(
        `JSON parse error: ${error instanceof Error ? error.message : "Invalid JSON"}`,
        "PROCESSOR_ERROR",
        error,
      ),
    );
  }
}

/**
 * Utility for safely stringifying JSON with Result type.
 */
export function safeJsonStringify<T>(value: T): Result<string, HandlerError> {
  try {
    const stringified = JSON.stringify(value);
    return ok(stringified);
  } catch (error) {
    return err(
      new HandlerError(
        `JSON stringify error: ${error instanceof Error ? error.message : "Serialization failed"}`,
        "PROCESSOR_ERROR",
        error,
      ),
    );
  }
}

/**
 * Create a race effect that resolves with the first successful result.
 */
export function raceEffects<T>(effects: Effect<HandlerError, T>[]): Effect<HandlerError, T> {
  if (effects.length === 0) {
    return effect(async () => ({
      _tag: "Err" as const,
      error: new HandlerError("No effects to race", "PROCESSOR_ERROR"),
    }));
  }

  return effect(async (env) => {
    const promises = effects.map((eff) => eff.unsafeRunPromise(env));
    const result = await Promise.race(promises);
    return result;
  });
}

/**
 * Create an all-or-nothing effect that succeeds only if all effects succeed.
 */
export function allEffects<T>(effects: Effect<HandlerError, T>[]): Effect<HandlerError, T[]> {
  if (effects.length === 0) {
    return effect(async () => ({ _tag: "Ok" as const, value: [] }));
  }

  return effect(async (env) => {
    const promises = effects.map((eff) => eff.unsafeRunPromise(env));
    const results = await Promise.all(promises);

    // Check if any failed
    const failures = results.filter((result) => result._tag === "Err");
    if (failures.length > 0) {
      const firstFailure = failures[0] as { _tag: "Err"; error: HandlerError };
      return { _tag: "Err" as const, error: firstFailure.error };
    }

    // Extract successful values
    const values = results.map((result) => {
      if (result._tag === "Ok") {
        return result.value;
      }
      throw new Error("Unexpected result type");
    });

    return { _tag: "Ok" as const, value: values };
  });
}

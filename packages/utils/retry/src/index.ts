import type { Clock, Millis } from "@phyxiusjs/clock";
import { ok, err, type Result } from "@phyxiusjs/fp";

// ── Policy as data ──────────────────────────────────────────────────────────

/**
 * A retry policy is a value, not a function. You pass it to `runWithRetry`
 * which interprets it.
 *
 * Every policy has:
 *   - `maxAttempts` — total attempts including the first (1 = no retry)
 *   - `delay(attemptNumber) → Millis` — how long to wait before attempt N
 *     (attempt 1 runs immediately; delays apply before attempts 2..maxAttempts)
 *   - `shouldRetry(error, attemptNumber) → boolean` — optional predicate to
 *     decide whether an error is retryable at all
 *
 * Use the factories (`fixed`, `exponential`, `none`) rather than constructing
 * policies by hand — they enforce the invariants (maxAttempts ≥ 1, etc.).
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  delay(attempt: number): Millis;
  shouldRetry?(error: unknown, attempt: number): boolean;
}

// ── Factories ───────────────────────────────────────────────────────────────

export const retry = {
  /**
   * Explicit "no retry" policy. Runs the function exactly once. Use when you
   * want to declare "I've decided not to retry" rather than leaving the field
   * defaulted — the explicit statement is the whole point.
   */
  none(): RetryPolicy {
    return {
      maxAttempts: 1,
      delay: () => 0 as Millis,
    };
  },

  /**
   * Fixed delay between attempts.
   */
  fixed(options: {
    maxAttempts: number;
    delay: Millis;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  }): RetryPolicy {
    if (options.maxAttempts < 1) {
      throw new Error(`retry.fixed: maxAttempts must be >= 1 (got ${options.maxAttempts})`);
    }
    const policy: RetryPolicy = {
      maxAttempts: options.maxAttempts,
      delay: () => options.delay,
    };
    if (options.shouldRetry) {
      return { ...policy, shouldRetry: options.shouldRetry };
    }
    return policy;
  },

  /**
   * Exponential backoff with optional jitter and maxDelay cap.
   *
   * Delay before attempt N (N >= 2) is:
   *   min(maxDelay, initialDelay * factor^(N-2)) * (1 ± jitter)
   *
   * Default factor is 2, default maxDelay is 30_000ms, default jitter is 0.
   */
  exponential(options: {
    maxAttempts: number;
    initialDelay: Millis;
    maxDelay?: Millis;
    factor?: number;
    jitter?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  }): RetryPolicy {
    if (options.maxAttempts < 1) {
      throw new Error(`retry.exponential: maxAttempts must be >= 1 (got ${options.maxAttempts})`);
    }

    const maxDelay = options.maxDelay ?? (30_000 as Millis);
    const factor = options.factor ?? 2;
    const jitterPct = options.jitter ?? 0;

    if (factor < 1) {
      throw new Error(`retry.exponential: factor must be >= 1 (got ${factor})`);
    }
    if (jitterPct < 0 || jitterPct > 1) {
      throw new Error(`retry.exponential: jitter must be in [0, 1] (got ${jitterPct})`);
    }

    const policy: RetryPolicy = {
      maxAttempts: options.maxAttempts,
      delay: (attempt: number): Millis => {
        // `attempt` is 1-based. Attempt 1 has no preceding delay.
        // Attempt 2 waits `initialDelay`, attempt 3 waits `initialDelay * factor`, etc.
        if (attempt <= 1) return 0 as Millis;
        const exponent = attempt - 2;
        const base = options.initialDelay * Math.pow(factor, exponent);
        const capped = Math.min(base, maxDelay);
        if (jitterPct === 0) return capped as Millis;
        // Jitter: [-jitterPct, +jitterPct] applied to the capped value.
        const jitterAmount = capped * jitterPct;
        const offset = (Math.random() * 2 - 1) * jitterAmount;
        return Math.max(0, capped + offset) as Millis;
      },
    };
    if (options.shouldRetry) {
      return { ...policy, shouldRetry: options.shouldRetry };
    }
    return policy;
  },
};

// ── Executor ────────────────────────────────────────────────────────────────

/**
 * Structured outcome of a `runWithRetry` call.
 */
export type RetryError =
  | {
      readonly type: "EXHAUSTED";
      readonly attempts: number;
      readonly lastError: unknown;
    }
  | {
      readonly type: "REJECTED";
      readonly attempts: number;
      readonly error: unknown;
    }
  | {
      readonly type: "ABORTED";
      readonly attempts: number;
      readonly lastError: unknown;
    };

/**
 * Run `fn` under the given retry policy.
 *
 *   - Returns `Ok(value)` on success (first or any retry)
 *   - Returns `Err({ type: "EXHAUSTED", ... })` when maxAttempts runs out
 *   - Returns `Err({ type: "REJECTED", ... })` when `shouldRetry` says no
 *   - Returns `Err({ type: "ABORTED", ... })` if `signal` aborts mid-wait
 *
 * The inter-attempt delay is `clock.sleep`, so retry timing is deterministic
 * under a controlled clock. If a `signal` is passed, aborting it cancels the
 * wait and the next attempt is not made.
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  clock: Clock,
  options?: { signal?: AbortSignal },
): Promise<Result<T, RetryError>> {
  const signal = options?.signal;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (signal?.aborted) {
      return err({ type: "ABORTED", attempts: attempt - 1, lastError });
    }

    try {
      const value = await fn();
      return ok(value);
    } catch (error) {
      lastError = error;

      const isLast = attempt === policy.maxAttempts;
      if (isLast) {
        return err({ type: "EXHAUSTED", attempts: attempt, lastError: error });
      }

      if (policy.shouldRetry && !policy.shouldRetry(error, attempt)) {
        return err({ type: "REJECTED", attempts: attempt, error });
      }

      // Compute and wait the delay before the NEXT attempt (attempt + 1).
      const delay = policy.delay(attempt + 1);
      if (delay > 0) {
        const aborted = await sleepOrAbort(clock, delay, signal);
        if (aborted) {
          return err({ type: "ABORTED", attempts: attempt, lastError: error });
        }
      }
    }
  }

  // Unreachable — loop either returns or falls through maxAttempts which
  // is handled by the `isLast` branch above.
  return err({
    type: "EXHAUSTED",
    attempts: policy.maxAttempts,
    lastError,
  });
}

async function sleepOrAbort(clock: Clock, delay: Millis, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) {
    await clock.sleep(delay);
    return false;
  }
  if (signal.aborted) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    clock.sleep(delay).then(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    });
  });
}

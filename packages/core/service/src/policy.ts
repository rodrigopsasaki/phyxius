import type { FunctionPolicy, RetryPolicy, CircuitBreakerPolicy, RetryCondition } from "./types.js";
import type { Millis } from "@phyxiusjs/clock";
import { ms } from "@phyxiusjs/clock";

/**
 * Validate a function policy
 */
export function validatePolicy(policy: FunctionPolicy): void {
  // Validate timeout
  if (policy.timeout !== "none") {
    if (typeof policy.timeout !== "number" || policy.timeout <= 0) {
      throw new Error(`Invalid timeout: must be a positive number or "none", got ${policy.timeout}`);
    }
  }

  // Validate retry
  if (policy.retry !== "none") {
    validateRetryPolicy(policy.retry);
  }

  // Validate circuit breaker
  if (policy.circuitBreaker !== "none") {
    validateCircuitBreakerPolicy(policy.circuitBreaker);
  }
}

/**
 * Validate retry policy
 */
function validateRetryPolicy(policy: RetryPolicy): void {
  if (typeof policy.attempts !== "number" || policy.attempts < 0 || !Number.isInteger(policy.attempts)) {
    throw new Error(`Invalid retry attempts: must be a non-negative integer, got ${policy.attempts}`);
  }

  const validBackoffs = ["fixed", "linear", "exponential"];
  if (!validBackoffs.includes(policy.backoff)) {
    throw new Error(`Invalid backoff strategy: must be one of ${validBackoffs.join(", ")}, got ${policy.backoff}`);
  }

  if (policy.baseDelay !== undefined && (typeof policy.baseDelay !== "number" || policy.baseDelay < 0)) {
    throw new Error(`Invalid baseDelay: must be a non-negative number, got ${policy.baseDelay}`);
  }

  if (policy.maxDelay !== undefined && (typeof policy.maxDelay !== "number" || policy.maxDelay < 0)) {
    throw new Error(`Invalid maxDelay: must be a non-negative number, got ${policy.maxDelay}`);
  }

  if (policy.on.length === 0) {
    throw new Error("Retry policy must specify at least one condition in 'on'");
  }

  const validConditions: RetryCondition[] = [
    "TIMEOUT",
    "CONNECTION_ERROR",
    "RATE_LIMITED",
    "SERVER_ERROR",
    "UNKNOWN_ERROR",
  ];
  for (const condition of policy.on) {
    if (!validConditions.includes(condition)) {
      throw new Error(`Invalid retry condition: ${condition}. Valid conditions: ${validConditions.join(", ")}`);
    }
  }
}

/**
 * Validate circuit breaker policy
 */
function validateCircuitBreakerPolicy(policy: CircuitBreakerPolicy): void {
  if (typeof policy.threshold !== "number" || policy.threshold <= 0 || !Number.isInteger(policy.threshold)) {
    throw new Error(`Invalid circuit breaker threshold: must be a positive integer, got ${policy.threshold}`);
  }

  if (typeof policy.resetAfter !== "number" || policy.resetAfter <= 0) {
    throw new Error(`Invalid circuit breaker resetAfter: must be a positive number, got ${policy.resetAfter}`);
  }
}

/**
 * Calculate delay for a retry attempt based on the policy
 */
export function calculateRetryDelay(policy: RetryPolicy, attempt: number): Millis {
  const baseDelay = policy.baseDelay ?? ms(100);
  const maxDelay = policy.maxDelay ?? ms(30000);

  let delay: number;

  switch (policy.backoff) {
    case "fixed":
      delay = baseDelay;
      break;
    case "linear":
      delay = baseDelay * attempt;
      break;
    case "exponential":
      delay = baseDelay * Math.pow(2, attempt - 1);
      break;
  }

  // Add jitter (10% random variation)
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  delay = Math.round(delay + jitter);

  // Cap at maxDelay
  return Math.min(delay, maxDelay) as Millis;
}

/**
 * Check if an error should trigger a retry based on the policy
 */
export function shouldRetry(
  policy: RetryPolicy,
  errorCode: string,
  attempt: number,
): boolean {
  if (attempt >= policy.attempts) {
    return false;
  }

  // Map error codes to retry conditions
  const conditionMap: Record<string, RetryCondition> = {
    TIMEOUT: "TIMEOUT",
    CONNECTION_ERROR: "CONNECTION_ERROR",
    RATE_LIMITED: "RATE_LIMITED",
    INTERNAL_ERROR: "SERVER_ERROR",
  };

  const condition = conditionMap[errorCode] ?? "UNKNOWN_ERROR";
  return policy.on.includes(condition);
}

/**
 * Create a "no policy" constant for explicit opt-out
 */
export const NO_RETRY = "none" as const;
export const NO_TIMEOUT = "none" as const;
export const NO_CIRCUIT_BREAKER = "none" as const;

/**
 * Helper to create a standard retry policy
 */
export function retryPolicy(options: {
  attempts: number;
  backoff?: "fixed" | "linear" | "exponential";
  baseDelay?: Millis;
  maxDelay?: Millis;
  on: readonly RetryCondition[];
}): RetryPolicy {
  return {
    attempts: options.attempts,
    backoff: options.backoff ?? "exponential",
    ...(options.baseDelay !== undefined && { baseDelay: options.baseDelay }),
    ...(options.maxDelay !== undefined && { maxDelay: options.maxDelay }),
    on: options.on,
  };
}

/**
 * Helper to create a standard circuit breaker policy
 */
export function circuitBreakerPolicy(options: {
  threshold: number;
  resetAfter: Millis;
}): CircuitBreakerPolicy {
  return {
    threshold: options.threshold,
    resetAfter: options.resetAfter,
  };
}

import { describe, it, expect } from "vitest";
import { ms } from "@phyxiusjs/clock";
import {
  validatePolicy,
  calculateRetryDelay,
  shouldRetry,
  retryPolicy,
  circuitBreakerPolicy,
  NO_RETRY,
  NO_TIMEOUT,
  NO_CIRCUIT_BREAKER,
} from "../src/policy.js";

describe("validatePolicy", () => {
  describe("timeout validation", () => {
    it("should accept valid timeout", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(5000),
          retry: "none",
          circuitBreaker: "none",
        }),
      ).not.toThrow();
    });

    it("should accept timeout: none", () => {
      expect(() =>
        validatePolicy({
          timeout: "none",
          retry: "none",
          circuitBreaker: "none",
        }),
      ).not.toThrow();
    });

    it("should reject negative timeout", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(-100),
          retry: "none",
          circuitBreaker: "none",
        }),
      ).toThrow("Invalid timeout");
    });

    it("should reject zero timeout", () => {
      expect(() =>
        validatePolicy({
          timeout: 0 as never,
          retry: "none",
          circuitBreaker: "none",
        }),
      ).toThrow("Invalid timeout");
    });
  });

  describe("retry validation", () => {
    it("should accept valid retry policy", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: { attempts: 3, backoff: "exponential", on: ["TIMEOUT"] },
          circuitBreaker: "none",
        }),
      ).not.toThrow();
    });

    it("should accept retry: none", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: "none",
          circuitBreaker: "none",
        }),
      ).not.toThrow();
    });

    it("should reject negative attempts", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: { attempts: -1, backoff: "exponential", on: ["TIMEOUT"] },
          circuitBreaker: "none",
        }),
      ).toThrow("Invalid retry attempts");
    });

    it("should reject invalid backoff strategy", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: { attempts: 3, backoff: "invalid" as "exponential", on: ["TIMEOUT"] },
          circuitBreaker: "none",
        }),
      ).toThrow("Invalid backoff strategy");
    });

    it("should reject empty retry conditions", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: { attempts: 3, backoff: "exponential", on: [] },
          circuitBreaker: "none",
        }),
      ).toThrow("at least one condition");
    });

    it("should reject invalid retry condition", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: { attempts: 3, backoff: "exponential", on: ["INVALID" as "TIMEOUT"] },
          circuitBreaker: "none",
        }),
      ).toThrow("Invalid retry condition");
    });

    it("should reject negative baseDelay", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: { attempts: 3, backoff: "exponential", baseDelay: ms(-100), on: ["TIMEOUT"] },
          circuitBreaker: "none",
        }),
      ).toThrow("Invalid baseDelay");
    });

    it("should reject negative maxDelay", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: { attempts: 3, backoff: "exponential", maxDelay: ms(-100), on: ["TIMEOUT"] },
          circuitBreaker: "none",
        }),
      ).toThrow("Invalid maxDelay");
    });
  });

  describe("circuit breaker validation", () => {
    it("should accept valid circuit breaker policy", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: "none",
          circuitBreaker: { threshold: 5, resetAfter: ms(30000) },
        }),
      ).not.toThrow();
    });

    it("should accept circuitBreaker: none", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: "none",
          circuitBreaker: "none",
        }),
      ).not.toThrow();
    });

    it("should reject zero threshold", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: "none",
          circuitBreaker: { threshold: 0, resetAfter: ms(30000) },
        }),
      ).toThrow("Invalid circuit breaker threshold");
    });

    it("should reject negative threshold", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: "none",
          circuitBreaker: { threshold: -1, resetAfter: ms(30000) },
        }),
      ).toThrow("Invalid circuit breaker threshold");
    });

    it("should reject zero resetAfter", () => {
      expect(() =>
        validatePolicy({
          timeout: ms(1000),
          retry: "none",
          circuitBreaker: { threshold: 5, resetAfter: 0 as never },
        }),
      ).toThrow("Invalid circuit breaker resetAfter");
    });
  });
});

describe("calculateRetryDelay", () => {
  it("should calculate fixed delay", () => {
    const policy = retryPolicy({
      attempts: 3,
      backoff: "fixed",
      baseDelay: ms(100),
      on: ["TIMEOUT"],
    });

    // Fixed backoff should always return baseDelay (with some jitter)
    const delay1 = calculateRetryDelay(policy, 1);
    const delay2 = calculateRetryDelay(policy, 2);
    const delay3 = calculateRetryDelay(policy, 3);

    // Allow 10% jitter variance
    expect(delay1).toBeGreaterThanOrEqual(90);
    expect(delay1).toBeLessThanOrEqual(110);
    expect(delay2).toBeGreaterThanOrEqual(90);
    expect(delay2).toBeLessThanOrEqual(110);
    expect(delay3).toBeGreaterThanOrEqual(90);
    expect(delay3).toBeLessThanOrEqual(110);
  });

  it("should calculate linear delay", () => {
    const policy = retryPolicy({
      attempts: 3,
      backoff: "linear",
      baseDelay: ms(100),
      on: ["TIMEOUT"],
    });

    // Linear: baseDelay * attempt
    const delay1 = calculateRetryDelay(policy, 1);
    const delay2 = calculateRetryDelay(policy, 2);
    const delay3 = calculateRetryDelay(policy, 3);

    // Allow jitter variance
    expect(delay1).toBeGreaterThanOrEqual(90);
    expect(delay1).toBeLessThanOrEqual(110);
    expect(delay2).toBeGreaterThanOrEqual(180);
    expect(delay2).toBeLessThanOrEqual(220);
    expect(delay3).toBeGreaterThanOrEqual(270);
    expect(delay3).toBeLessThanOrEqual(330);
  });

  it("should calculate exponential delay", () => {
    const policy = retryPolicy({
      attempts: 3,
      backoff: "exponential",
      baseDelay: ms(100),
      on: ["TIMEOUT"],
    });

    // Exponential: baseDelay * 2^(attempt-1)
    const delay1 = calculateRetryDelay(policy, 1); // 100
    const delay2 = calculateRetryDelay(policy, 2); // 200
    const delay3 = calculateRetryDelay(policy, 3); // 400

    // Allow jitter variance
    expect(delay1).toBeGreaterThanOrEqual(90);
    expect(delay1).toBeLessThanOrEqual(110);
    expect(delay2).toBeGreaterThanOrEqual(180);
    expect(delay2).toBeLessThanOrEqual(220);
    expect(delay3).toBeGreaterThanOrEqual(360);
    expect(delay3).toBeLessThanOrEqual(440);
  });

  it("should cap at maxDelay", () => {
    const policy = retryPolicy({
      attempts: 10,
      backoff: "exponential",
      baseDelay: ms(1000),
      maxDelay: ms(5000),
      on: ["TIMEOUT"],
    });

    // 1000 * 2^9 = 512000, should be capped at 5000
    const delay = calculateRetryDelay(policy, 10);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("should use default values when not specified", () => {
    const policy = retryPolicy({
      attempts: 3,
      backoff: "exponential",
      on: ["TIMEOUT"],
    });

    // Should use default baseDelay of 100ms
    const delay = calculateRetryDelay(policy, 1);
    expect(delay).toBeGreaterThanOrEqual(90);
    expect(delay).toBeLessThanOrEqual(110);
  });
});

describe("shouldRetry", () => {
  const policy = retryPolicy({
    attempts: 3,
    backoff: "exponential",
    on: ["TIMEOUT", "CONNECTION_ERROR"],
  });

  it("should return true for matching condition within attempts", () => {
    expect(shouldRetry(policy, "TIMEOUT", 0)).toBe(true);
    expect(shouldRetry(policy, "TIMEOUT", 1)).toBe(true);
    expect(shouldRetry(policy, "TIMEOUT", 2)).toBe(true);
  });

  it("should return false when attempts exhausted", () => {
    expect(shouldRetry(policy, "TIMEOUT", 3)).toBe(false);
    expect(shouldRetry(policy, "TIMEOUT", 4)).toBe(false);
  });

  it("should return false for non-matching condition", () => {
    expect(shouldRetry(policy, "RATE_LIMITED", 0)).toBe(false);
  });

  it("should map INTERNAL_ERROR to SERVER_ERROR", () => {
    const serverPolicy = retryPolicy({
      attempts: 3,
      backoff: "exponential",
      on: ["SERVER_ERROR"],
    });

    expect(shouldRetry(serverPolicy, "INTERNAL_ERROR", 0)).toBe(true);
  });

  it("should use UNKNOWN_ERROR for unmapped codes", () => {
    const unknownPolicy = retryPolicy({
      attempts: 3,
      backoff: "exponential",
      on: ["UNKNOWN_ERROR"],
    });

    expect(shouldRetry(unknownPolicy, "SOME_RANDOM_ERROR", 0)).toBe(true);
  });
});

describe("helper factories", () => {
  it("retryPolicy should create a valid policy", () => {
    const policy = retryPolicy({
      attempts: 5,
      backoff: "linear",
      baseDelay: ms(200),
      maxDelay: ms(10000),
      on: ["TIMEOUT", "CONNECTION_ERROR"],
    });

    expect(policy.attempts).toBe(5);
    expect(policy.backoff).toBe("linear");
    expect(policy.baseDelay).toBe(200);
    expect(policy.maxDelay).toBe(10000);
    expect(policy.on).toEqual(["TIMEOUT", "CONNECTION_ERROR"]);
  });

  it("retryPolicy should use default backoff", () => {
    const policy = retryPolicy({
      attempts: 3,
      on: ["TIMEOUT"],
    });

    expect(policy.backoff).toBe("exponential");
  });

  it("circuitBreakerPolicy should create a valid policy", () => {
    const policy = circuitBreakerPolicy({
      threshold: 10,
      resetAfter: ms(60000),
    });

    expect(policy.threshold).toBe(10);
    expect(policy.resetAfter).toBe(60000);
  });
});

describe("constants", () => {
  it("should export NO_RETRY", () => {
    expect(NO_RETRY).toBe("none");
  });

  it("should export NO_TIMEOUT", () => {
    expect(NO_TIMEOUT).toBe("none");
  });

  it("should export NO_CIRCUIT_BREAKER", () => {
    expect(NO_CIRCUIT_BREAKER).toBe("none");
  });
});

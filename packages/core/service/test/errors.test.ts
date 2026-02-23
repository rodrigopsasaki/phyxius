import { describe, it, expect } from "vitest";
import { ServiceError } from "../src/errors.js";

describe("ServiceError", () => {
  describe("constructor", () => {
    it("should create an error with code and message", () => {
      const error = new ServiceError("TIMEOUT", "Operation timed out");

      expect(error.code).toBe("TIMEOUT");
      expect(error.message).toBe("Operation timed out");
      expect(error.name).toBe("ServiceError");
      expect(error.cause).toBeUndefined();
      expect(error.metadata).toBeUndefined();
    });

    it("should create an error with cause", () => {
      const cause = new Error("Original error");
      const error = new ServiceError("INTERNAL_ERROR", "Something went wrong", {
        cause,
      });

      expect(error.cause).toBe(cause);
    });

    it("should create an error with metadata", () => {
      const error = new ServiceError("VALIDATION_ERROR", "Invalid input", {
        metadata: { field: "email", value: "invalid" },
      });

      expect(error.metadata).toEqual({ field: "email", value: "invalid" });
    });
  });

  describe("factory methods", () => {
    it("should create a timeout error with default message", () => {
      const error = ServiceError.timeout();

      expect(error.code).toBe("TIMEOUT");
      expect(error.message).toBe("Operation timed out");
    });

    it("should create a timeout error with custom message", () => {
      const error = ServiceError.timeout("Custom timeout message");

      expect(error.code).toBe("TIMEOUT");
      expect(error.message).toBe("Custom timeout message");
    });

    it("should create a validation error", () => {
      const error = ServiceError.validation("Invalid email format");

      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toBe("Invalid email format");
    });

    it("should create a validation error with metadata", () => {
      const error = ServiceError.validation("Invalid email format", { field: "email" });

      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.metadata).toEqual({ field: "email" });
    });

    it("should create a not found error", () => {
      const error = ServiceError.notFound("User", "123");

      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toContain("User");
      expect(error.message).toContain("123");
      expect(error.metadata).toEqual({ resource: "User", id: "123" });
    });

    it("should create a not found error without id", () => {
      const error = ServiceError.notFound("User");

      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("User not found");
    });

    it("should create a connection error", () => {
      const cause = new Error("Connection refused");
      const error = ServiceError.connection("Database connection failed", cause);

      expect(error.code).toBe("CONNECTION_ERROR");
      expect(error.message).toBe("Database connection failed");
      expect(error.cause).toBe(cause);
    });

    it("should create a rate limited error", () => {
      const error = ServiceError.rateLimited(60);

      expect(error.code).toBe("RATE_LIMITED");
      expect(error.message).toBe("Rate limit exceeded");
      expect(error.metadata).toEqual({ retryAfter: 60 });
    });

    it("should create a rate limited error without retryAfter", () => {
      const error = ServiceError.rateLimited();

      expect(error.code).toBe("RATE_LIMITED");
      expect(error.message).toBe("Rate limit exceeded");
      expect(error.metadata).toBeUndefined();
    });

    it("should create a circuit open error with default message", () => {
      const error = ServiceError.circuitOpen();

      expect(error.code).toBe("CIRCUIT_OPEN");
      expect(error.message).toBe("Circuit breaker is open");
    });

    it("should create a circuit open error with custom message", () => {
      const error = ServiceError.circuitOpen("user-service circuit is open");

      expect(error.code).toBe("CIRCUIT_OPEN");
      expect(error.message).toBe("user-service circuit is open");
    });

    it("should create an internal error from Error", () => {
      const cause = new Error("Unexpected error");
      const error = ServiceError.internal(cause);

      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.message).toBe("Unexpected error");
      expect(error.cause).toBe(cause);
    });

    it("should create an internal error from string", () => {
      const error = ServiceError.internal("Something went wrong");

      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.message).toBe("Something went wrong");
    });

    it("should return same ServiceError from internal", () => {
      const original = ServiceError.timeout();
      const error = ServiceError.internal(original);

      expect(error).toBe(original);
    });

    it("should create a retry exhausted error", () => {
      const lastError = new Error("Last attempt failed");
      const error = ServiceError.retryExhausted(3, lastError);

      expect(error.code).toBe("RETRY_EXHAUSTED");
      expect(error.message).toContain("3");
      expect(error.metadata).toEqual({ attempts: 3 });
      expect(error.cause).toBe(lastError);
    });

    it("should create a conflict error", () => {
      const error = ServiceError.conflict("Resource already exists");

      expect(error.code).toBe("CONFLICT");
      expect(error.message).toBe("Resource already exists");
    });

    it("should create an unauthorized error", () => {
      const error = ServiceError.unauthorized("Invalid token");

      expect(error.code).toBe("UNAUTHORIZED");
      expect(error.message).toBe("Invalid token");
    });

    it("should create an unauthorized error with default message", () => {
      const error = ServiceError.unauthorized();

      expect(error.code).toBe("UNAUTHORIZED");
      expect(error.message).toBe("Unauthorized");
    });

    it("should create a forbidden error", () => {
      const error = ServiceError.forbidden("Access denied");

      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe("Access denied");
    });

    it("should create a forbidden error with default message", () => {
      const error = ServiceError.forbidden();

      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe("Forbidden");
    });
  });

  describe("from static method", () => {
    it("should return the same error if already a ServiceError", () => {
      const original = ServiceError.timeout();
      const result = ServiceError.from(original);

      expect(result).toBe(original);
    });

    it("should wrap an Error", () => {
      const original = new Error("Something went wrong");
      const result = ServiceError.from(original);

      expect(result.code).toBe("INTERNAL_ERROR");
      expect(result.message).toBe("Something went wrong");
      expect(result.cause).toBe(original);
    });

    it("should wrap a string", () => {
      const result = ServiceError.from("Something went wrong");

      expect(result.code).toBe("INTERNAL_ERROR");
      expect(result.message).toBe("Something went wrong");
    });

    it("should wrap unknown values", () => {
      const result = ServiceError.from({ foo: "bar" });

      expect(result.code).toBe("INTERNAL_ERROR");
      expect(result.message).toBe("[object Object]");
    });

    it("should wrap null", () => {
      const result = ServiceError.from(null);

      expect(result.code).toBe("INTERNAL_ERROR");
      expect(result.message).toBe("null");
    });
  });

  describe("isRetryable", () => {
    it("should return true for retryable errors", () => {
      expect(ServiceError.timeout().isRetryable()).toBe(true);
      expect(ServiceError.connection("Error").isRetryable()).toBe(true);
      expect(ServiceError.rateLimited().isRetryable()).toBe(true);
      expect(ServiceError.internal("Error").isRetryable()).toBe(true);
    });

    it("should return false for non-retryable errors", () => {
      expect(ServiceError.validation("Error").isRetryable()).toBe(false);
      expect(ServiceError.notFound("User", "123").isRetryable()).toBe(false);
      expect(ServiceError.unauthorized().isRetryable()).toBe(false);
      expect(ServiceError.forbidden().isRetryable()).toBe(false);
      expect(ServiceError.circuitOpen().isRetryable()).toBe(false);
      expect(ServiceError.retryExhausted(3).isRetryable()).toBe(false);
      expect(ServiceError.conflict("Error").isRetryable()).toBe(false);
    });
  });

  describe("toJSON", () => {
    it("should serialize to JSON", () => {
      const error = new ServiceError("TIMEOUT", "Operation timed out", {
        metadata: { duration: 5000 },
      });

      const json = error.toJSON();

      expect(json).toEqual({
        _tag: "ServiceError",
        code: "TIMEOUT",
        message: "Operation timed out",
        metadata: { duration: 5000 },
        cause: undefined,
      });
    });

    it("should serialize cause message", () => {
      const cause = new Error("Root cause");
      const error = new ServiceError("INTERNAL_ERROR", "Error occurred", { cause });

      const json = error.toJSON();

      expect(json.cause).toBe("Root cause");
    });
  });
});

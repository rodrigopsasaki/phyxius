/**
 * Error codes for service errors
 */
export type ServiceErrorCode =
  | "VALIDATION_ERROR"
  | "TIMEOUT"
  | "CIRCUIT_OPEN"
  | "RETRY_EXHAUSTED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "CONNECTION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN";

/**
 * Structured error for service functions.
 * Always contains code, message, and optional metadata.
 */
export class ServiceError extends Error {
  readonly _tag = "ServiceError" as const;
  readonly code: ServiceErrorCode;
  readonly metadata?: Record<string, unknown>;
  readonly cause?: Error;

  constructor(
    code: ServiceErrorCode,
    message: string,
    options?: {
      metadata?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    if (options?.metadata !== undefined) {
      this.metadata = options.metadata;
    }
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  /**
   * Create a validation error
   */
  static validation(message: string, metadata?: Record<string, unknown>): ServiceError {
    return new ServiceError("VALIDATION_ERROR", message, metadata !== undefined ? { metadata } : undefined);
  }

  /**
   * Create a timeout error
   */
  static timeout(message: string = "Operation timed out"): ServiceError {
    return new ServiceError("TIMEOUT", message);
  }

  /**
   * Create a circuit open error
   */
  static circuitOpen(message: string = "Circuit breaker is open"): ServiceError {
    return new ServiceError("CIRCUIT_OPEN", message);
  }

  /**
   * Create a retry exhausted error
   */
  static retryExhausted(attempts: number, lastError?: Error): ServiceError {
    return new ServiceError("RETRY_EXHAUSTED", `Exhausted ${attempts} retry attempts`, {
      metadata: { attempts },
      ...(lastError !== undefined && { cause: lastError }),
    });
  }

  /**
   * Create a not found error
   */
  static notFound(resource: string, id?: string): ServiceError {
    return new ServiceError("NOT_FOUND", `${resource} not found${id ? `: ${id}` : ""}`, {
      metadata: { resource, id },
    });
  }

  /**
   * Create a conflict error
   */
  static conflict(message: string, metadata?: Record<string, unknown>): ServiceError {
    return new ServiceError("CONFLICT", message, metadata !== undefined ? { metadata } : undefined);
  }

  /**
   * Create a rate limited error
   */
  static rateLimited(retryAfter?: number): ServiceError {
    return new ServiceError(
      "RATE_LIMITED",
      "Rate limit exceeded",
      retryAfter !== undefined ? { metadata: { retryAfter } } : undefined,
    );
  }

  /**
   * Create an internal error from an unknown error
   */
  static internal(error: unknown): ServiceError {
    if (error instanceof ServiceError) {
      return error;
    }
    if (error instanceof Error) {
      return new ServiceError("INTERNAL_ERROR", error.message, { cause: error });
    }
    return new ServiceError("INTERNAL_ERROR", String(error));
  }

  /**
   * Create a connection error
   */
  static connection(message: string, cause?: Error): ServiceError {
    return new ServiceError("CONNECTION_ERROR", message, cause !== undefined ? { cause } : undefined);
  }

  /**
   * Create an unauthorized error
   */
  static unauthorized(message: string = "Unauthorized"): ServiceError {
    return new ServiceError("UNAUTHORIZED", message);
  }

  /**
   * Create a forbidden error
   */
  static forbidden(message: string = "Forbidden"): ServiceError {
    return new ServiceError("FORBIDDEN", message);
  }

  /**
   * Create from any error type
   */
  static from(error: unknown): ServiceError {
    if (error instanceof ServiceError) {
      return error;
    }
    return ServiceError.internal(error);
  }

  /**
   * Check if this error should trigger a retry
   */
  isRetryable(): boolean {
    return (
      this.code === "TIMEOUT" ||
      this.code === "CONNECTION_ERROR" ||
      this.code === "RATE_LIMITED" ||
      this.code === "INTERNAL_ERROR"
    );
  }

  /**
   * Serialize to JSON
   */
  toJSON(): Record<string, unknown> {
    return {
      _tag: this._tag,
      code: this.code,
      message: this.message,
      metadata: this.metadata,
      cause: this.cause?.message,
    };
  }
}

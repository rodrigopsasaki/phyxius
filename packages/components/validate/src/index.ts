/**
 * Core validation interfaces for type-safe runtime validation.
 *
 * This package provides contracts that work with any validation library
 * (Zod, Yup, Joi, etc.) without forcing a specific dependency.
 */

/**
 * Validation error with contextual information.
 */
export interface ValidationError {
  /** Path to the invalid field (e.g., "user.email") */
  path: string[];
  /** Human-readable error message */
  message: string;
  /** The invalid value that caused the error */
  value?: unknown;
  /** Error code for programmatic handling */
  code?: string;
}

/**
 * Result of a validation operation.
 */
export interface ValidationResult<T> {
  /** Whether validation succeeded */
  success: boolean;
  /** Parsed data if validation succeeded */
  data?: T;
  /** Validation errors if validation failed */
  errors?: ValidationError[];
}

/**
 * Contract for any validator that can parse input data.
 *
 * Compatible with Zod, Yup, Joi, and custom validators.
 *
 * @example
 * ```typescript
 * // Works with Zod
 * const zodValidator: Validator<User> = zodSchema;
 *
 * // Works with custom validators
 * const customValidator: Validator<User> = {
 *   parse(input) {
 *     if (typeof input.name !== 'string') throw new Error('Invalid name');
 *     return input as User;
 *   }
 * };
 * ```
 */
export interface Validator<T> {
  /**
   * Parse and validate input, throwing on validation failure.
   *
   * @param input - Raw input to validate
   * @returns Parsed and validated data
   * @throws Error when validation fails
   */
  parse(input: unknown): T;
}

/**
 * Extended validator that supports both throwing and safe parsing.
 */
export interface SafeValidator<T> extends Validator<T> {
  /**
   * Parse input safely, returning success/error result instead of throwing.
   *
   * @param input - Raw input to validate
   * @returns Validation result with success flag
   */
  safeParse(input: unknown): ValidationResult<T>;
}

/**
 * Creates a type-safe validation function.
 *
 * @param validator - Validator instance (Zod schema, custom validator, etc.)
 * @returns Function that validates input and returns typed data
 *
 * @example
 * ```typescript
 * interface UserInput {
 *   name: string;
 *   age: number;
 * }
 *
 * const validate = createValidator<UserInput>(zodSchema);
 *
 * // Throws on invalid input, returns typed data on success
 * const user = validate(rawInput);
 * console.log(user.name); // TypeScript knows this is a string
 * ```
 */
export function createValidator<T>(validator: Validator<T>) {
  return function validate(input: unknown): T {
    return validator.parse(input);
  };
}

/**
 * Creates a safe validation function that returns results instead of throwing.
 *
 * @param validator - Validator instance that supports safe parsing
 * @returns Function that validates input and returns ValidationResult
 *
 * @example
 * ```typescript
 * const validateSafe = createSafeValidator(zodSchema);
 *
 * const result = validateSafe(rawInput);
 * if (result.success) {
 *   console.log(result.data.name); // TypeScript knows data exists
 * } else {
 *   console.log(result.errors); // Handle validation errors
 * }
 * ```
 */
export function createSafeValidator<T>(validator: SafeValidator<T>) {
  return function validateSafe(input: unknown): ValidationResult<T> {
    return validator.safeParse(input);
  };
}

/**
 * Creates a validator from a simple validation function.
 * Useful for custom validation logic or wrapping other validators.
 *
 * @param parseFunction - Function that validates and transforms input
 * @returns Validator instance
 *
 * @example
 * ```typescript
 * interface Config {
 *   port: number;
 *   host: string;
 * }
 *
 * const configValidator = fromFunction<Config>((input) => {
 *   if (!input || typeof input !== 'object') {
 *     throw new Error('Config must be an object');
 *   }
 *
 *   const { port, host } = input as any;
 *
 *   if (typeof port !== 'number' || port < 1 || port > 65535) {
 *     throw new Error('Port must be a number between 1 and 65535');
 *   }
 *
 *   if (typeof host !== 'string' || host.length === 0) {
 *     throw new Error('Host must be a non-empty string');
 *   }
 *
 *   return { port, host };
 * });
 * ```
 */
export function fromFunction<T>(parseFunction: (input: unknown) => T): Validator<T> {
  return {
    parse: parseFunction,
  };
}

/**
 * Wraps a validator to provide better error context.
 *
 * @param validator - Base validator to wrap
 * @param context - Additional context for errors
 * @returns Enhanced validator with better error messages
 *
 * @example
 * ```typescript
 * const userValidator = withContext(zodSchema, {
 *   operation: 'user.create',
 *   source: 'api.request.body'
 * });
 * ```
 */
export function withContext<T>(validator: Validator<T>, context: Record<string, unknown>): Validator<T> {
  return {
    parse(input: unknown): T {
      try {
        return validator.parse(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Validation failed";
        const contextStr = Object.entries(context)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ");

        throw new Error(`${message} (${contextStr})`);
      }
    },
  };
}

/**
 * Type helper to infer the output type of a validator.
 *
 * @example
 * ```typescript
 * type User = InferValidator<typeof userValidator>;
 * // Equivalent to the T type parameter of Validator<T>
 * ```
 */
export type InferValidator<T> = T extends Validator<infer U> ? U : never;

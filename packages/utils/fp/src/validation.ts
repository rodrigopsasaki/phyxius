/**
 * Validation combinators for building composable validation pipelines.
 * These accumulate errors instead of short-circuiting on first failure.
 */

import type { Result } from "./result.js";
import { ok, err, isErr } from "./result.js";

/** Validation error with field context */
export interface ValidationError {
  field?: string;
  message: string;
  code?: string;
  context?: Record<string, unknown>;
}

/** Validation result type */
export type ValidationResult<T> = Result<T, ValidationError[]>;

/** Validator function type */
export type Validator<T> = (value: T) => ValidationResult<T>;

/** Predicate validator */
export type PredicateValidator<T> = (value: T) => boolean;

/** Create a validator from a predicate */
export function validator<T>(predicate: PredicateValidator<T>, error: ValidationError | string): Validator<T> {
  return (value: T) => {
    if (predicate(value)) {
      return ok(value);
    }
    const errorObj = typeof error === "string" ? { message: error } : error;
    return err([errorObj]);
  };
}

/** Combine multiple validators (all must pass) */
export function combine<T>(...validators: Validator<T>[]): Validator<T> {
  return (value: T) => {
    const errors: ValidationError[] = [];

    for (const validate of validators) {
      const result = validate(value);
      if (isErr(result)) {
        errors.push(...result.error);
      }
    }

    return errors.length > 0 ? err(errors) : ok(value);
  };
}

/** Combine validators sequentially (short-circuit on first failure) */
export function sequence<T>(...validators: Validator<T>[]): Validator<T> {
  return (value: T) => {
    for (const validate of validators) {
      const result = validate(value);
      if (isErr(result)) {
        return result;
      }
    }
    return ok(value);
  };
}

/** Apply validator only if condition is met */
export function when<T>(condition: PredicateValidator<T>, validator: Validator<T>): Validator<T> {
  return (value: T) => {
    if (condition(value)) {
      return validator(value);
    }
    return ok(value);
  };
}

/** Apply validator unless condition is met */
export function unless<T>(condition: PredicateValidator<T>, validator: Validator<T>): Validator<T> {
  return (value: T) => {
    if (!condition(value)) {
      return validator(value);
    }
    return ok(value);
  };
}

/** Map validation errors */
export function mapErrors<T>(
  validator: Validator<T>,
  fn: (errors: ValidationError[]) => ValidationError[],
): Validator<T> {
  return (value: T) => {
    const result = validator(value);
    if (isErr(result)) {
      return err(fn(result.error));
    }
    return result;
  };
}

/** Add field context to validation errors */
export function withField<T>(field: string, validator: Validator<T>): Validator<T> {
  return mapErrors(validator, (errors) => errors.map((error) => ({ ...error, field: error.field || field })));
}

/** Add error code to validation errors */
export function withCode<T>(code: string, validator: Validator<T>): Validator<T> {
  return mapErrors(validator, (errors) => errors.map((error) => ({ ...error, code: error.code || code })));
}

/** String validators */
export const string = {
  required: validator<string>((s) => s.length > 0, { message: "Value is required", code: "REQUIRED" }),

  minLength: (min: number) =>
    validator<string>((s) => s.length >= min, { message: `Must be at least ${min} characters`, code: "MIN_LENGTH" }),

  maxLength: (max: number) =>
    validator<string>((s) => s.length <= max, { message: `Must be at most ${max} characters`, code: "MAX_LENGTH" }),

  pattern: (regex: RegExp, message?: string) =>
    validator<string>((s) => regex.test(s), { message: message || `Must match pattern ${regex}`, code: "PATTERN" }),

  email: validator<string>((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), {
    message: "Must be a valid email address",
    code: "EMAIL",
  }),

  url: validator<string>(
    (s) => {
      try {
        new URL(s);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Must be a valid URL", code: "URL" },
  ),

  uuid: validator<string>((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s), {
    message: "Must be a valid UUID",
    code: "UUID",
  }),

  alphanumeric: validator<string>((s) => /^[a-zA-Z0-9]+$/.test(s), {
    message: "Must contain only letters and numbers",
    code: "ALPHANUMERIC",
  }),

  numeric: validator<string>((s) => /^\d+$/.test(s), { message: "Must contain only numbers", code: "NUMERIC" }),
};

/** Number validators */
export const number = {
  min: (min: number) => validator<number>((n) => n >= min, { message: `Must be at least ${min}`, code: "MIN" }),

  max: (max: number) => validator<number>((n) => n <= max, { message: `Must be at most ${max}`, code: "MAX" }),

  between: (min: number, max: number) =>
    validator<number>((n) => n >= min && n <= max, { message: `Must be between ${min} and ${max}`, code: "BETWEEN" }),

  integer: validator<number>((n) => Number.isInteger(n), { message: "Must be an integer", code: "INTEGER" }),

  positive: validator<number>((n) => n > 0, { message: "Must be positive", code: "POSITIVE" }),

  negative: validator<number>((n) => n < 0, { message: "Must be negative", code: "NEGATIVE" }),

  nonZero: validator<number>((n) => n !== 0, { message: "Must not be zero", code: "NON_ZERO" }),
};

/** Array validators */
export const array = {
  minLength: <T>(min: number) =>
    validator<T[]>((arr) => arr.length >= min, { message: `Must have at least ${min} items`, code: "MIN_LENGTH" }),

  maxLength: <T>(max: number) =>
    validator<T[]>((arr) => arr.length <= max, { message: `Must have at most ${max} items`, code: "MAX_LENGTH" }),

  nonEmpty: <T>() => validator<T[]>((arr) => arr.length > 0, { message: "Must not be empty", code: "NON_EMPTY" }),

  unique: <T>() =>
    validator<T[]>((arr) => new Set(arr).size === arr.length, { message: "Must contain unique items", code: "UNIQUE" }),

  each:
    <T>(itemValidator: Validator<T>): Validator<T[]> =>
    (arr: T[]) => {
      const errors: ValidationError[] = [];

      for (const [i, item] of arr.entries()) {
        const result = itemValidator(item);
        if (isErr(result)) {
          errors.push(
            ...result.error.map((e) => ({
              ...e,
              field: `[${i}]${e.field ? `.${e.field}` : ""}`,
            })),
          );
        }
      }

      return errors.length > 0 ? err(errors) : ok(arr);
    },
};

/** Object validators */
export const object = {
  shape:
    <T extends Record<string, unknown>>(schema: { [K in keyof T]: Validator<T[K]> }): Validator<T> =>
    (obj: T) => {
      const errors: ValidationError[] = [];

      for (const [key, validator] of Object.entries(schema)) {
        const result = (validator as Validator<unknown>)(obj[key]);
        if (isErr(result)) {
          errors.push(
            ...result.error.map((e) => ({
              ...e,
              field: e.field ? `${key}.${e.field}` : key,
            })),
          );
        }
      }

      return errors.length > 0 ? err(errors) : ok(obj);
    },

  partial:
    <T extends Record<string, unknown>>(schema: { [K in keyof T]?: Validator<T[K]> }): Validator<Partial<T>> =>
    (obj: Partial<T>) => {
      const errors: ValidationError[] = [];

      for (const [key, validator] of Object.entries(schema)) {
        if (key in obj && validator) {
          const result = (validator as Validator<unknown>)(obj[key as keyof T]);
          if (isErr(result)) {
            errors.push(
              ...result.error.map((e) => ({
                ...e,
                field: e.field ? `${key}.${e.field}` : key,
              })),
            );
          }
        }
      }

      return errors.length > 0 ? err(errors) : ok(obj);
    },

  keys:
    <T extends Record<string, unknown>>(validator: Validator<string>): Validator<T> =>
    (obj: T) => {
      const errors: ValidationError[] = [];

      for (const key of Object.keys(obj)) {
        const result = validator(key);
        if (isErr(result)) {
          errors.push(
            ...result.error.map((e) => ({
              ...e,
              field: `key:${key}`,
            })),
          );
        }
      }

      return errors.length > 0 ? err(errors) : ok(obj);
    },
};

/** Custom validator builder */
export class ValidatorBuilder<T> {
  private validators: Validator<T>[] = [];

  add(validator: Validator<T>): this {
    this.validators.push(validator);
    return this;
  }

  addIf(condition: boolean, validator: Validator<T>): this {
    if (condition) {
      this.validators.push(validator);
    }
    return this;
  }

  build(): Validator<T> {
    return combine(...this.validators);
  }
}

/** Create a new validator builder */
export function builder<T>(): ValidatorBuilder<T> {
  return new ValidatorBuilder<T>();
}

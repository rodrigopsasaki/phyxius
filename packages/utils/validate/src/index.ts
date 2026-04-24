import { ok, err, type Result } from "@phyxiusjs/fp";

/**
 * Validator contract. Anything with a throw-on-invalid `parse(input): T`
 * method satisfies this — including Zod schemas, Yup schemas, Joi schemas,
 * and custom hand-rolled validators.
 *
 * The throw stays at the validator boundary. Phyxius code calls validators
 * through `validate()` (below), which converts the throw into a Result so
 * failure flows as a value.
 */
export interface Validator<T> {
  parse(input: unknown): T;
}

/**
 * A single validation issue — one failure at one path in the input.
 */
export interface ValidationIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code?: string;
}

/**
 * Structured validation error. Carries one or more issues so callers can
 * surface per-field messages without re-parsing strings.
 */
export interface ValidationError {
  readonly issues: ReadonlyArray<ValidationIssue>;
}

// ── Runner ─────────────────────────────────────────────────────────────────

/**
 * Run a validator against input and get a Result. Any thrown error is
 * converted into a ValidationError. ZodError-shaped throws (`.issues: [...]`)
 * are unpacked; anything else becomes a single-issue generic error.
 */
export function validate<T>(validator: Validator<T>, input: unknown): Result<T, ValidationError> {
  try {
    return ok(validator.parse(input));
  } catch (thrown) {
    return err(toValidationError(thrown));
  }
}

// ── Adapters ───────────────────────────────────────────────────────────────

/**
 * Adapter for arbitrary throw-based parsers. Wraps any `(input: unknown) => T`
 * that throws on invalid into a `Validator<T>`.
 */
export function fromThrowing<T>(fn: (input: unknown) => T): Validator<T> {
  return { parse: fn };
}

/**
 * Shape-compatible with Zod's `.safeParse()` result. Kept local so this
 * package has zero runtime dependency on Zod.
 */
interface SafeParseOk<T> {
  readonly success: true;
  readonly data: T;
}
interface SafeParseErr {
  readonly success: false;
  readonly error: { readonly issues: ReadonlyArray<unknown> };
}
interface HasSafeParse<T> {
  safeParse(input: unknown): SafeParseOk<T> | SafeParseErr;
}

/**
 * Adapter for libraries that expose a `safeParse`-style Result-returning
 * method (Zod, Valibot). Use this when you want structured issue detail
 * preserved — `parse`-based adaptation loses the library's native issue
 * shape.
 */
export function fromSafeParse<T>(schema: HasSafeParse<T>): Validator<T> {
  return {
    parse(input: unknown): T {
      const result = schema.safeParse(input);
      if (result.success) return result.data;
      throw new ValidationThrownError(unpackIssues(result.error.issues));
    },
  };
}

/**
 * A validator that accepts any input and returns it typed as `T`. Use
 * sparingly — for void outputs, or inside adapters where you've already
 * validated upstream and are asserting rather than re-checking.
 */
export function passthrough<T>(): Validator<T> {
  return {
    parse(input: unknown): T {
      return input as T;
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

class ValidationThrownError extends Error {
  readonly issues: ReadonlyArray<ValidationIssue>;
  constructor(issues: ReadonlyArray<ValidationIssue>) {
    super(formatMessage(issues));
    this.name = "ValidationThrownError";
    this.issues = issues;
  }
}

function formatMessage(issues: ReadonlyArray<ValidationIssue>): string {
  if (issues.length === 0) return "Validation failed";
  const first = issues[0];
  if (!first) return "Validation failed";
  const at = first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return `${first.message}${at}${more}`;
}

/**
 * Normalize whatever was thrown into a ValidationError. Handles:
 *   - ValidationThrownError (our own) — unpack as-is
 *   - Zod-like errors (`.issues: [{ path, message, code }]`) — unpack issues
 *   - Plain Error instances — single issue with the message
 *   - Anything else — single issue with String(thrown)
 */
function toValidationError(thrown: unknown): ValidationError {
  if (thrown instanceof ValidationThrownError) {
    return { issues: thrown.issues };
  }
  if (isZodLikeError(thrown)) {
    return { issues: unpackIssues(thrown.issues) };
  }
  if (thrown instanceof Error) {
    return { issues: [{ path: [], message: thrown.message }] };
  }
  return { issues: [{ path: [], message: String(thrown) }] };
}

function isZodLikeError(value: unknown): value is { issues: ReadonlyArray<unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "issues" in value &&
    Array.isArray((value as { issues: unknown }).issues)
  );
}

function unpackIssues(raw: ReadonlyArray<unknown>): ReadonlyArray<ValidationIssue> {
  return raw.map((issue) => {
    if (typeof issue !== "object" || issue === null) {
      return { path: [], message: String(issue) };
    }
    const i = issue as {
      path?: ReadonlyArray<string | number>;
      message?: string;
      code?: string;
    };
    return {
      path: Array.isArray(i.path) ? i.path : [],
      message: typeof i.message === "string" ? i.message : "Validation failed",
      ...(typeof i.code === "string" ? { code: i.code } : {}),
    };
  });
}

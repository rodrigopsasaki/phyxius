# @phyxiusjs/validate

> Type-safe validation interfaces that work with any validation library

This package solves the "double dependency problem" by providing validation contracts that work with Zod, Yup, Joi, or any custom validator without forcing specific dependencies on your users.

## The Problem

If Phyxius depended on Zod directly:

- Phyxius uses `zod@3.22.0`
- Your project uses `zod@3.25.0`
- Node.js loads both versions → conflicts, bloated bundles, type mismatches

## The Solution

Phyxius defines validation **interfaces**, you bring your **implementation**:

```typescript
// Phyxius provides the contract
interface Validator<T> {
  parse(input: unknown): T;
}

// You bring Zod (any version)
import { z } from "zod"; // YOUR version

const schema = z.object({
  name: z.string(),
  age: z.number(),
});

// Works seamlessly
const validate = createValidator(schema);
const user = validate(rawInput); // Typed as { name: string; age: number }
```

## Installation

```bash
npm install @phyxiusjs/validate
# Plus your validation library of choice
npm install zod  # or yup, joi, etc.
```

## Quick Start

### With Zod

```typescript
import { createValidator, createSafeValidator } from "@phyxiusjs/validate";
import { z } from "zod";

const userSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  age: z.number().min(0),
});

// Throwing validator
const validateUser = createValidator(userSchema);
const user = validateUser(input); // Typed as z.infer<typeof userSchema>

// Safe validator (returns result instead of throwing)
const validateUserSafe = createSafeValidator(userSchema);
const result = validateUserSafe(input);
if (result.success) {
  console.log(result.data.name); // Fully typed
} else {
  console.log(result.errors); // Handle validation errors
}
```

### With Yup

```typescript
import { createValidator } from "@phyxiusjs/validate";
import * as yup from "yup";

const userSchema = yup.object({
  name: yup.string().required(),
  email: yup.string().email().required(),
  age: yup.number().min(0).required(),
});

// Yup schemas work directly (they have .parse() method via .validateSync())
const validateUser = createValidator({
  parse: (input) => userSchema.validateSync(input),
});
```

### With Custom Validators

```typescript
import { fromFunction } from "@phyxiusjs/validate";

interface Config {
  port: number;
  host: string;
  ssl: boolean;
}

const configValidator = fromFunction<Config>((input) => {
  if (!input || typeof input !== "object") {
    throw new Error("Config must be an object");
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.port !== "number" || obj.port < 1 || obj.port > 65535) {
    throw new Error("Port must be between 1 and 65535");
  }

  if (typeof obj.host !== "string" || obj.host.length === 0) {
    throw new Error("Host must be a non-empty string");
  }

  if (typeof obj.ssl !== "boolean") {
    throw new Error("SSL must be a boolean");
  }

  return {
    port: obj.port,
    host: obj.host,
    ssl: obj.ssl,
  };
});

const validate = createValidator(configValidator);
const config = validate(rawInput); // Typed as Config
```

## API Reference

### Core Interfaces

#### `Validator<T>`

Basic validation interface that any validator can implement:

```typescript
interface Validator<T> {
  parse(input: unknown): T; // Throws on validation failure
}
```

#### `SafeValidator<T>`

Extended interface for validators that support safe parsing:

```typescript
interface SafeValidator<T> extends Validator<T> {
  safeParse(input: unknown): ValidationResult<T>;
}
```

#### `ValidationResult<T>`

Result object for safe validation:

```typescript
interface ValidationResult<T> {
  success: boolean;
  data?: T; // Present when success is true
  errors?: ValidationError[]; // Present when success is false
}
```

### Factory Functions

#### `createValidator<T>(validator)`

Creates a validation function that throws on failure:

```typescript
const validate = createValidator(zodSchema);
try {
  const data = validate(input); // T
} catch (error) {
  // Handle validation error
}
```

#### `createSafeValidator<T>(validator)`

Creates a validation function that returns results:

```typescript
const validateSafe = createSafeValidator(zodSchema);
const result = validateSafe(input);
if (result.success) {
  const data = result.data; // T
} else {
  const errors = result.errors; // ValidationError[]
}
```

#### `fromFunction<T>(parseFunction)`

Creates a validator from a simple function:

```typescript
const validator = fromFunction<User>((input) => {
  // Your validation logic
  if (/* invalid */) throw new Error("Invalid");
  return parsedUser; // User
});
```

#### `withContext<T>(validator, context)`

Wraps a validator to add contextual information to errors:

```typescript
const contextValidator = withContext(baseValidator, {
  operation: "user.create",
  source: "api.request.body",
});
// Errors will include: "Validation failed (operation: user.create, source: api.request.body)"
```

### Type Utilities

#### `InferValidator<T>`

Extracts the output type from a validator:

```typescript
const userValidator = createValidator(userSchema);
type User = InferValidator<typeof userValidator>; // Inferred from schema
```

## Integration Examples

### Handler Validation

```typescript
import { createValidator } from "@phyxiusjs/validate";
import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().min(18),
});

function createUserHandler(rawInput: unknown) {
  const validate = createValidator(createUserSchema);
  const input = validate(rawInput); // Throws if invalid

  // input is now typed as { name: string; email: string; age: number }
  console.log(input.name); // TypeScript knows this is a string

  // Your business logic here
  return createUserInDatabase(input);
}
```

### Multiple Validators

```typescript
// Different schemas for different operations
const createUserValidator = createValidator(createUserSchema);
const updateUserValidator = createValidator(updateUserSchema);
const deleteUserValidator = createValidator(deleteUserSchema);

// All work with the same interface
function handleUserOperation(operation: string, input: unknown) {
  switch (operation) {
    case "create":
      return createUser(createUserValidator(input));
    case "update":
      return updateUser(updateUserValidator(input));
    case "delete":
      return deleteUser(deleteUserValidator(input));
  }
}
```

### Error Context

```typescript
const userValidator = withContext(baseUserValidator, {
  endpoint: "/api/users",
  operation: "create",
  version: "v1",
});

try {
  const user = userValidator.parse(input);
} catch (error) {
  // Error message includes context:
  // "Name is required (endpoint: /api/users, operation: create, version: v1)"
}
```

## Framework Compatibility

This validation system works with:

- **Zod** - Direct compatibility (has `.parse()` and `.safeParse()`)
- **Yup** - Use `.validateSync()` for `.parse()` method
- **Joi** - Use `.validate()` with error handling
- **Ajv** - Wrap compiled validator functions
- **Custom validators** - Implement the simple interface

### Zod Example

```typescript
import { z } from "zod";
const schema = z.string();
const validate = createValidator(schema); // Works directly
```

### Yup Example

```typescript
import * as yup from "yup";
const schema = yup.string().required();
const validate = createValidator({
  parse: (input) => schema.validateSync(input),
});
```

### Joi Example

```typescript
import Joi from "joi";
const schema = Joi.string().required();
const validate = createValidator({
  parse: (input) => {
    const { error, value } = schema.validate(input);
    if (error) throw error;
    return value;
  },
});
```

## Why This Approach?

1. **No Forced Dependencies** - Users choose their validation library
2. **Version Freedom** - No conflicts between library versions
3. **Type Safety** - Full TypeScript inference preserved
4. **Small Bundle** - Only interface definitions, no runtime dependencies
5. **Universal** - Works with any validator that can throw or return results

## Design Philosophy

- **Boring is Better** - Simple interfaces over complex abstractions
- **Bring Your Own** - Users control their dependencies
- **Type First** - TypeScript guides the design
- **Zero Runtime** - No validation library dependencies
- **Standard Compliant** - Works with existing validation patterns

## License

MIT © [Rodrigo Sasaki](https://github.com/rodrigopsasaki)

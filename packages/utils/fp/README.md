# @phyxius/fp

**Functional programming primitives for exception-free, composable code**

A comprehensive collection of functional programming utilities designed for building reliable, composable systems without exceptions. Part of the Phyxius ecosystem.

## Core Principles

- **No exceptions**: Everything returns `Result` or `Option` types
- **Explicit error handling**: Errors are values, not side effects
- **Composable**: All utilities work together seamlessly
- **Type-safe**: Full TypeScript support with no `any` types
- **Predictable**: Pure functions with no hidden state

## Installation

```bash
npm install @phyxius/fp
```

## Quick Start

```typescript
import { pipe, ok, err, some, none, map, flatMap } from "@phyxius/fp";

// Result-based error handling
const divide = (a: number, b: number) => (b === 0 ? err("Division by zero") : ok(a / b));

const result = pipe(
  divide(10, 2),
  map((x) => x * 3),
  flatMap((x) => divide(x, 5)),
);
// Result: Ok(3)

// Option-based nullable handling
const getUser = (id: string) => (users.find((u) => u.id === id) ? some(user) : none());

const userName = pipe(
  getUser("123"),
  map((user) => user.name),
  unwrapOr("Unknown"),
);
```

## Core Types

### Result<T, E>

Represents either success (`Ok<T>`) or failure (`Err<E>`). Use instead of throwing exceptions.

```typescript
import { ok, err, map, flatMap, match } from "@phyxius/fp";

// Basic usage
const success = ok(42);
const failure = err("Something went wrong");

// Transform success values
const doubled = map(success, (x) => x * 2); // Ok(84)

// Chain operations
const chained = flatMap(success, (x) => (x > 0 ? ok(Math.sqrt(x)) : err("Negative number")));

// Pattern matching
const message = match(result, {
  ok: (value) => `Success: ${value}`,
  err: (error) => `Error: ${error}`,
});
```

#### Result Operations

| Function              | Description              | Example                            |
| --------------------- | ------------------------ | ---------------------------------- |
| `ok(value)`           | Create successful result | `ok(42)`                           |
| `err(error)`          | Create failed result     | `err("oops")`                      |
| `map(result, fn)`     | Transform success value  | `map(ok(5), x => x * 2)`           |
| `flatMap(result, fn)` | Chain operations         | `flatMap(ok(5), x => ok(x + 1))`   |
| `orElse(result, fn)`  | Provide fallback         | `orElse(err("fail"), () => ok(0))` |
| `all(results)`        | Combine multiple results | `all([ok(1), ok(2), ok(3)])`       |

### Option<T>

Represents values that may or may not exist. Use instead of `null`/`undefined`.

```typescript
import { some, none, map, flatMap, unwrapOr } from "@phyxius/fp";

// Basic usage
const value = some(42);
const empty = none();

// Transform existing values
const doubled = map(value, (x) => x * 2); // Some(84)

// Chain operations
const chained = flatMap(value, (x) => (x > 0 ? some(Math.sqrt(x)) : none()));

// Extract with default
const result = unwrapOr(empty, 0); // 0
```

#### Option Operations

| Function                    | Description                | Example                       |
| --------------------------- | -------------------------- | ----------------------------- |
| `some(value)`               | Create option with value   | `some(42)`                    |
| `none()`                    | Create empty option        | `none()`                      |
| `fromNullable(value)`       | Convert nullable to option | `fromNullable(user?.name)`    |
| `map(option, fn)`           | Transform value if exists  | `map(some(5), x => x * 2)`    |
| `filter(option, predicate)` | Keep if predicate passes   | `filter(some(5), x => x > 0)` |

## Pattern Matching

Powerful pattern matching for control flow:

```typescript
import { match, matchTag, matchNumber } from "@phyxius/fp";

// Flexible matching
const result = match(value)
  .when(42, () => "the answer")
  .whenPredicate(
    (x) => x > 100,
    () => "big number",
  )
  .whenGuard(
    (x): x is string => typeof x === "string",
    (s) => `string: ${s}`,
  )
  .otherwise(() => "something else");

// Discriminated unions
type Shape = { _tag: "circle"; radius: number } | { _tag: "rectangle"; width: number; height: number };

const area = matchTag(shape, {
  circle: ({ radius }) => Math.PI * radius ** 2,
  rectangle: ({ width, height }) => width * height,
});

// Number ranges
const category = matchNumber(age)
  .whenRange(0, 17, () => "minor")
  .whenRange(18, 64, () => "adult")
  .whenGt(64, () => "senior")
  .otherwise(() => "unknown");
```

## Function Composition

Build data transformation pipelines:

```typescript
import { pipe, flow, compose } from "@phyxius/fp";

// Pipe data through functions (left-to-right)
const result = pipe(
  "  hello world  ",
  (s) => s.trim(),
  (s) => s.toUpperCase(),
  (s) => s.split(" "),
  (words) => words.join("-"),
); // "HELLO-WORLD"

// Create reusable function pipelines
const processText = flow(
  (s: string) => s.trim(),
  (s) => s.toLowerCase(),
  (s) => s.replace(/\s+/g, "-"),
);

const slug = processText("  My Blog Post  "); // "my-blog-post"

// Mathematical composition (right-to-left)
const transform = compose(
  (x: number) => x.toString(),
  (x) => x * 2,
  (x) => x + 1,
);

transform(5); // "12" (5 + 1 = 6, 6 * 2 = 12, "12")
```

## Validation

Build robust validation pipelines:

```typescript
import { validator, combine, string, number, object, ValidationResult } from "@phyxius/fp";

// Basic validators
const nameValidator = combine(string.required, string.minLength(2), string.maxLength(50));

const ageValidator = combine(number.min(0), number.max(120), number.integer);

// Object validation
const userValidator = object.shape({
  name: nameValidator,
  email: string.email,
  age: ageValidator,
});

const result = userValidator({
  name: "John",
  email: "john@example.com",
  age: 25,
}); // Ok({ name: "John", email: "john@example.com", age: 25 })

// Custom validators
const evenNumber = validator((n: number) => n % 2 === 0, "Must be even");
```

## Async Operations

Handle async operations safely:

```typescript
import { mapAsync, flatMapAsync, allAsync, retryAsync, fromPromise, toPromise } from "@phyxius/fp";

// Convert promises to async results
const fetchUser = async (id: string) => fromPromise(fetch(`/users/${id}`).then((r) => r.json()));

// Transform async results
const processUser = (result: AsyncResult<User>) =>
  mapAsync(result, (user) => ({
    ...user,
    name: user.name.toUpperCase(),
  }));

// Chain async operations
const getUserPosts = (userId: string) => flatMapAsync(fetchUser(userId), (user) => fetchPosts(user.id));

// Collect multiple async results
const users = await allAsync([fetchUser("1"), fetchUser("2"), fetchUser("3")]);

// Retry with backoff
const reliableFetch = retryAsync(() => fetchUser("123"), {
  maxAttempts: 3,
  baseDelayMs: 100,
  backoffFactor: 2,
});
```

## Functional Combinators

Advanced function manipulation:

```typescript
import { curry2, partial, flip, memoize, debounce, once, lazy } from "@phyxius/fp";

// Currying
const add = curry2((a: number, b: number) => a + b);
const add5 = add(5);
add5(3); // 8

// Partial application
const multiply = (a: number, b: number, c: number) => a * b * c;
const double = partial(multiply, 2);
double(3, 4); // 24

// Memoization
const expensive = memoize((n: number) => {
  // Complex calculation
  return fibonacci(n);
});

// Debouncing
const search = debounce((query: string) => {
  // API call
}, 300);

// One-time execution
const initialize = once(() => {
  // Setup code
});
```

## Integration Examples

### With Express.js

```typescript
import { pipe, fromPromise, match } from "@phyxius/fp";
import express from "express";

const app = express();

app.get("/users/:id", async (req, res) => {
  const result = await pipe(fromPromise(getUserById(req.params.id)), (result) =>
    match(result, {
      ok: (user) => res.json(user),
      err: (error) => res.status(404).json({ error }),
    }),
  );
});
```

### With React

```typescript
import { pipe, some, none, match } from "@phyxius/fp";
import { useState } from "react";

function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState(none());

  useEffect(() => {
    fetchUser(userId).then(result =>
      match(result, {
        ok: user => setUser(some(user)),
        err: () => setUser(none())
      })
    );
  }, [userId]);

  return match(user, {
    some: user => <div>Hello, {user.name}!</div>,
    none: () => <div>Loading...</div>
  });
}
```

## Comparison with Other Libraries

| Feature          | @phyxius/fp | fp-ts    | Ramda   | Lodash  |
| ---------------- | ----------- | -------- | ------- | ------- |
| Result type      | ✅          | ✅       | ❌      | ❌      |
| Option type      | ✅          | ✅       | ❌      | ❌      |
| Pattern matching | ✅          | Limited  | ❌      | ❌      |
| Async Result     | ✅          | ✅       | ❌      | ❌      |
| Validation       | ✅          | External | ❌      | ❌      |
| Bundle size      | Small       | Large    | Medium  | Large   |
| Learning curve   | Gentle      | Steep    | Gentle  | Gentle  |
| TypeScript focus | ✅          | ✅       | Partial | Partial |

## Design Decisions

### Why Not Exceptions?

Exceptions are invisible in function signatures and can be thrown from any operation. Result types make error handling explicit and composable.

```typescript
// Hidden exception - what can fail?
function divide(a: number, b: number): number;

// Explicit error handling - clear what can fail
function divide(a: number, b: number): Result<number, string>;
```

### Why Phyxius Style?

- **Opinionated**: Clear patterns for common use cases
- **Composable**: All utilities work together naturally
- **Practical**: Focused on real-world applications
- **Beginner-friendly**: Gentle learning curve

## Best Practices

### 1. Prefer Result over throwing

```typescript
// ❌ Don't throw
function parseNumber(str: string): number {
  const num = parseInt(str);
  if (isNaN(num)) throw new Error("Invalid number");
  return num;
}

// ✅ Return Result
function parseNumber(str: string): Result<number, string> {
  const num = parseInt(str);
  return isNaN(num) ? err("Invalid number") : ok(num);
}
```

### 2. Chain operations with pipe

```typescript
// ❌ Nested operations
const result = transform3(transform2(transform1(data)));

// ✅ Linear pipeline
const result = pipe(data, transform1, transform2, transform3);
```

### 3. Use pattern matching for control flow

```typescript
// ❌ Imperative checks
if (result._tag === "Ok") {
  return result.value.toString();
} else {
  return "Error: " + result.error;
}

// ✅ Pattern matching
return match(result, {
  ok: (value) => value.toString(),
  err: (error) => `Error: ${error}`,
});
```

### 4. Accumulate validation errors

```typescript
// ❌ Stop on first error
if (!isValidName(name)) return err("Invalid name");
if (!isValidEmail(email)) return err("Invalid email");
return ok({ name, email });

// ✅ Collect all errors
const validator = object.shape({
  name: string.required,
  email: string.email,
});
return validator({ name, email });
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for your changes
4. Ensure all tests pass
5. Submit a pull request

## License

MIT - see LICENSE file for details.

## Part of Phyxius

This package is part of the [Phyxius](https://github.com/user/phyxius) ecosystem of foundational primitives for Node.js systems.

Related packages:

- `@phyxius/clock` - Controllable time primitives
- `@phyxius/atom` - Atomic state management
- `@phyxius/effect` - Structured concurrency
- `@phyxius/process` - Supervised execution units

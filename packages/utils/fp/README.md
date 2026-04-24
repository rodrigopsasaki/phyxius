# @phyxiusjs/fp

Functional programming primitives that make failure explicit and success composable.

Utilities for handling errors as values instead of exceptions. Most functions in this library return values rather than throwing.

## Core Philosophy

- **Errors are values**: No exceptions. Ever. Use `Result<T, E>` instead.
- **Nullability is explicit**: No `null`/`undefined` surprises. Use `Option<T>`.
- **Composition over configuration**: Small functions that combine naturally.
- **What, not how**: Declarative APIs that express intent.

## Installation

```bash
npm install @phyxiusjs/fp
```

## The Two Types That Matter

### Result<T, E> - When Things Can Fail

```typescript
import { ok, err, map, flatMap, match } from "@phyxiusjs/fp";

// Instead of throwing exceptions
function divide(a: number, b: number): Result<number, string> {
  return b === 0 ? err("Division by zero") : ok(a / b);
}

// Chain operations that might fail
const calculation = pipe(
  divide(10, 2),
  flatMap((x) => divide(x, 2.5)),
  map((x) => Math.round(x)),
); // Ok(2)

// Handle both cases explicitly
const message = match(calculation, {
  ok: (value) => `Answer: ${value}`,
  err: (error) => `Failed: ${error}`,
});
```

### Option<T> - When Things Might Not Exist

```typescript
import { some, none, map, filter, unwrapOr } from "@phyxiusjs/fp";

// Instead of null/undefined
function findUser(id: string): Option<User> {
  const user = database.get(id);
  return user ? some(user) : none();
}

// Transform if present
const userName = pipe(
  findUser("123"),
  map((u) => u.name),
  map((n) => n.toUpperCase()),
  unwrapOr("ANONYMOUS"),
);

// Filter with predicate
const activeUser = pipe(
  findUser("123"),
  filter((u) => u.isActive),
);
```

## Pattern Matching - Control Flow Without If-Else Hell

```typescript
import { match, matchTag } from "@phyxiusjs/fp";

// Flexible value matching
const describe = (value: unknown) =>
  match(value)
    .when(0, () => "zero")
    .when(1, () => "one")
    .whenPredicate(
      (x) => x > 100,
      () => "big",
    )
    .whenGuard(
      (x): x is string => typeof x === "string",
      (s) => `string: ${s}`,
    )
    .otherwise(() => "something else");

// Discriminated union matching
type Event =
  | { _tag: "click"; x: number; y: number }
  | { _tag: "keypress"; key: string }
  | { _tag: "scroll"; delta: number };

const handleEvent = (event: Event) =>
  matchTag(event, {
    click: ({ x, y }) => `Clicked at ${x},${y}`,
    keypress: ({ key }) => `Pressed ${key}`,
    scroll: ({ delta }) => `Scrolled ${delta}px`,
  });
```

## Composition - Build Complex From Simple

```typescript
import { pipe, flow, compose } from "@phyxiusjs/fp";

// pipe: Thread data through functions (left-to-right)
const result = pipe(
  "  hello WORLD  ",
  (s) => s.trim(),
  (s) => s.toLowerCase(),
  (s) => s.split(" "),
  (words) => words.map((w) => w[0].toUpperCase() + w.slice(1)),
  (words) => words.join(" "),
); // "Hello World"

// flow: Create reusable pipelines
const slugify = flow(
  (s: string) => s.trim(),
  (s) => s.toLowerCase(),
  (s) => s.replace(/[^\w\s-]/g, ""),
  (s) => s.replace(/\s+/g, "-"),
);

slugify("Hello, World!"); // "hello-world"

// compose: Mathematical composition (right-to-left)
const processNumber = compose(
  (n: number) => `Value: ${n}`,
  (n) => Math.round(n),
  (n) => n * 2.5,
);

processNumber(10); // "Value: 25"
```

## Array Operations - Functional Style

```typescript
import { head, tail, partition } from "@phyxiusjs/fp";

const numbers = [1, 2, 3, 4, 5];

// Safe array access
const first = head(numbers); // Some(1)
const rest = tail(numbers); // Some([2, 3, 4, 5])

const empty = head([]); // None()

// Partition by predicate
const [evens, odds] = partition(numbers, (n) => n % 2 === 0);
// evens: [2, 4]
// odds: [1, 3, 5]
```

## Real-World Examples

### API Error Handling

```typescript
import { fromPromise, map, flatMap, match } from "@phyxiusjs/fp";

async function fetchUserWithPosts(userId: string) {
  const userResult = await fromPromise(fetch(`/api/users/${userId}`).then((r) => r.json()));

  return pipe(
    userResult,
    flatMap((user) =>
      fromPromise(fetch(`/api/users/${userId}/posts`).then((r) => r.json())).then((postsResult) =>
        map(postsResult, (posts) => ({ ...user, posts })),
      ),
    ),
  );
}

// Usage
const result = await fetchUserWithPosts("123");

match(result, {
  ok: (userWithPosts) => {
    console.log(`${userWithPosts.name} has ${userWithPosts.posts.length} posts`);
  },
  err: (error) => {
    console.error("Failed to fetch user data:", error);
  },
});
```

### Form Validation

```typescript
import { ok, err, all, map } from "@phyxiusjs/fp";

const validateEmail = (email: string): Result<string, string> =>
  email.includes("@") ? ok(email) : err("Invalid email");

const validateAge = (age: number): Result<number, string> =>
  age >= 18 && age <= 120 ? ok(age) : err("Age must be between 18 and 120");

const validateName = (name: string): Result<string, string> => (name.length >= 2 ? ok(name) : err("Name too short"));

// Combine validations
function validateUser(data: any): Result<User, string[]> {
  const validations = all([validateEmail(data.email), validateAge(data.age), validateName(data.name)]);

  return map(validations, ([email, age, name]) => ({
    email,
    age,
    name,
  }));
}
```

### React Hook with Option

```typescript
import { useState, useEffect } from "react";
import { some, none, match, type Option } from "@phyxiusjs/fp";

function useAsyncData<T>(
  fetcher: () => Promise<T>
): {
  data: Option<T>;
  loading: boolean;
  error: Option<Error>;
} {
  const [data, setData] = useState<Option<T>>(none());
  const [error, setError] = useState<Option<Error>>(none());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetcher()
      .then(result => {
        setData(some(result));
        setError(none());
      })
      .catch(err => {
        setData(none());
        setError(some(err));
      })
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}

// Usage in component
function UserProfile({ userId }: { userId: string }) {
  const { data, loading, error } = useAsyncData(
    () => fetchUser(userId)
  );

  if (loading) return <div>Loading...</div>;

  return match(error, {
    some: err => <div>Error: {err.message}</div>,
    none: () =>
      match(data, {
        some: user => <div>Welcome, {user.name}!</div>,
        none: () => <div>No user found</div>
      })
  });
}
```

## API Reference

### Result<T, E>

| Function                    | Type                                               | Description              |
| --------------------------- | -------------------------------------------------- | ------------------------ |
| `ok(value)`                 | `T → Result<T, E>`                                 | Create successful result |
| `err(error)`                | `E → Result<T, E>`                                 | Create failed result     |
| `isOk(result)`              | `Result<T, E> → boolean`                           | Check if successful      |
| `isErr(result)`             | `Result<T, E> → boolean`                           | Check if failed          |
| `map(result, fn)`           | `Result<T, E> → (T → U) → Result<U, E>`            | Transform success value  |
| `flatMap(result, fn)`       | `Result<T, E> → (T → Result<U, E>) → Result<U, E>` | Chain operations         |
| `mapErr(result, fn)`        | `Result<T, E> → (E → F) → Result<T, F>`            | Transform error value    |
| `orElse(result, fn)`        | `Result<T, E> → (E → Result<T, F>) → Result<T, F>` | Provide fallback         |
| `unwrap(result)`            | `Result<T, E> → T \| E`                            | Extract value (unsafe)   |
| `unwrapOr(result, default)` | `Result<T, E> → T → T`                             | Extract with default     |
| `all(results)`              | `Result<T, E>[] → Result<T[], E>`                  | Combine results          |
| `any(results)`              | `Result<T, E>[] → Result<T, E[]>`                  | First success            |
| `match(result, handlers)`   | `Result<T, E> → { ok, err } → U`                   | Pattern match            |

### Option<T>

| Function                    | Type                                      | Description              |
| --------------------------- | ----------------------------------------- | ------------------------ |
| `some(value)`               | `T → Option<T>`                           | Create option with value |
| `none()`                    | `() → Option<T>`                          | Create empty option      |
| `isSome(option)`            | `Option<T> → boolean`                     | Check if has value       |
| `isNone(option)`            | `Option<T> → boolean`                     | Check if empty           |
| `fromNullable(value)`       | `T \| null \| undefined → Option<T>`      | Convert nullable         |
| `map(option, fn)`           | `Option<T> → (T → U) → Option<U>`         | Transform if present     |
| `flatMap(option, fn)`       | `Option<T> → (T → Option<U>) → Option<U>` | Chain operations         |
| `filter(option, pred)`      | `Option<T> → (T → boolean) → Option<T>`   | Keep if predicate passes |
| `unwrap(option)`            | `Option<T> → T \| undefined`              | Extract value (unsafe)   |
| `unwrapOr(option, default)` | `Option<T> → T → T`                       | Extract with default     |
| `match(option, handlers)`   | `Option<T> → { some, none } → U`          | Pattern match            |
| `head(array)`               | `T[] → Option<T>`                         | First element safely     |
| `tail(array)`               | `T[] → Option<T[]>`                       | Rest of array safely     |

### Composition

| Function              | Type                       | Description                    |
| --------------------- | -------------------------- | ------------------------------ |
| `pipe(value, ...fns)` | `T → ...Function[] → U`    | Thread value through functions |
| `flow(...fns)`        | `...Function[] → Function` | Create function pipeline       |
| `compose(...fns)`     | `...Function[] → Function` | Right-to-left composition      |
| `tap(fn)`             | `(T → void) → T → T`       | Side effect in pipeline        |

### Combinators

| Function                       | Type                                                          | Description                                                |
| ------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `identity(x)`                  | `T → T`                                                       | Return input unchanged                                     |
| `constant(x)`                  | `T → () → T`                                                  | Always return same value                                   |
| `flip(fn)`                     | `(A → B → C) → (B → A → C)`                                   | Flip first two arguments                                   |
| `curry2(fn)`                   | `(A, B) → C) → A → B → C`                                     | Curry 2-arg function                                       |
| `curry3(fn)`                   | `(A, B, C) → D) → A → B → C → D`                              | Curry 3-arg function                                       |
| `partial(fn, ...args)`         | `Function → ...any[] → Function`                              | Partially apply function                                   |
| `memoize(fn, { maxSize? })`    | `Function → MemoizeOptions → Function`                        | Cache with bounded LRU (default `maxSize: 1000`)           |
| `memoizeWith(fn, keyFn, opts)` | `Function → (T → string) → MemoizeOptions → Function`         | Cache with custom key fn + LRU                             |
| `once(fn)`                     | `Function → Function`                                         | Call exactly once (replays value or rethrows cached error) |
| `either(fn1, fn2)`             | `(A → R) → (A → R) → (A → Result<R, { primary, fallback? }>)` | Try-with-fallback lifted into Result                       |
| `tryOrElse(fn1, fn2)`          | `(A → R) → (A → R) → (A → R)`                                 | Try-with-fallback returning `R` (rethrows unmatched)       |
| `chainNullable(fn1, fn2)`      | `(A → B?) → (B → C?) → (A → C?)`                              | Compose nullable-returning functions                       |

## Why @phyxiusjs/fp?

### vs Exceptions

```typescript
// ❌ Exceptions hide failure modes
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`); // Can throw
  if (!response.ok) throw new Error("Not found"); // Hidden throw
  return response.json(); // Can throw
}

// ✅ Result makes failure explicit
async function fetchUser(id: string): Promise<Result<User, string>> {
  const response = await fromPromise(fetch(`/api/users/${id}`));
  return flatMap(response, (r) => (r.ok ? fromPromise(r.json()) : err("Not found")));
}
```

### vs null/undefined

```typescript
// ❌ Nullable values are error-prone
function getConfig(key: string): string | null {
  return config[key] || null; // Is "" intended to be null?
}

// ✅ Option is explicit
function getConfig(key: string): Option<string> {
  return key in config ? some(config[key]) : none();
}
```

### vs Promises

```typescript
// ❌ Promises mix success and failure
promise.then(handleSuccess).catch(handleError); // Which operations can fail?

// ✅ Result separates concerns
const result = await fromPromise(promise);
match(result, {
  ok: handleSuccess,
  err: handleError,
});
```

## Philosophy

This library embodies the Phyxius philosophy:

- **Slow is fast because we only do it once**: Get the types right, and many bugs become impossible
- **Make failure explicit**: Function signatures show what can go wrong
- **Composition over configuration**: Small pieces that fit together

## Part of the Phyxius Ecosystem

`@phyxiusjs/fp` depends on `@phyxiusjs/clock` — the async-result module's
`retryAsync` and `timeoutAsync` accept a Clock so retry backoff and timeouts
are deterministic under a controlled clock. No raw `setTimeout` or
`Date.now()` inside this library.

Pairs naturally with:

- `@phyxiusjs/atom` — Result + Atom for state that can fail
- `@phyxiusjs/journal` — Result-valued events in an ordered log
- `@phyxiusjs/temporal` — debounce/throttle under the same Clock

---

Make the happy path obvious and the sad path explicit.

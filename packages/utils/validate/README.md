# Validate

The validator contract — nothing about any specific library. Zod is one implementation choice per caller. Anything else (Valibot, Yup, Joi, hand-rolled) can plug in the same way.

---

## What this really is

A 5-line interface plus a small runtime for converting throws into `Result`s. That's it. Phyxius code (handlers, config, adapters) imports `Validator<T>` from here. How any particular consumer implements their validators is none of our business.

```ts
export interface Validator<T> {
  parse(input: unknown): T;
}
```

Anything with that shape is a `Validator<T>`. The throw stays at the validator boundary; Phyxius code calls `validate(v, input)` which returns a `Result<T, ValidationError>`, so failure flows as a value.

---

## Installation

```bash
npm install @phyxiusjs/validate @phyxiusjs/fp
```

No runtime dependency on Zod or any validator library. Bring your own.

---

## Quick start

### With Zod (the intended default)

```ts
import { validate } from "@phyxiusjs/validate";
import { isOk } from "@phyxiusjs/fp";
import { z } from "zod";

const orderSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
});

const result = validate(orderSchema, { id: "ord-1", amount: 99.9 });
if (isOk(result)) {
  // result.value is typed as { id: string; amount: number }
  console.log(result.value);
}
```

Zod schemas satisfy the `Validator<T>` interface structurally — no adapter needed.

### With any throw-based validator

```ts
import { fromThrowing, validate } from "@phyxiusjs/validate";

const parsePort = fromThrowing<number>((input) => {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid port: ${String(input)}`);
  }
  return n;
});

const result = validate(parsePort, "8080"); // Ok(8080)
```

### With Zod's `safeParse` for richer error detail

```ts
import { fromSafeParse, validate } from "@phyxiusjs/validate";
import { z } from "zod";

const schema = z.object({ count: z.number() });
const wrapped = fromSafeParse(schema);

const result = validate(wrapped, { count: "oops" });
// result.error.issues[0] has path: ["count"], code: "invalid_type", etc.
```

Use `fromSafeParse` when you want the library's native issue detail preserved (Zod in particular has rich `code` values worth surfacing).

### Test-only pass-through

```ts
import { passthrough } from "@phyxiusjs/validate";

// No runtime validation. Use when you're asserting the type because upstream
// already validated, or in tests where you just want a typed placeholder.
const untyped: Validator<MyShape> = passthrough<MyShape>();
```

---

## API

```ts
interface Validator<T> {
  parse(input: unknown): T;  // throws on invalid
}

interface ValidationIssue {
  path: ReadonlyArray<string | number>;
  message: string;
  code?: string;
}

interface ValidationError {
  issues: ReadonlyArray<ValidationIssue>;
}

function validate<T>(
  v: Validator<T>,
  input: unknown,
): Result<T, ValidationError>;

function fromThrowing<T>(fn: (input: unknown) => T): Validator<T>;
function fromSafeParse<T>(schema: { safeParse(...): ... }): Validator<T>;
function passthrough<T>(): Validator<T>;
```

### Error normalization

`validate()` unpacks thrown errors into `ValidationError.issues`:

- **Zod-like errors** (have `.issues: [...]`): issues unpacked with path, message, code
- **Plain `Error` instances**: single issue with the message
- **Anything else**: single issue with `String(thrown)`

---

## Why this package exists

Phyxius code does runtime validation at boundaries (handler input/output, config parsing, adapter decoding). We want ONE contract everyone agrees on, so:

- Handlers can declare `input: Validator<T>` without coupling to any specific library
- Tests can provide `{ parse: (x) => x as T }` as a trivial stub
- Swapping Zod for Valibot or a custom validator is a per-caller choice, not a library-wide migration
- Nothing in Phyxius imports Zod directly

The package has no runtime dependency on any validator library. Zod is used in its own tests and recommended in the README, but the package ships without it.

---

## What this does NOT do

- **No validator combinators.** No `combine`, `sequence`, `when` — those live in userland or in `@phyxiusjs/fp`'s validation module if you want them.
- **No schema generation or introspection.** Validators are opaque — we call `parse`, we don't care how they decide.
- **No error formatting opinions.** `ValidationError.issues` is a value; format it however you like.

---

## What you get

- **A 5-line contract** every Phyxius primitive can rely on.
- **Zero lock-in** to any specific validation library.
- **Result-returning runtime** — throws are contained at the boundary.
- **Structured issue info** when the underlying library provides it.

Use Zod. Or don't. The library doesn't know, doesn't care, doesn't need to.

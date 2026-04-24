# Observe

The accumulator. The piece that lets nested code contribute to a single contextual event without threading observability data through every function signature.

---

## What this really is

Observe is how you write structured data into the current `@phyxiusjs/context` scope. It pairs with Context and Journal to deliver the "one event per unit of work" pattern: any code under a scope can add to the picture, and the outer handler appends one complete journal entry at the end.

Every field you observe is **declared as a typed handle up front**. There is no loose string-keyed bag. The schema you declare becomes the sidecar type for the process — readable by humans, readable by LLMs, enforceable by the compiler.

```ts
import { observe } from "@phyxiusjs/observe";

// Declare once. This IS the observability schema for the process.
export const fields = observe.fields({
  requestId: observe.field<string>(),
  operation: observe.field<string>(),
  attempts: observe.number(),
  events: observe.array<{ type: string; at: number }>(),
  errors: observe.array<{ message: string; code: string }>(),
});
```

Use it inside any `context.scope`:

```ts
await context.scope(
  async () => {
    fields.operation.set("payment.charge"); // typed: must be string
    fields.attempts.inc(); // typed: must be numeric field
    fields.events.push({ type: "auth.start", at: clock.now().wallMs });

    await chargeCard();

    fields.attempts.inc();
    fields.events.push({ type: "card.declined", at: clock.now().wallMs });
  },
  { initial: {} },
);
```

At the end, get a typed snapshot for the journal:

```ts
const snap = observe.snapshot(fields);
// snap: Partial<{
//   requestId: string;
//   operation: string;
//   attempts: number;
//   events: {type: string; at: number}[];
//   errors: {message: string; code: string}[];
// }>
journal.append(snap);
```

---

## Why typed-first

The original design was a loose string-keyed bag — easy to add fields, no declaration overhead. That ergonomics ended at the moment the codebase started assuming shapes it never declared: `get("attempts") as number`, `push("events", x)` where `x` could be anything, silent type coercion when somebody `set("events", "oops")` before a nested scope pushed.

Explicit schemas fix this at the source:

- **No silent coercion.** `inc` on a non-numeric field throws. `push` on a non-array field throws. The loose API where "I'll just replace whatever was there" is gone.
- **LLMs reading the code see the schema.** A re-imagined handler's `observe-fields.ts` is the single file that says "here is what this process observes." No grepping for `observe.set` call sites.
- **Refactor-friendly.** Rename a field once in the schema; TS flags every call site.
- **Discoverable.** `fields.` autocompletes to the full observable surface.
- **Derivable shape.** `InferShape<typeof fields>` gives you the plain-object type — use it anywhere you need to consume the accumulated data downstream.

The declaration cost (writing `observe.fields({...})` once per process) is a rounding error compared to what you get — and in an LLM-authored codebase, the "cost" is zero.

---

## Composition: Context + Observe + Journal

The three primitives together are the mechanism behind "one event per unit of work":

```ts
import { context } from "@phyxiusjs/context";
import { observe, type InferShape } from "@phyxiusjs/observe";
import { Journal } from "@phyxiusjs/journal";

const fields = observe.fields({
  operation: observe.field<string>(),
  attempts: observe.number(),
  spans: observe.array<{ name: string; startedAt: number; durationMs: number }>(),
});

const journal = new Journal<Partial<InferShape<typeof fields>>>({ clock });

async function runRequest() {
  await context.scope(
    async () => {
      fields.operation.set("checkout");

      // Nested operations push into the SAME accumulated trace —
      // this is the core of why Context inherits by shallow copy.
      await validateCart();
      await reservePayment();
      await fulfill();

      journal.append(observe.snapshot(fields));
    },
    { initial: {} },
  );
}

async function validateCart() {
  const started = clock.now().wallMs;
  // ... work ...
  fields.spans.push({
    name: "cart.validate",
    startedAt: started,
    durationMs: clock.now().wallMs - started,
  });
}
```

Any nested function can contribute. At the end, **one** journal entry contains the complete story.

---

## API

### Declarations

```ts
observe.field<T>(): PendingValueField<T>     // .set / .get / .has / .delete
observe.number(): PendingNumericField        // + .inc(amount?)
observe.array<T>(): PendingArrayField<T>     // + .push(value)
```

Pending fields are declaration-only — they carry the type but not the key. The key comes from the property name when you resolve the schema.

### Resolution

```ts
observe.fields(schema): ResolvedFields<typeof schema>
```

Takes a record of pending field declarations, returns a record of typed handles keyed by the same property names.

### Snapshot

```ts
observe.snapshot(fields): Partial<InferShape<typeof fields>>
```

Reads the current scope's data and returns only the declared fields that have been set. Fully typed — each key has its declared type.

### Shape inference

```ts
type Shape = InferShape<typeof fields>;
```

Derives the plain-object shape from a resolved fields bag. Useful for typing journals, downstream consumers, or cross-boundary payloads.

### Handle API

```ts
interface ObserveField<T> {
  readonly key: string;
  set(value: T): void;
  get(): T | undefined;
  has(): boolean;
  delete(): boolean;
}

interface NumericObserveField extends ObserveField<number> {
  inc(amount?: number): void; // throws if existing value is non-numeric
}

interface ArrayObserveField<T> extends ObserveField<T[]> {
  push(value: T): void; // throws if existing value is non-array
}
```

---

## Cross-scope accumulation

`observe` respects Context's shallow inheritance (which is the point — it's how accumulation works):

```ts
const fields = observe.fields({
  trace: observe.array<{ span: string; op: string }>(),
});

await context.scope(
  async () => {
    fields.trace.push({ span: "root", op: "login" });

    await context.scope(async () => {
      fields.trace.push({ span: "child", op: "validate" });
    });

    // Parent sees both. This is the mechanism, not a bug.
    const t = fields.trace.get();
    // [{ span: "root", op: "login" }, { span: "child", op: "validate" }]
  },
  { initial: { trace: [] } },
);
```

When you want scope isolation (rare), pass `inherit: false` to the inner `context.scope(...)`.

---

## What observe does NOT do

- **No durability.** Writing happens in-memory on the active scope's data. The snapshot is a value; shipping it to disk or a pipeline is the journal/drain layer's job.
- **No runtime schema registry.** The schema lives in your code as a typed handle bag, not in a separate system. TypeScript is the only check.
- **No cross-process propagation.** Everything is local to the current `AsyncLocalStorage` scope. Tracing across services needs transport-level propagation.
- **No implicit fields.** If it's not declared, you can't observe it. Missing-by-design.

---

## Installation

```bash
npm install @phyxiusjs/observe @phyxiusjs/context
```

---

## What you get

- **Sidecar types.** Your schema file is the observability surface, readable by humans and LLMs, checked by the compiler.
- **Accumulation that composes.** Nested scopes contribute to the same trace; the outer handler gets the complete story.
- **Failure modes structurally impossible.** Can't set a string to a numeric field. Can't push to a non-array. Can't silently clobber data by forgetting the shape.
- **Zero runtime overhead.** Thin wrappers over `ctx.data` reads and writes. The types live at compile time.

Observe is the small primitive that made the composition click. Once you have Context flowing data, Observe declaring the shape, and Journal holding the entries, you don't need middleware, handlers-as-classes, or framework ceremony. You just need to know what you want to observe — and now the compiler knows too.

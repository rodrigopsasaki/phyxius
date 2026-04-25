import { context } from "@phyxiusjs/context";

// ── Field specs — the schema-level vocabulary ──────────────────────────────
//
// `FieldSpec`, `NumericFieldSpec`, and `ArrayFieldSpec` are what
// `observe.field()`, `observe.number()`, and `observe.array()` return.
// They carry a type but no key — the key is resolved when you pass the
// spec bag through `observe.fields({ ... })`, which uses the property
// names of the bag as the keys.
//
// These types are public because they appear in the inferred return type
// of `observe.fields(...)`. Consumers who export field bags from their
// own packages with `declaration: true` need the spec types to be
// nameable; you'll rarely write them by hand, but they're part of the
// API surface for that reason.
//
// Every spec has a `__tier` — either `"core"` (always captured + shipped,
// subject to sampling) or `"extra"` (captured in-scope but only
// serialized when the runtime opts in). Extras are the breadcrumbs that
// matter during debugging but aren't worth the log-bill in prod.

/**
 * Field tier. `"core"` = always captured, always shipped through the
 * sampling filter. `"extra"` = captured, shipped only when the runtime's
 * extras flag is on (typically dev / on-call debug windows).
 */
export type FieldTier = "core" | "extra";

/**
 * The spec returned by `observe.field<T>()` and `observe.extra<T>()`.
 * Carries the value type for inference; the runtime methods (`set` /
 * `get` / `has` / `delete`) are added by `observe.fields({ ... })`,
 * which resolves the spec into a typed handle.
 *
 * You rarely write this by hand — `observe.field<T>()` produces it. It's
 * exported because the inferred return type of `observe.fields(...)`
 * names it, and downstream packages with `declaration: true` need every
 * type in their declarations to have a public name.
 */
export interface FieldSpec<T> {
  readonly __kind: "value";
  readonly __tier: FieldTier;
  readonly __type?: T;
}

/**
 * The spec returned by `observe.number()` and `observe.extraNumber()`.
 * Resolves to a `NumericObserveField` (with `.inc()`) when passed
 * through `observe.fields({ ... })`.
 */
export interface NumericFieldSpec {
  readonly __kind: "number";
  readonly __tier: FieldTier;
}

/**
 * The spec returned by `observe.array<T>()` and `observe.extraArray<T>()`.
 * Resolves to an `ArrayObserveField<T>` (with `.push(value)`) when
 * passed through `observe.fields({ ... })`.
 */
export interface ArrayFieldSpec<T> {
  readonly __kind: "array";
  readonly __tier: FieldTier;
  readonly __element?: T;
}

/** Any field spec. Useful as a constraint for generic schema types. */
export type AnyFieldSpec = FieldSpec<unknown> | NumericFieldSpec | ArrayFieldSpec<unknown>;

// ── Handle types (what call sites actually use) ─────────────────────────────

export interface ObserveField<T> {
  readonly key: string;
  /** The tier — `"core"` or `"extra"`. Drives whether the snapshot ships the value. */
  readonly tier: FieldTier;
  /** Set the value. Overwrites any existing value at this key. */
  set(value: T): void;
  /** Read the value, or undefined if not set in the current scope's data. */
  get(): T | undefined;
  /** True if this key is set in the current scope's data. */
  has(): boolean;
  /** Remove the key from the current scope's data. Returns true if removed. */
  delete(): boolean;
}

export interface NumericObserveField extends ObserveField<number> {
  /**
   * Increment the counter by `amount` (default 1). If the key is unset,
   * initializes to `amount`. Throws if the existing value is not a number —
   * silent coercion would hide real bugs.
   */
  inc(amount?: number): void;
}

export interface ArrayObserveField<T> extends ObserveField<T[]> {
  /**
   * Append `value` to the array. If the key is unset, initializes to `[value]`.
   * Throws if the existing value is not an array — silent coercion would hide
   * real bugs.
   */
  push(value: T): void;
}

// ── Resolver types ──────────────────────────────────────────────────────────

type ResolveField<P> =
  P extends FieldSpec<infer T>
    ? ObserveField<T>
    : P extends NumericFieldSpec
      ? NumericObserveField
      : P extends ArrayFieldSpec<infer T>
        ? ArrayObserveField<T>
        : never;

/**
 * The typed handle bag returned by `observe.fields({ ... })`. Keys match the
 * property names of the schema; each value is the resolved handle.
 */
export type ResolvedFields<S extends Record<string, AnyFieldSpec>> = {
  readonly [K in keyof S]: ResolveField<S[K]>;
};

/**
 * Derive the runtime data shape from a schema — useful for downstream consumers
 * that need to type-check the accumulated data (Journal entries, reports, etc.)
 */
export type InferShape<S> = {
  [K in keyof S]: S[K] extends FieldSpec<infer T>
    ? T
    : S[K] extends NumericFieldSpec
      ? number
      : S[K] extends ArrayFieldSpec<infer T>
        ? T[]
        : S[K] extends ObserveField<infer T>
          ? T
          : never;
};

// ── Implementation ─────────────────────────────────────────────────────────

function dataOf(): Record<string, unknown> {
  return context.get().data as Record<string, unknown>;
}

function makeValueHandle<T>(key: string, tier: FieldTier): ObserveField<T> {
  return {
    key,
    tier,
    set(value: T): void {
      dataOf()[key] = value;
    },
    get(): T | undefined {
      return dataOf()[key] as T | undefined;
    },
    has(): boolean {
      return key in dataOf();
    },
    delete(): boolean {
      const data = dataOf();
      if (key in data) {
        delete data[key];
        return true;
      }
      return false;
    },
  };
}

function makeNumericHandle(key: string, tier: FieldTier): NumericObserveField {
  const base = makeValueHandle<number>(key, tier);
  return {
    ...base,
    inc(amount: number = 1): void {
      const data = dataOf();
      const current = data[key];
      if (current === undefined) {
        data[key] = amount;
        return;
      }
      if (typeof current !== "number") {
        throw new TypeError(`observe: cannot inc '${key}' — existing value is ${typeof current}, expected number`);
      }
      data[key] = current + amount;
    },
  };
}

function makeArrayHandle<T>(key: string, tier: FieldTier): ArrayObserveField<T> {
  const base = makeValueHandle<T[]>(key, tier);
  return {
    ...base,
    push(value: T): void {
      const data = dataOf();
      const current = data[key];
      if (current === undefined) {
        data[key] = [value];
        return;
      }
      if (!Array.isArray(current)) {
        throw new TypeError(`observe: cannot push to '${key}' — existing value is ${typeof current}, expected array`);
      }
      current.push(value);
    },
  };
}

function makeHandle(key: string, spec: AnyFieldSpec): unknown {
  switch (spec.__kind) {
    case "value":
      return makeValueHandle(key, spec.__tier);
    case "number":
      return makeNumericHandle(key, spec.__tier);
    case "array":
      return makeArrayHandle(key, spec.__tier);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Typed observation primitive.
 *
 * The schema is mandatory. You declare every observable field up front; the
 * resulting handles are what you call at runtime. There is no loose
 * string-keyed escape hatch — if a field isn't declared, it can't be observed.
 *
 * @example
 * ```ts
 * const fields = observe.fields({
 *   requestId: observe.field<string>(),
 *   operation: observe.field<string>(),
 *   attempts: observe.number(),
 *   events: observe.array<{ type: string; at: number }>(),
 * });
 *
 * // Inside a context.scope:
 * fields.operation.set("payment.charge");
 * fields.attempts.inc();
 * fields.events.push({ type: "auth.start", at: clock.now().wallMs });
 *
 * // Typed snapshot for journal entries:
 * const snap = observe.snapshot(fields);
 * // snap: Partial<{ requestId: string; operation: string; attempts: number; events: {...}[] }>
 * ```
 */
export const observe = {
  // ── Core tier ──────────────────────────────────────────────────────────
  // Core fields are always captured and always shipped (subject to
  // sampling). Use them for the load-bearing observation data — the things
  // an operator reconstructs the story from at 3am.

  /** Declare a core typed-value field. Resolved by `observe.fields()`. */
  field<T>(): FieldSpec<T> {
    return { __kind: "value", __tier: "core" };
  },

  /** Declare a core numeric field (gains `.inc()`). */
  number(): NumericFieldSpec {
    return { __kind: "number", __tier: "core" };
  },

  /** Declare a core array field (gains `.push()`). */
  array<T>(): ArrayFieldSpec<T> {
    return { __kind: "array", __tier: "core" };
  },

  // ── Extra tier ─────────────────────────────────────────────────────────
  // Extras are captured the same way (same `set()`, same `push()`, same
  // context scope), but a runtime opts into whether they survive the
  // journal snapshot. Use them for debug breadcrumbs, intermediate values,
  // verbose context you want during investigation but not during steady
  // state. Cost is a knob, not a code change: flip the runtime flag and
  // the same handler starts (or stops) emitting them.

  /** Declare an extra typed-value field — captured always, shipped on opt-in. */
  extra<T>(): FieldSpec<T> {
    return { __kind: "value", __tier: "extra" };
  },

  /** Declare an extra numeric field (gains `.inc()`). */
  extraNumber(): NumericFieldSpec {
    return { __kind: "number", __tier: "extra" };
  },

  /** Declare an extra array field (gains `.push()`). */
  extraArray<T>(): ArrayFieldSpec<T> {
    return { __kind: "array", __tier: "extra" };
  },

  /**
   * Resolve a schema of field specs into typed handles, keyed by the
   * property names of the schema object.
   */
  fields<S extends Record<string, AnyFieldSpec>>(schema: S): ResolvedFields<S> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(schema)) {
      const spec = schema[key];
      if (spec) {
        result[key] = makeHandle(key, spec);
      }
    }
    return result as ResolvedFields<S>;
  },

  /**
   * Take a typed snapshot of the fields currently set in the active scope's
   * data. Only keys declared in the schema are included; the result is a
   * `Partial` because individual fields may not have been written yet.
   *
   * `includeExtra` defaults to `true` — existing callers get every declared
   * field, as before. Pass `false` to filter out fields declared with
   * `observe.extra*()`, which is what runtimes do in production when the
   * verbose-debug flag is off.
   */
  snapshot<S extends Record<string, AnyFieldSpec>>(
    fields: ResolvedFields<S>,
    options: { includeExtra?: boolean } = {},
  ): Partial<InferShape<S>> {
    const { includeExtra = true } = options;
    const data = dataOf();
    const result: Record<string, unknown> = {};
    for (const handle of Object.values(fields as Record<string, ObserveField<unknown>>)) {
      if (!includeExtra && handle.tier === "extra") continue;
      if (handle.key in data) {
        result[handle.key] = data[handle.key];
      }
    }
    return result as Partial<InferShape<S>>;
  },
};

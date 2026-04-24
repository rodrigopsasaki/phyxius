import { context } from "@phyxiusjs/context";

// ── Pending field declarations ──────────────────────────────────────────────
//
// These are "thunks" — you declare them with a type but no key; the key is
// resolved when you pass them through `observe.fields({ ... })`. The tagged
// `__kind` field drives runtime dispatch; the phantom type fields carry the
// generic through to the resolved handle.
//
// Every field has a `__tier` — either `"core"` (always captured + shipped,
// subject to sampling) or `"extra"` (captured in-scope but only serialized
// when the runtime opts in). Extras are the breadcrumbs that matter during
// debugging but aren't worth the log-bill in prod.

/**
 * Field tier. `"core"` = always captured, always shipped through the
 * sampling filter. `"extra"` = captured, shipped only when the runtime's
 * extras flag is on (typically dev / on-call debug windows).
 */
export type FieldTier = "core" | "extra";

interface PendingValueField<T> {
  readonly __kind: "value";
  readonly __tier: FieldTier;
  readonly __type?: T;
}

interface PendingNumericField {
  readonly __kind: "number";
  readonly __tier: FieldTier;
}

interface PendingArrayField<T> {
  readonly __kind: "array";
  readonly __tier: FieldTier;
  readonly __element?: T;
}

type AnyPendingField = PendingValueField<unknown> | PendingNumericField | PendingArrayField<unknown>;

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
  P extends PendingValueField<infer T>
    ? ObserveField<T>
    : P extends PendingNumericField
      ? NumericObserveField
      : P extends PendingArrayField<infer T>
        ? ArrayObserveField<T>
        : never;

/**
 * The typed handle bag returned by `observe.fields({ ... })`. Keys match the
 * property names of the schema; each value is the resolved handle.
 */
export type ResolvedFields<S extends Record<string, AnyPendingField>> = {
  readonly [K in keyof S]: ResolveField<S[K]>;
};

/**
 * Derive the runtime data shape from a schema — useful for downstream consumers
 * that need to type-check the accumulated data (Journal entries, reports, etc.)
 */
export type InferShape<S> = {
  [K in keyof S]: S[K] extends PendingValueField<infer T>
    ? T
    : S[K] extends PendingNumericField
      ? number
      : S[K] extends PendingArrayField<infer T>
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

function makeHandle(key: string, pending: AnyPendingField): unknown {
  switch (pending.__kind) {
    case "value":
      return makeValueHandle(key, pending.__tier);
    case "number":
      return makeNumericHandle(key, pending.__tier);
    case "array":
      return makeArrayHandle(key, pending.__tier);
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
  field<T>(): PendingValueField<T> {
    return { __kind: "value", __tier: "core" };
  },

  /** Declare a core numeric field (gains `.inc()`). */
  number(): PendingNumericField {
    return { __kind: "number", __tier: "core" };
  },

  /** Declare a core array field (gains `.push()`). */
  array<T>(): PendingArrayField<T> {
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
  extra<T>(): PendingValueField<T> {
    return { __kind: "value", __tier: "extra" };
  },

  /** Declare an extra numeric field (gains `.inc()`). */
  extraNumber(): PendingNumericField {
    return { __kind: "number", __tier: "extra" };
  },

  /** Declare an extra array field (gains `.push()`). */
  extraArray<T>(): PendingArrayField<T> {
    return { __kind: "array", __tier: "extra" };
  },

  /**
   * Resolve a schema of pending field declarations into typed handles, keyed
   * by the property names of the schema object.
   */
  fields<S extends Record<string, AnyPendingField>>(schema: S): ResolvedFields<S> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(schema)) {
      const pending = schema[key];
      if (pending) {
        result[key] = makeHandle(key, pending);
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
  snapshot<S extends Record<string, AnyPendingField>>(
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

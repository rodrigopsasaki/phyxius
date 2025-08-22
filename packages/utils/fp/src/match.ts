/**
 * Pattern matching utilities for exhaustive control flow.
 * Enables type-safe, exhaustive pattern matching similar to Rust/Haskell.
 */

/** Base matcher type */
export type Pattern<T, R> = {
  predicate: (value: T) => boolean;
  handler: (value: T) => R;
};

/** Value matcher type */
export type ValuePattern<T, R> = {
  value: T;
  handler: (value: T) => R;
};

/** Type predicate pattern */
export type GuardPattern<T, S extends T, R> = {
  guard: (value: T) => value is S;
  handler: (value: S) => R;
};

/** Default/wildcard pattern */
export type DefaultPattern<T, R> = {
  _: true;
  handler: (value: T) => R;
};

/** Combined pattern types */
export type MatchPattern<T, R> = Pattern<T, R> | ValuePattern<T, R> | GuardPattern<T, T, R> | DefaultPattern<T, R>;

/** Builder class for fluent pattern matching */
export class Matcher<T, R = never> {
  private patterns: Array<(value: T) => R | undefined> = [];
  private defaultHandler?: (value: T) => R;

  constructor(private value: T) {}

  /** Match exact value */
  when(value: T, handler: (value: T) => R): Matcher<T, R> {
    this.patterns.push((v) => (v === value ? handler(v) : undefined));
    return this as Matcher<T, R>;
  }

  /** Match with predicate */
  whenPredicate(predicate: (value: T) => boolean, handler: (value: T) => R): Matcher<T, R> {
    this.patterns.push((v) => (predicate(v) ? handler(v) : undefined));
    return this as Matcher<T, R>;
  }

  /** Match with type guard */
  whenGuard<S extends T>(guard: (value: T) => value is S, handler: (value: S) => R): Matcher<T, R> {
    this.patterns.push((v) => (guard(v) ? handler(v) : undefined));
    return this as Matcher<T, R>;
  }

  /** Default case (wildcard) */
  otherwise(handler: (value: T) => R): R {
    this.defaultHandler = handler;
    return this.run();
  }

  /** Execute pattern matching */
  run(): R {
    for (const pattern of this.patterns) {
      const result = pattern(this.value);
      if (result !== undefined) return result;
    }
    if (this.defaultHandler) {
      return this.defaultHandler(this.value);
    }
    throw new Error("Non-exhaustive pattern match");
  }
}

/** Create a new matcher */
export function match<T>(value: T): Matcher<T> {
  return new Matcher(value);
}

/** Quick pattern matching function */
export function matchValue<T, R>(value: T, patterns: Record<string, (value: T) => R> & { _?: (value: T) => R }): R {
  // Try to match string representation
  const key = String(value);
  if (key in patterns && key !== "_") {
    return patterns[key]!(value);
  }
  // Fall back to default
  if ("_" in patterns) {
    return patterns._!(value);
  }
  throw new Error(`No pattern matched for value: ${key}`);
}

/** Pattern matching for discriminated unions */
export function matchTag<T extends { _tag: string }, R, Tags extends T["_tag"] = T["_tag"]>(
  value: T,
  patterns: {
    [K in Tags]: (value: Extract<T, { _tag: K }>) => R;
  },
): R {
  const handler = patterns[value._tag as Tags];
  if (!handler) {
    throw new Error(`No pattern matched for tag: ${value._tag}`);
  }
  return handler(value as never);
}

/** Partial pattern matching with optional default */
export function matchPartial<T extends { _tag: string }, R, Tags extends T["_tag"] = T["_tag"]>(
  value: T,
  patterns: Partial<{
    [K in Tags]: (value: Extract<T, { _tag: K }>) => R;
  }> & { _?: (value: T) => R },
): R | undefined {
  const handler = patterns[value._tag as Tags];
  if (handler) {
    return handler(value as never);
  }
  if (patterns._) {
    return patterns._(value);
  }
  return undefined;
}

/** Pattern matching for boolean values */
export function matchBool<R>(
  value: boolean,
  patterns: {
    true: () => R;
    false: () => R;
  },
): R {
  return value ? patterns.true() : patterns.false();
}

/** Pattern matching for nullable values */
export function matchNullable<T, R>(
  value: T | null | undefined,
  patterns: {
    some: (value: T) => R;
    none: () => R;
  },
): R {
  return value !== null && value !== undefined ? patterns.some(value) : patterns.none();
}

/** Pattern matching for numbers with ranges */
export class NumberMatcher<R = never> {
  private patterns: Array<(value: number) => R | undefined> = [];
  private defaultHandler?: (value: number) => R;

  constructor(private value: number) {}

  /** Match exact number */
  when(num: number, handler: (value: number) => R): NumberMatcher<R> {
    this.patterns.push((v) => (v === num ? handler(v) : undefined));
    return this;
  }

  /** Match range (inclusive) */
  whenRange(min: number, max: number, handler: (value: number) => R): NumberMatcher<R> {
    this.patterns.push((v) => (v >= min && v <= max ? handler(v) : undefined));
    return this;
  }

  /** Match less than */
  whenLt(threshold: number, handler: (value: number) => R): NumberMatcher<R> {
    this.patterns.push((v) => (v < threshold ? handler(v) : undefined));
    return this;
  }

  /** Match greater than */
  whenGt(threshold: number, handler: (value: number) => R): NumberMatcher<R> {
    this.patterns.push((v) => (v > threshold ? handler(v) : undefined));
    return this;
  }

  /** Default case */
  otherwise(handler: (value: number) => R): R {
    this.defaultHandler = handler;
    return this.run();
  }

  /** Execute pattern matching */
  run(): R {
    for (const pattern of this.patterns) {
      const result = pattern(this.value);
      if (result !== undefined) return result;
    }
    if (this.defaultHandler) {
      return this.defaultHandler(this.value);
    }
    throw new Error(`Non-exhaustive pattern match for number: ${this.value}`);
  }
}

/** Create a number matcher */
export function matchNumber(value: number): NumberMatcher {
  return new NumberMatcher(value);
}

/** Pattern matching for strings with regex */
export class StringMatcher<R = never> {
  private patterns: Array<(value: string) => R | undefined> = [];
  private defaultHandler?: (value: string) => R;

  constructor(private value: string) {}

  /** Match exact string */
  when(str: string, handler: (value: string) => R): StringMatcher<R> {
    this.patterns.push((v) => (v === str ? handler(v) : undefined));
    return this;
  }

  /** Match with regex */
  whenRegex(regex: RegExp, handler: (value: string, matches: RegExpMatchArray) => R): StringMatcher<R> {
    this.patterns.push((v) => {
      const matches = v.match(regex);
      return matches ? handler(v, matches) : undefined;
    });
    return this;
  }

  /** Match prefix */
  whenPrefix(prefix: string, handler: (value: string) => R): StringMatcher<R> {
    this.patterns.push((v) => (v.startsWith(prefix) ? handler(v) : undefined));
    return this;
  }

  /** Match suffix */
  whenSuffix(suffix: string, handler: (value: string) => R): StringMatcher<R> {
    this.patterns.push((v) => (v.endsWith(suffix) ? handler(v) : undefined));
    return this;
  }

  /** Match contains */
  whenContains(substring: string, handler: (value: string) => R): StringMatcher<R> {
    this.patterns.push((v) => (v.includes(substring) ? handler(v) : undefined));
    return this;
  }

  /** Default case */
  otherwise(handler: (value: string) => R): R {
    this.defaultHandler = handler;
    return this.run();
  }

  /** Execute pattern matching */
  run(): R {
    for (const pattern of this.patterns) {
      const result = pattern(this.value);
      if (result !== undefined) return result;
    }
    if (this.defaultHandler) {
      return this.defaultHandler(this.value);
    }
    throw new Error(`Non-exhaustive pattern match for string: ${this.value}`);
  }
}

/** Create a string matcher */
export function matchString(value: string): StringMatcher {
  return new StringMatcher(value);
}

/** Exhaustive check helper for switch statements */
export function exhaustive(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

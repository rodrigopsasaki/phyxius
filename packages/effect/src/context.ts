import type { Context } from "./types.js";

export class ContextImpl implements Context {
  readonly values: Map<string, unknown>;

  constructor(values: Map<string, unknown> = new Map()) {
    this.values = new Map(values);
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  with<T>(key: string, value: T): Context {
    const newValues = new Map(this.values);
    newValues.set(key, value);
    return new ContextImpl(newValues);
  }
}

export function createContext(initial?: Map<string, unknown>): Context {
  return new ContextImpl(initial);
}

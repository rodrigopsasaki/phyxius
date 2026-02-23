import type { ObserveContextImpl } from "./types.js";

/**
 * Create a new observe context for tracking execution metadata
 */
export function createObserveContext(): ObserveContextImpl {
  const data: Record<string, unknown> = {};

  return {
    set(key: string, value: unknown): void {
      data[key] = value;
    },

    push(key: string, value: unknown): void {
      const current = data[key];
      if (Array.isArray(current)) {
        current.push(value);
      } else {
        data[key] = [value];
      }
    },

    inc(key: string, amount = 1): void {
      const current = data[key];
      if (typeof current === "number") {
        data[key] = current + amount;
      } else {
        data[key] = amount;
      }
    },

    all(): Readonly<Record<string, unknown>> {
      return { ...data };
    },
  };
}

/**
 * Structural deep equality for shadow comparison.
 *
 * Intentionally conservative: strict equality for primitives, recursive
 * equality for plain objects and arrays, identity for Date / Map / Set
 * / typed arrays / other exotic types (callers who compare those can
 * supply a custom `equals`).
 *
 * NaN is considered equal to itself — a common pragmatic deviation from
 * `===`, because NaN-in-NaN-out is usually an intended result path in
 * numeric computations, and "NaN ≠ NaN" would fire spurious mismatches.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  // Identity / primitive equality.
  if (a === b) return true;

  // Both NaN.
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }

  // If either is null / undefined and not caught by ===, they differ.
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }

  // Must both be objects from here on.
  if (typeof a !== "object" || typeof b !== "object") return false;

  // Arrays: exact length + pairwise deep equal.
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }

  // Plain objects: same key set + deep equal values.
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }

  return true;
}

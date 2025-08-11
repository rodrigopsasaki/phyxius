export type { Atom, AtomSnapshot, EmitFn } from "./types.js";
export { AtomImpl } from "./atom.js";

import { AtomImpl } from "./atom.js";
import type { EmitFn } from "./types.js";

export function atom<T>(initialValue: T, options?: { emit?: EmitFn; maxHistory?: number }) {
  return new AtomImpl(initialValue, options);
}

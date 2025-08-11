export type { Journal, JournalEntry, JournalSnapshot, EmitFn } from "./types.js";
export { JournalImpl } from "./journal.js";

import { JournalImpl } from "./journal.js";
import type { EmitFn } from "./types.js";

export function journal<T = unknown>(options?: { emit?: EmitFn }) {
  return new JournalImpl<T>(options);
}

import { appendFile } from "node:fs/promises";
import { formatIso } from "@phyxiusjs/clock";
import type { Sink, DrainEntry, FileSinkOptions } from "../types.js";

/**
 * Appends each entry as a JSON line to a file.
 *
 * Uses async `appendFile`. Ordering is guaranteed by the drain: it only
 * allows one batch in flight via its internal `flushing` flag. No need for
 * synchronous fs calls — sync writes would just block the event loop for no
 * durability gain.
 */
export function fileSink<T>(options: FileSinkOptions): Sink<T> {
  const { path } = options;

  return {
    async write(entries: readonly DrainEntry<T>[]): Promise<void> {
      if (entries.length === 0) return;

      const lines = entries.map((entry) =>
        JSON.stringify({
          timestamp: formatIso(entry.timestamp.wallMs),
          sequence: entry.sequence,
          ...(entry.data as Record<string, unknown>),
        }),
      );

      await appendFile(path, `${lines.join("\n")}\n`, "utf-8");
    },
  };
}

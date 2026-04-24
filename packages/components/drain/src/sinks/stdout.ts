import { formatIso } from "@phyxiusjs/clock";
import type { Sink, DrainEntry } from "../types.js";

/**
 * Writes each entry as a JSON line to stdout.
 *
 * Useful for local development, Docker log collection, or piping to `jq`.
 * Each line is a self-contained JSON object with timestamp, sequence, and data.
 */
export function stdoutSink<T>(): Sink<T> {
  return {
    async write(entries: readonly DrainEntry<T>[]): Promise<void> {
      for (const entry of entries) {
        const line = JSON.stringify({
          timestamp: formatIso(entry.timestamp.wallMs),
          sequence: entry.sequence,
          ...(entry.data as Record<string, unknown>),
        });
        process.stdout.write(`${line}\n`);
      }
    },
  };
}

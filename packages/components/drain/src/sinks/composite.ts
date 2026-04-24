import type { Sink, DrainEntry } from "../types.js";

/**
 * Fans out entries to multiple sinks in parallel.
 *
 * All sinks receive every batch. If any sink throws, the error
 * propagates (the drain's error handling will catch and emit it).
 *
 * @example
 * ```ts
 * const sink = compositeSink([
 *   stdoutSink(),
 *   otlpHttpSink({ endpoint: "https://otel.axiom.co/v1/logs" }),
 * ]);
 * ```
 */
export function compositeSink<T>(sinks: readonly Sink<T>[]): Sink<T> {
  return {
    async write(entries: readonly DrainEntry<T>[]): Promise<void> {
      await Promise.all(sinks.map((sink) => sink.write(entries)));
    },
  };
}

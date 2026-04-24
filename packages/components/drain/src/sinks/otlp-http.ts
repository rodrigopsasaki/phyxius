import type { Sink, DrainEntry, OtlpHttpSinkOptions } from "../types.js";

/**
 * Converts drain entries to OTLP log record attributes.
 *
 * Object- and array-valued fields are JSON-stringified so they survive
 * round-tripping through OTLP backends. `String(obj)` would yield the
 * useless `"[object Object]"`.
 */
function toOtlpAttributes(data: Record<string, unknown>): Array<{ key: string; value: { stringValue: string } }> {
  const attributes: Array<{ key: string; value: { stringValue: string } }> = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;

    const stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);

    attributes.push({
      key,
      value: { stringValue },
    });
  }

  return attributes;
}

/**
 * Sends entries as OTLP log records via HTTP POST.
 *
 * Compatible with any OTLP-speaking backend: Grafana Cloud, Axiom,
 * SigNoz, OpenTelemetry Collector, etc.
 *
 * Uses native fetch() (Node 22+, no dependencies).
 */
export function otlpHttpSink<T>(options: OtlpHttpSinkOptions): Sink<T> {
  const { endpoint, headers = {}, resourceAttributes = {} } = options;

  const resourceAttrs = Object.entries(resourceAttributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));

  return {
    async write(entries: readonly DrainEntry<T>[]): Promise<void> {
      if (entries.length === 0) return;

      const logRecords = entries.map((entry) => ({
        timeUnixNano: String(entry.timestamp.wallMs * 1_000_000),
        severityText: "INFO",
        body: {
          stringValue: JSON.stringify(entry.data),
        },
        attributes: toOtlpAttributes({
          "log.sequence": entry.sequence,
          "log.id": entry.id,
          ...(entry.data as Record<string, unknown>),
        }),
      }));

      const payload = {
        resourceLogs: [
          {
            resource: { attributes: resourceAttrs },
            scopeLogs: [
              {
                scope: { name: "@phyxiusjs/drain" },
                logRecords,
              },
            ],
          },
        ],
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`OTLP export failed: ${response.status} ${response.statusText}`);
      }
    },
  };
}

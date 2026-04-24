import type { Clock, Instant, Millis } from "@phyxiusjs/clock";
import type { Journal } from "@phyxiusjs/journal";

/**
 * A single entry flowing through the drain, derived from a JournalEntry.
 */
export interface DrainEntry<T> {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: Instant;
  readonly data: T;
}

/**
 * A sink receives batches of entries and writes them to a destination.
 * Implementations: stdout, OTLP HTTP, file, composite.
 */
export interface Sink<T> {
  write(entries: readonly DrainEntry<T>[]): Promise<void>;
}

/**
 * What to do when the drain's buffer is full.
 *
 *  - `"drop_oldest"` — evict the oldest buffered entries to make room. Best
 *    effort; you lose history, not new entries. Fires `drain:overflow`.
 *  - `"error"` — reject new entries from the journal subscriber path (they
 *    effectively drop on the floor) and fire `drain:overflow`. Use when losing
 *    data is unacceptable and the operator must intervene.
 *
 * Same policy shape as Journal. Every drain is bounded — there is no
 * unbounded mode, because "the buffer grew until the process OOMed" is not
 * an error mode anyone wants to discover at 3am.
 */
export type DrainOverflowPolicy = "drop_oldest" | "error";

/**
 * Options for creating a drain.
 */
export interface DrainOptions<T> {
  /** The journal to subscribe to for new entries. */
  readonly journal: Journal<T>;
  /** Where to send the entries. */
  readonly sink: Sink<T>;
  /** Clock for flush scheduling and timestamps. No raw setTimeout inside. */
  readonly clock: Clock;
  /** Flush when the buffer reaches this size. Default: 100. */
  readonly batchSize?: number;
  /**
   * Cap on the buffer. When full, the `overflow` policy takes effect.
   * Default: 10_000. Must be > batchSize.
   */
  readonly maxBufferSize?: number;
  /** What to do when the buffer is full. Default: "drop_oldest". */
  readonly overflow?: DrainOverflowPolicy;
  /** Flush on this interval (milliseconds). Set to 0 to disable. Default: 5000. */
  readonly flushIntervalMs?: Millis;
  /** Structured event emitter for observability. */
  readonly emit?: (event: DrainEvent) => void;
}

/**
 * A running drain instance.
 */
export interface Drain {
  /** Manually flush all buffered entries to the sink. */
  flush(): Promise<void>;
  /** Flush remaining entries, cancel timer, unsubscribe from journal. */
  stop(): Promise<void>;
}

/**
 * Structured events emitted by the drain for observability.
 */
export type DrainEvent =
  | { readonly type: "drain:flush"; readonly count: number; readonly durationMs: number; readonly at: Instant }
  | { readonly type: "drain:error"; readonly error: unknown; readonly requeued: number; readonly at: Instant }
  | {
      readonly type: "drain:overflow";
      readonly policy: DrainOverflowPolicy;
      readonly maxBufferSize: number;
      readonly droppedCount: number;
      readonly at: Instant;
    }
  | { readonly type: "drain:stop"; readonly remaining: number; readonly at: Instant };

/**
 * Options for the OTLP HTTP sink.
 */
export interface OtlpHttpSinkOptions {
  /** OTLP logs endpoint (e.g., "https://otel.axiom.co/v1/logs"). */
  readonly endpoint: string;
  /** HTTP headers (e.g., for API keys). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Resource attributes attached to every log record. */
  readonly resourceAttributes?: Readonly<Record<string, string>>;
}

/**
 * Options for the file sink.
 */
export interface FileSinkOptions {
  /** File path to append JSON lines to. */
  readonly path: string;
}

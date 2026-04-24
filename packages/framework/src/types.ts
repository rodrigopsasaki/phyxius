import type { Clock } from "@phyxiusjs/clock";
import type { ConfigInstance } from "@phyxiusjs/config";
import type { HandlerEvent, HandlerSpec, RunningHandler } from "@phyxiusjs/handler";
import type { Journal } from "@phyxiusjs/journal";
import type { Stats } from "@phyxiusjs/stats";
import type { z } from "zod";

import type { FrameworkConfig } from "./config-schema.js";

// ── createApp options ─────────────────────────────────────────────────────

/**
 * Options for `createApp`. The `config` field points at a config source
 * (file path, inline object, or an already-built ConfigInstance); the
 * `appSchema` lets users extend the framework's own schema with their
 * application-specific fields (feature flags, secrets, integration
 * targets, etc.).
 */
export interface CreateAppOptions<TAppConfig extends Record<string, unknown> = Record<string, never>> {
  /**
   * Configuration source. One of:
   *   - A file path (e.g., `"./phyxius.yaml"` or `"./config/phyxius.json"`).
   *   - An inline object — useful for tests and hermetic deployments.
   *   - An already-built `ConfigInstance` for callers who want to own the
   *     config loader's lifecycle themselves.
   *
   * If omitted, the framework runs with schema defaults.
   */
  readonly config?: string | FrameworkConfig | ConfigInstance<FrameworkConfig & TAppConfig>;

  /**
   * Zod schema for the user's own config slice. If supplied, the full
   * config is validated against `frameworkConfigSchema` ∩ `appSchema`
   * and the returned `app.config` has the merged shape.
   */
  readonly appSchema?: z.ZodType<TAppConfig>;

  /**
   * Optional clock override. Defaults to `createSystemClock()`. Supply a
   * `ControlledClock` in tests to make the whole app deterministic.
   */
  readonly clock?: Clock;

  /**
   * Optional journal override. Defaults to a new bounded Journal with
   * `maxEntries: 10_000`. Supply your own when you want to share a
   * journal across multiple app instances or pre-populate it for tests.
   */
  readonly journal?: Journal<HandlerEvent>;
}

// ── App instance ─────────────────────────────────────────────────────────

/**
 * The value `createApp` returns. Methods are deliberately named after the
 * verb they perform, not the primitive they wrap — callers shouldn't have
 * to remember which adapter package backs each method. The primitives
 * themselves remain reachable via `app.clock`, `app.journal`, `app.stats`.
 */
export interface App<TAppConfig extends Record<string, unknown> = Record<string, never>> {
  // ── Handler registration ────────────────────────────────────────────────

  /**
   * Spawn a handler and register it for lifecycle management. Returns the
   * `RunningHandler` so you can pass it to `.route`, `.schedule`,
   * `.consume`, or invoke it directly for internal work. The returned
   * handler is automatically stopped (drained) when `app.stop()` fires.
   */
  use<TInput, TOutput>(spec: HandlerSpec<TInput, TOutput, unknown>): Promise<RunningHandler<TInput, TOutput>>;

  // ── Transport registration ──────────────────────────────────────────────

  /**
   * Register an HTTP route. Requires `@phyxiusjs/http` to be installed as
   * a peer dependency; throws a clear error otherwise. The HTTP server
   * starts on `app.start()` using the port from config.
   */
  route<TInput, TOutput>(route: AppRoute<TInput, TOutput>): void;

  /**
   * Register a scheduled job. Requires `@phyxiusjs/scheduler`.
   */
  schedule<TInput, TOutput>(job: AppScheduledJob<TInput, TOutput>): void;

  /**
   * Register a queue consumer. Requires `@phyxiusjs/queue`. The caller
   * supplies the `MessageSource` (SQS, Redis, memory-for-tests, etc.);
   * the framework owns the consumer lifecycle.
   */
  consume<TInput, TOutput>(consumer: AppConsumer<TInput, TOutput>): void;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Bring the app up. Starts the drain, the stats tracker, then — if
   * registered — the HTTP server, the scheduler, and each consumer.
   * Resolves when all components are live and accepting work.
   */
  start(): Promise<void>;

  /**
   * Graceful teardown. Reverse order of `start`:
   *   1. HTTP stops accepting new connections (in-flight continues)
   *   2. Scheduler stops firing new ticks
   *   3. Consumers stop pulling new messages
   *   4. Handlers drain their in-flight work
   *   5. Drain flushes
   *   6. Stats unsubscribes
   *   7. Config watcher disposes
   *
   * Safe to call repeatedly.
   */
  stop(): Promise<void>;

  /**
   * Install SIGTERM and SIGINT handlers that invoke `app.stop()`. Opt-in
   * by design — globally swallowing signals is the kind of magic that
   * bites people later. Call this once from your entry point if you want
   * auto-shutdown; otherwise wire signal handlers yourself.
   */
  installSignalHandlers(): void;

  // ── Escape hatches (everything reachable from above) ────────────────────

  readonly clock: Clock;
  readonly journal: Journal<HandlerEvent>;
  readonly config: ConfigInstance<FrameworkConfig & TAppConfig>;
  readonly stats: Stats;
  readonly status: AppStatus;
}

export type AppStatus = "idle" | "starting" | "running" | "stopping" | "stopped";

// ── Transport registration shapes ─────────────────────────────────────────

/**
 * Route shape accepted by `app.route`. Intentionally narrower than
 * `HttpRoute` from `@phyxiusjs/http` — the framework typing avoids
 * leaking a dependency on the HTTP package from public type positions.
 */
export interface AppRoute<TInput, TOutput> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  readonly path: string;
  readonly handler: RunningHandler<TInput, TOutput>;
  readonly decode: (req: AppHttpRequest) => TInput;
  readonly encode?: (result: AppHandlerResult<TOutput>, req: AppHttpRequest) => AppHttpResponse;
}

/**
 * Mirror of `HttpRequest` from `@phyxiusjs/http` — declared locally so the
 * framework's public types don't reference the HTTP package. Structurally
 * compatible; a route's `decode` can treat either as the other.
 */
export interface AppHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface AppHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** Structural mirror of `Result<T, HandlerError>` — avoids the import. */
export type AppHandlerResult<TOutput> =
  | { readonly _tag: "Ok"; readonly value: TOutput }
  | { readonly _tag: "Err"; readonly error: unknown };

export interface AppScheduledJob<TInput, TOutput> {
  readonly name: string;
  readonly schedule: AppSchedule;
  readonly handler: RunningHandler<TInput, TOutput>;
  readonly input: (tick: AppScheduledTick) => TInput | Promise<TInput>;
  readonly overlap?: "skip" | "queue" | "parallel";
  readonly catchup?: "none" | "last" | "all";
}

export interface AppSchedule {
  nextTick(after: { wallMs: number; monoMs: number }): { wallMs: number; monoMs: number } | null;
}

export interface AppScheduledTick {
  readonly scheduledAt: { wallMs: number; monoMs: number };
  readonly firedAt: { wallMs: number; monoMs: number };
  readonly tickIndex: number;
}

export interface AppConsumer<TInput, TOutput> {
  readonly source: AppMessageSource;
  readonly handler: RunningHandler<TInput, TOutput>;
  readonly decode: (message: AppQueueMessage) => TInput;
  readonly maxConcurrent?: number;
}

/** Structural mirror of `MessageSource` from `@phyxiusjs/queue`. */
export interface AppMessageSource {
  receive(signal?: AbortSignal): Promise<AppQueueMessage | null>;
  ack(message: AppQueueMessage): Promise<void>;
  nack(message: AppQueueMessage, reason: unknown): Promise<void>;
  close?(): Promise<void>;
}

export interface AppQueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly receivedAt: { wallMs: number; monoMs: number };
  readonly deliveryCount?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

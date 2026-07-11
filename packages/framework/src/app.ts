import { createSystemClock, type Clock } from "@phyxiusjs/clock";
import { createConfig, type ConfigError, type ConfigEvent, type ConfigInstance } from "@phyxiusjs/config";
import { createDrain, stdoutSink, type Drain } from "@phyxiusjs/drain";
import { spawn, type HandlerEvent, type HandlerSpec, type RunningHandler } from "@phyxiusjs/handler";
import { Journal } from "@phyxiusjs/journal";
import { createStats, type StatsEvent } from "@phyxiusjs/stats";
import { z } from "zod";

import { frameworkConfigSchema, type FrameworkConfig } from "./config-schema.js";
import { shouldLog } from "./sampling.js";
import type { App, AppConsumer, AppRoute, AppScheduledJob, AppStatus, CreateAppOptions } from "./types.js";

// ── Public: createApp ─────────────────────────────────────────────────────

/**
 * Build an app. The returned value wires together Clock, Journal, Drain,
 * Stats, and the Config watcher — and exposes methods to register handlers
 * and transport registrations on top. Transport adapters are loaded
 * lazily (on first call to `.route` / `.schedule` / `.consume`) so apps
 * that don't use a transport don't pay for it.
 *
 * The invariant: every method here is a documented composition of
 * primitives. If the behavior feels surprising, read the source — it
 * reads as "here's how you'd have written it by hand."
 */
export async function createApp<TAppConfig extends Record<string, unknown> = Record<string, never>>(
  options: CreateAppOptions<TAppConfig> = {},
): Promise<App<TAppConfig>> {
  const clock = options.clock ?? createSystemClock();
  const journal = options.journal ?? new Journal<HandlerEvent>({ clock, maxEntries: 10_000 });

  // ── Config ────────────────────────────────────────────────────────────

  const config = await resolveConfig<TAppConfig>(options, clock);

  // Boot fails closed. A config the caller asked for — a file path, an
  // inline object, or a pre-built ConfigInstance — that didn't validate
  // must never be silently replaced by schema defaults; that's the
  // founding invariant this framework exists to hold. The one path that's
  // exempt is "no config supplied at all", which resolves to `{}` merged
  // with `{ type: "defaults" }` — always valid, since every framework
  // field has a default (see frameworkConfigSchema).
  const bootedConfig = config.getAll();
  if (bootedConfig._tag === "Err") {
    config.dispose();
    throw new Error(describeBootFailure(options.config, bootedConfig.error));
  }

  // Config errors after boot are observable like every other framework
  // event: CONFIG_ERROR / CONFIG_RELOADED map into the shared journal.
  // CONFIG_LOADED / WATCH_STARTED / WATCH_STOPPED are deliberately not
  // forwarded — `subscribe` replays the most recent event immediately, and
  // the most recent event at this point is always CONFIG_LOADED (boot just
  // succeeded), which would otherwise land a synthetic entry before the
  // app has done anything.
  config.subscribe((event) => {
    if (event.type !== "CONFIG_ERROR" && event.type !== "CONFIG_RELOADED") return;
    journal.append(configEventToHandlerEvent(event));
  });

  // Last-known-good cache. A failed hot-reload leaves `lastError` set on
  // the config instance — by design, `getAll()` refuses to hand back a
  // read once the most recent load failed — but the previously-validated
  // data underneath is untouched. This mirrors that decision at the
  // framework layer: every place *this* file reads config keeps running on
  // the last value that validated, instead of falling back to
  // `frameworkConfigSchema.parse({})`.
  let lastGoodConfig: FrameworkConfig & TAppConfig = bootedConfig.value;

  function currentConfig(): FrameworkConfig & TAppConfig {
    const snap = config.getAll();
    if (snap._tag === "Ok") lastGoodConfig = snap.value;
    return lastGoodConfig;
  }

  function readObservability(): FrameworkConfig["observability"] {
    return currentConfig().observability;
  }

  function readServer(): FrameworkConfig["server"] {
    return currentConfig().server;
  }

  // ── Drain + sampling ──────────────────────────────────────────────────

  // The drain lives regardless of `log_drain: "none"` — stats still needs
  // something to subscribe to; this drain just goes nowhere in that case.
  let drain: Drain | null = null;

  function buildDrain(): Drain {
    const mode = readObservability().log_drain;

    if (mode === "none") {
      return createDrain<HandlerEvent>({
        journal,
        sink: { async write() {} },
        clock,
      });
    }

    return createDrain<HandlerEvent>({
      journal,
      sink: stdoutSink<HandlerEvent>(),
      clock,
      // Sampling policy, evaluated per entry against the *current* config.
      // The drain re-reads config on every event, so a config hot-reload
      // takes effect on the next entry — no app restart, no deploy.
      filter: (entry) => {
        const snap = config.getAll();
        if (snap._tag !== "Ok") return true; // if config read fails, err on the side of logging
        return shouldLog(entry.data, snap.value.observability);
      },
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  const statsConfig = readObservability().stats;
  const stats = createStats({
    journal,
    clock,
    windowSize: statsConfig.window_size,
    thresholds: toHandlerThresholds(statsConfig.thresholds),
    emit: (event) => {
      // Route threshold events back into the journal so they share the
      // same observability stream as everything else.
      //
      // Two things make this subtle:
      //
      //  1. Shape. The journal is `Journal<HandlerEvent>`; a StatsEvent is a
      //     structurally distinct value. Map it explicitly into a
      //     HandlerEvent so the entry carries the fields downstream readers
      //     rely on (`outcome` and `invocationId` for sampling, `source` for
      //     filtering) instead of an opaque cast through `unknown`.
      //
      //  2. Reentrancy. Stats subscribes to this same journal, so `emit`
      //     fires from *inside* the journal's subscriber dispatch. Appending
      //     synchronously here would re-enter `Journal.append` while it's
      //     still notifying subscribers — which throws JournalReentrancyError,
      //     and that throw is swallowed by the subscriber try/catch, so the
      //     alert would vanish silently. Defer the append to a microtask so
      //     it lands after dispatch has unwound.
      const entry = statsEventToHandlerEvent(event);
      queueMicrotask(() => {
        journal.append(entry);
      });
    },
  });

  // ── Registration state ────────────────────────────────────────────────

  const handlers: RunningHandler<unknown, unknown>[] = [];
  const routes: AppRoute<unknown, unknown>[] = [];
  const jobs: AppScheduledJob<unknown, unknown>[] = [];
  const consumers: AppConsumer<unknown, unknown>[] = [];

  // Transport instances. Lazily constructed on `start()` if any
  // registration for that transport exists.
  let httpServer: { close: (cb: (err?: Error) => void) => void } | null = null;
  let scheduler: { start(): Promise<void>; stop(): Promise<void> } | null = null;
  const runningConsumers: Array<{ start(): Promise<void>; stop(): Promise<void> }> = [];

  // Installed signal listeners, so we can remove them on stop if installed.
  const installedSignals: Array<{ signal: NodeJS.Signals; listener: () => void }> = [];

  let status: AppStatus = "idle";

  // ── Method: use ───────────────────────────────────────────────────────

  async function use<TInput, TOutput>(
    spec: HandlerSpec<TInput, TOutput, unknown>,
  ): Promise<RunningHandler<TInput, TOutput>> {
    const handler = await spawn(spec, {
      clock,
      journal,
      // Each invocation re-reads the flag from config, so flipping
      // `observability.observe.include_extra` in phyxius.yaml hot-reloads
      // on the next handler event — no restart needed.
      includeExtra: () => readObservability().observe.include_extra,
    });
    handlers.push(handler as RunningHandler<unknown, unknown>);
    return handler;
  }

  // ── Method: route ─────────────────────────────────────────────────────

  function route<TInput, TOutput>(r: AppRoute<TInput, TOutput>): void {
    if (status !== "idle") {
      throw new Error("app.route() must be called before app.start()");
    }
    routes.push(r as AppRoute<unknown, unknown>);
  }

  // ── Method: schedule ──────────────────────────────────────────────────

  function schedule<TInput, TOutput>(job: AppScheduledJob<TInput, TOutput>): void {
    if (status !== "idle") {
      throw new Error("app.schedule() must be called before app.start()");
    }
    jobs.push(job as AppScheduledJob<unknown, unknown>);
  }

  // ── Method: consume ───────────────────────────────────────────────────

  function consume<TInput, TOutput>(c: AppConsumer<TInput, TOutput>): void {
    if (status !== "idle") {
      throw new Error("app.consume() must be called before app.start()");
    }
    consumers.push(c as AppConsumer<unknown, unknown>);
  }

  // ── Method: start ─────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (status === "running" || status === "starting") return;
    if (status === "stopping" || status === "stopped") {
      throw new Error("app.start() cannot be called after app.stop()");
    }

    status = "starting";

    // 1. Drain comes up first — handler events registered during spawn()
    //    need a subscriber in place.
    drain = buildDrain();

    // 2. HTTP server, if any routes registered.
    if (routes.length > 0) {
      const { createHttpAdapter } = await loadPeer("@phyxiusjs/http");
      const adapter = createHttpAdapter({
        routes: routes as ReadonlyArray<unknown> as Parameters<typeof createHttpAdapter>[0]["routes"],
      });

      // `readServer()` never fails silently on a load error — boot already
      // rejected an unusable config, and a later reload failure keeps the
      // last-known-good value. `undefined` here can only mean the resolved
      // config genuinely has no `server` section.
      const serverPort = readServer()?.port;
      if (serverPort === undefined) {
        throw new Error(
          "routes registered but server.port is missing from config. Either add `server.port` to your config or don't call app.route(...).",
        );
      }

      const { createServer } = await import("node:http");
      const server = createServer(adapter.listener);
      await new Promise<void>((resolve) => server.listen(serverPort, resolve));
      httpServer = server;
    }

    // 3. Scheduler, if any jobs registered.
    if (jobs.length > 0) {
      const { createScheduler } = await loadPeer("@phyxiusjs/scheduler");
      const s = createScheduler({
        clock,
        jobs: jobs as ReadonlyArray<unknown> as Parameters<typeof createScheduler>[0]["jobs"],
      });
      await s.start();
      scheduler = s as unknown as { start(): Promise<void>; stop(): Promise<void> };
    }

    // 4. Queue consumers, if any registered.
    if (consumers.length > 0) {
      const { createQueueConsumer } = await loadPeer("@phyxiusjs/queue");
      for (const c of consumers) {
        const consumer = createQueueConsumer({
          clock,
          source: c.source as never,
          handler: c.handler as never,
          decode: c.decode as never,
          ...(c.maxConcurrent !== undefined ? { maxConcurrent: c.maxConcurrent } : {}),
        });
        await consumer.start();
        runningConsumers.push(consumer as unknown as { start(): Promise<void>; stop(): Promise<void> });
      }
    }

    status = "running";
  }

  // ── Method: stop ──────────────────────────────────────────────────────

  async function stop(): Promise<void> {
    if (status === "stopping") return;

    // Signal listener cleanup is orthogonal to the lifecycle: if they were
    // installed, they should be removable even when the app never ran.
    // Do this up front so the early-return paths don't skip it.
    uninstallSignalHandlers();

    if (status === "stopped" || status === "idle") {
      status = "stopped";
      return;
    }

    status = "stopping";

    // 1. Stop accepting new HTTP connections. In-flight requests continue.
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }

    // 2. Stop scheduler (drains in-flight ticks).
    if (scheduler) {
      await scheduler.stop().catch(() => {});
      scheduler = null;
    }

    // 3. Stop consumers (drains in-flight messages).
    for (const c of runningConsumers) {
      await c.stop().catch(() => {});
    }
    runningConsumers.length = 0;

    // 4. Stop handlers (drains their own internal queues).
    await Promise.allSettled(handlers.map((h) => h.stop()));
    handlers.length = 0;

    // 5. Flush + stop drain.
    if (drain) {
      await drain.stop().catch(() => {});
      drain = null;
    }

    // 6. Stats unsubscribes.
    stats.stop();

    // 7. Config watcher disposes.
    try {
      config.dispose();
    } catch {
      // ignore
    }

    status = "stopped";
  }

  function uninstallSignalHandlers(): void {
    for (const { signal, listener } of installedSignals) {
      process.removeListener(signal, listener);
    }
    installedSignals.length = 0;
  }

  // ── Method: installSignalHandlers ────────────────────────────────────

  function installSignalHandlers(): void {
    const handler = () => {
      void stop();
    };
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
    installedSignals.push({ signal: "SIGTERM", listener: handler });
    installedSignals.push({ signal: "SIGINT", listener: handler });
  }

  // ── Assemble the app value ────────────────────────────────────────────

  return {
    use,
    route,
    schedule,
    consume,
    start,
    stop,
    installSignalHandlers,
    clock,
    journal,
    config,
    stats,
    get status() {
      return status;
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

async function resolveConfig<TAppConfig extends Record<string, unknown>>(
  options: CreateAppOptions<TAppConfig>,
  clock: Clock,
): Promise<ConfigInstance<FrameworkConfig & TAppConfig>> {
  const schema = options.appSchema
    ? frameworkConfigSchema.and(options.appSchema as z.ZodType<TAppConfig>)
    : (frameworkConfigSchema as unknown as z.ZodType<FrameworkConfig & TAppConfig>);

  // Already-built ConfigInstance: use it as-is.
  if (options.config && typeof options.config === "object" && "get" in options.config) {
    return options.config as ConfigInstance<FrameworkConfig & TAppConfig>;
  }

  // File path: load via file source, hot-reloading enabled.
  if (typeof options.config === "string") {
    return createConfig<FrameworkConfig & TAppConfig>(schema as z.ZodType<FrameworkConfig & TAppConfig>, {
      sources: [{ type: "file", path: options.config }, { type: "defaults" }],
      clock,
      watch: true,
    });
  }

  // Inline object (or undefined).
  return createConfig<FrameworkConfig & TAppConfig>(schema as z.ZodType<FrameworkConfig & TAppConfig>, {
    sources: [{ type: "object", data: (options.config as object) ?? {} }, { type: "defaults" }],
    clock,
  });
}

/**
 * Describe why `createApp` is refusing to boot. Includes the source the
 * caller pointed us at (so a bad file path is visible without re-deriving
 * it from the ConfigError) and the underlying ConfigError's own type and
 * message (the real load/parse reason) — never a generic "config invalid".
 */
function describeBootFailure(requestedConfig: unknown, error: ConfigError): string {
  const source = describeConfigSource(requestedConfig);
  return `createApp: config failed to load from ${source} — ${error.type}: ${configErrorMessage(error)}. Refusing to boot on schema defaults.`;
}

function describeConfigSource(requestedConfig: unknown): string {
  if (typeof requestedConfig === "string") return `file "${requestedConfig}"`;
  const isConfigInstance = requestedConfig !== null && typeof requestedConfig === "object" && "get" in requestedConfig;
  return isConfigInstance ? "the supplied ConfigInstance" : "the inline config object";
}

function configErrorMessage(error: ConfigError): string {
  switch (error.type) {
    case "FILE_NOT_FOUND":
      return `file not found: ${error.path}`;
    case "PATH_NOT_FOUND":
      return `path not found: ${error.path}`;
    case "SOURCE_ERROR":
      return `${error.source}: ${error.message}`;
    case "PARSE_ERROR":
    case "VALIDATION_ERROR":
      return error.message;
  }
}

/**
 * Map a post-boot CONFIG_ERROR / CONFIG_RELOADED event into the HandlerEvent
 * shape the journal carries — the same move `statsEventToHandlerEvent` makes
 * for stats alerts, so config problems show up in the same observability
 * stream instead of being emitted to a journal nobody subscribed to.
 */
function configEventToHandlerEvent(
  event: Extract<ConfigEvent, { type: "CONFIG_ERROR" | "CONFIG_RELOADED" }>,
): HandlerEvent {
  return {
    name: event.type,
    invocationId: `config:${event.type}:${event.at.wallMs}`,
    source: "config",
    startedAt: event.at,
    completedAt: event.at,
    durationMs: 0,
    attempts: 0,
    outcome: event.type === "CONFIG_ERROR" ? "failure" : "success",
    observed: event.type === "CONFIG_ERROR" ? { error: event.error } : { changes: event.changes },
  };
}

/**
 * Map a StatsEvent into the HandlerEvent shape the journal carries. The
 * journal is `Journal<HandlerEvent>`, and a threshold alert is not a handler
 * invocation — so we synthesize a HandlerEvent whose `name` identifies the
 * alert type, whose `observed` payload carries the breach detail, and whose
 * `outcome` is `failure` for a breach (so default sampling always logs it)
 * and `success` for a recovery. The `name` is the event type, not the
 * breaching handler's name, so re-ingesting this entry doesn't pollute that
 * handler's ring buffer or risk a recursive alert.
 */
function statsEventToHandlerEvent(event: StatsEvent): HandlerEvent {
  return {
    name: event.type,
    invocationId: `${event.handler}:${event.field}:${event.at.wallMs}`,
    source: "stats",
    startedAt: event.at,
    completedAt: event.at,
    durationMs: 0,
    attempts: 0,
    outcome: event.type === "stats:threshold-breached" ? "failure" : "success",
    observed: {
      handler: event.handler,
      field: event.field,
      value: event.value,
      limit: event.limit,
    },
  };
}

function toHandlerThresholds(
  raw: FrameworkConfig["observability"]["stats"]["thresholds"],
): Record<string, { p50Ms?: number; p95Ms?: number; p99Ms?: number; errorRate?: number }> {
  const out: Record<string, { p50Ms?: number; p95Ms?: number; p99Ms?: number; errorRate?: number }> = {};
  for (const [name, t] of Object.entries(raw)) {
    out[name] = {
      ...(t.p50_ms !== undefined ? { p50Ms: t.p50_ms } : {}),
      ...(t.p95_ms !== undefined ? { p95Ms: t.p95_ms } : {}),
      ...(t.p99_ms !== undefined ? { p99Ms: t.p99_ms } : {}),
      ...(t.error_rate !== undefined ? { errorRate: t.error_rate } : {}),
    };
  }
  return out;
}

/**
 * Dynamic import of an optional peer package. Gives a clear, actionable
 * error if the caller tried to use a transport without installing its
 * adapter.
 */
async function loadPeer(name: "@phyxiusjs/http"): Promise<typeof import("@phyxiusjs/http")>;
async function loadPeer(name: "@phyxiusjs/queue"): Promise<typeof import("@phyxiusjs/queue")>;
async function loadPeer(name: "@phyxiusjs/scheduler"): Promise<typeof import("@phyxiusjs/scheduler")>;
async function loadPeer(name: string): Promise<unknown> {
  try {
    return await import(name);
  } catch {
    throw new Error(
      `${name} is an optional peer dependency. Install it: \`npm install ${name}\` (or the equivalent with your package manager).`,
    );
  }
}

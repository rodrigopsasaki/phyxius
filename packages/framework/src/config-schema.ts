import { z } from "zod";

// ── Framework config slice ────────────────────────────────────────────────

/**
 * The slice of configuration the framework itself reads. Users extend this
 * with their own schema via intersection — Phyxius owns `server` and
 * `observability`; the user owns everything else in their `phyxius.yaml`.
 *
 * Every field has a sensible default so that a config file with just
 * `server: { port: 3000 }` is enough to get a working app.
 */
export const frameworkConfigSchema = z.object({
  /**
   * HTTP server configuration. Only read if any `app.route(...)` was
   * registered; pure handler / scheduler / consumer apps can omit this
   * entirely.
   */
  server: z
    .object({
      port: z.number().int().positive(),
      /**
       * Header names to inspect for an inbound correlation ID. Defaults
       * are `x-correlation-id`, `x-request-id`. Override to match your
       * gateway's convention.
       */
      correlation_id_headers: z.array(z.string()).optional(),
    })
    .optional(),

  /**
   * Observability configuration. Wires the drain, the sampling policy,
   * and the stats thresholds. All defaults favor "log everything, alert
   * on nothing" — a new app starts loud and gets tuned down.
   */
  observability: z
    .object({
      /**
       * Where log events go. `none` disables log output entirely (stats
       * still run in-memory). Additional sinks (file, otlp) are
       * deliberately kept to a small set — compose custom sinks by not
       * using the framework layer for them.
       */
      log_drain: z.enum(["stdout", "none"]).default("stdout"),

      /**
       * Deterministic log sampling. Every event's sampling decision is
       * a pure function of the event + this config; change the knob and
       * the next event's destiny changes with no deploy.
       */
      log_sampling: z
        .object({
          /**
           * Fraction of successful invocations to log. 1.0 = log all,
           * 0.0 = log none. Sampling is deterministic by `invocationId`
           * so every process in the fleet makes the same call on a
           * given request.
           */
          ratio_of_successful_requests: z.number().min(0).max(1).default(1.0),

          /** Failures are always logged unless you explicitly opt out. */
          log_all_failures: z.boolean().default(true),
        })
        .default({}),

      /**
       * Stats window + per-handler alert thresholds. Handlers without
       * an entry are observed but never alert. Stats run regardless of
       * whether thresholds are set — you can always query
       * `app.stats.snapshot(name)` for the current picture.
       */
      stats: z
        .object({
          window_size: z.number().int().positive().default(1000),

          /**
           * Per-handler thresholds. Keyed by handler name. Any field you
           * omit (p50_ms, p95_ms, p99_ms, error_rate) is not checked.
           */
          thresholds: z
            .record(
              z.string(),
              z.object({
                p50_ms: z.number().optional(),
                p95_ms: z.number().optional(),
                p99_ms: z.number().optional(),
                error_rate: z.number().min(0).max(1).optional(),
              }),
            )
            .default({}),
        })
        .default({}),

      /**
       * Observe-field tier control. Handlers declare observation fields
       * in two tiers: `core` (always shipped) and `extra` (debug
       * breadcrumbs). In production, you almost always want only core
       * fields going out — that's the cost-safe default. During an
       * incident, flip `include_extra` to `true`, hot-reload the config,
       * and the very next journal entry carries the extras. Flip back
       * when you're done.
       */
      observe: z
        .object({
          include_extra: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
});

export type FrameworkConfig = z.infer<typeof frameworkConfigSchema>;

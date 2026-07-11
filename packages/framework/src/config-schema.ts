import { z, type RefinementCtx } from "zod";

import { findTypoOfReservedKey } from "./typo-adjacency.js";

// ── Framework config slice ────────────────────────────────────────────────

/**
 * The slice of configuration the framework itself reads. Users extend this
 * with their own schema via intersection — Phyxius owns `server` and
 * `observability`; the user owns everything else in their `phyxius.yaml`.
 *
 * Every field has a sensible default so that a config file with just
 * `server: { port: 3000 }` is enough to get a working app.
 *
 * Strictness boundary: `server` and `observability` are closed worlds —
 * every object at every nesting level inside them is `.strict()`, so an
 * unrecognized key anywhere in there (`observabilty:` inside `server`,
 * a misspelled field inside `log_sampling`, an extra key on a per-handler
 * threshold) is a hard parse error naming the key and its path, not a
 * silent strip-and-default. Absent keys are unaffected — every field here
 * still has a default, and `.strict()` only rejects keys that are actually
 * *present* and unrecognized. #19 already makes a parse error fatal at
 * boot and, post-boot, journals `CONFIG_ERROR` while keeping last-known-good
 * — this schema is the only thing that changed; that machinery is reused
 * as-is (see app.ts).
 *
 * Everywhere else at the top level stays OPEN: apps put their own keys
 * beside the reserved ones (see the README's `features` example) and
 * `appSchema` intersects a user schema over this one, so an unrecognized
 * top-level key is, by design, an app key — not an error. The one narrow
 * exception is `rejectTypoAdjacentTopLevelKeys` below: a top-level key
 * whose lowercase form is within edit distance 1 of `server` or
 * `observability` is rejected with a "did you mean" error instead of
 * silently riding along as inert app config while the real slice defaults
 * underneath it.
 */
const frameworkConfigObjectSchema = z.object({
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
    .strict()
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
        .strict()
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
              z
                .object({
                  p50_ms: z.number().optional(),
                  p95_ms: z.number().optional(),
                  p99_ms: z.number().optional(),
                  error_rate: z.number().min(0).max(1).optional(),
                })
                .strict(),
            )
            .default({}),
        })
        .strict()
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
        .strict()
        .default({}),
    })
    .strict()
    .default({}),
});

// Single source of truth for "what's a reserved slice name" — derived from
// the schema's own shape so `rejectTypoAdjacentTopLevelKeys` can't drift
// from it if a slice is ever added or renamed.
const RESERVED_SLICE_NAMES = Object.keys(frameworkConfigObjectSchema.shape);

/**
 * Preprocess hook: reject a top-level config key that's a near-miss typo
 * of a reserved slice name, before the real schema even runs. The
 * strictness above only ever sees keys already routed to `server` /
 * `observability` — a key that's ALMOST "observability" never reaches it,
 * because the (deliberately open) top level treats it as an ordinary app
 * key and accepts it without complaint.
 */
function rejectTypoAdjacentTopLevelKeys(raw: unknown, ctx: RefinementCtx): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;

  let foundTypo = false;
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    const suspect = findTypoOfReservedKey(key, RESERVED_SLICE_NAMES);
    if (suspect === undefined) continue;

    foundTypo = true;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message:
        `Unrecognized top-level config key "${key}" — did you mean "${suspect}"? ` +
        `"${suspect}" is a framework-reserved slice; a near-miss spelling of it is ` +
        `rejected rather than silently accepted as your own app key.`,
    });
  }

  return foundTypo ? z.NEVER : raw;
}

export const frameworkConfigSchema = z.preprocess(rejectTypoAdjacentTopLevelKeys, frameworkConfigObjectSchema);

export type FrameworkConfig = z.infer<typeof frameworkConfigSchema>;

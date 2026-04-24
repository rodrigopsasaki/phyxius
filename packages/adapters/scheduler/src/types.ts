import type { Instant } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { HandlerError, RunningHandler } from "@phyxiusjs/handler";

// ── Schedule ──────────────────────────────────────────────────────────────

/**
 * A schedule is a pure "next-tick calculator." Given the current instant,
 * it answers: when should I fire next? Returning `null` means the schedule
 * is exhausted (a one-shot that already fired, or an explicit "done").
 *
 * Shape intentionally minimal. Any scheduling concept — fixed interval,
 * cron expression, specific instant, timezone-aware recurrence, business-
 * calendar-aware cadence — reduces to this one method. Library authors
 * wrap `cron-parser` / `rrule` / `date-fns` in 5 lines and plug it in.
 */
export interface Schedule {
  /**
   * The next instant at which this schedule should fire, strictly AFTER
   * the given instant. Returning `null` indicates no further ticks — the
   * scheduler will drop the job from rotation.
   */
  nextTick(after: Instant): Instant | null;
}

// ── Tick ──────────────────────────────────────────────────────────────────

/**
 * The payload handed to a job's `input` function each time it fires. Carries
 * both the scheduled time and the actually-fired time — the difference is
 * drift, a key signal for overloaded schedulers and clock skew.
 */
export interface ScheduledTick {
  /** When the schedule said the job should fire. */
  readonly scheduledAt: Instant;
  /** When the job actually fired. `firedAt - scheduledAt` = drift. */
  readonly firedAt: Instant;
  /** 0-indexed tick count for this job since the scheduler started. */
  readonly tickIndex: number;
}

// ── Job ───────────────────────────────────────────────────────────────────

/**
 * How to handle a tick that arrives while a previous tick of the same job
 * is still running:
 *
 *   - `skip`     — drop the new tick; emit `scheduler:skipped`. Default.
 *   - `queue`    — fire the new tick anyway and let the handler's internal
 *                  queue / backpressure policy decide. Fine for fast jobs,
 *                  dangerous for slow ones under overload (cascades).
 *   - `parallel` — fire the new tick immediately; handler's `concurrency.max`
 *                  is the ceiling. Only safe when ticks are independent.
 *
 * Default: `skip`. Use `queue` or `parallel` deliberately.
 */
export type OverlapPolicy = "skip" | "queue" | "parallel";

/**
 * How to handle ticks that should have fired while the scheduler wasn't
 * running (e.g. process was down, or the job was just added mid-flight):
 *
 *   - `none` — only schedule ticks strictly after `scheduler.start()`. Default.
 *   - `last` — fire one catchup tick for the most recent missed instant.
 *   - `all`  — fire every missed tick, in order.
 *
 * Default: `none`. Catchup semantics always surprise people; opt in explicitly.
 */
export type CatchupPolicy = "none" | "last" | "all";

/**
 * A scheduled job definition. Same shape intent as an HTTP route or a
 * queue consumer: the handler owns stability + observability; the job
 * tells the scheduler *when* to fire and *what* to feed in.
 */
export interface ScheduledJob<TInput, TOutput> {
  /** Identity — appears as `name` on every HandlerEvent this job emits. */
  readonly name: string;
  /** The schedule that determines tick times. */
  readonly schedule: Schedule;
  /** The handler each tick will invoke. */
  readonly handler: RunningHandler<TInput, TOutput>;
  /**
   * Produces the handler's input from a tick. Commonly used to pass the
   * scheduled time (`tick.scheduledAt`) as a "since" bound for incremental
   * jobs, or to supply a correlation-ID derived from the tick.
   */
  readonly input: (tick: ScheduledTick) => TInput | Promise<TInput>;
  /**
   * Optional side-effect hook fired after each tick's Result is produced.
   * Gets the Result + tick so callers can log, count, or route specific
   * failures outside the journal. Does NOT influence retry — that lives
   * on the handler.
   */
  readonly onResult?: (result: Result<TOutput, HandlerError>, tick: ScheduledTick) => void;
  /** How to treat a new tick when the previous tick is still running. Default: `skip`. */
  readonly overlap?: OverlapPolicy;
  /** How to treat ticks missed before the scheduler started. Default: `none`. */
  readonly catchup?: CatchupPolicy;
}

// ── Scheduler ─────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  readonly jobs: ReadonlyArray<ScheduledJob<unknown, unknown>>;
  /** Optional lifecycle event sink. Independent of the handler's journal. */
  readonly emit?: (event: SchedulerEvent) => void;
}

export type SchedulerStatus = "idle" | "running" | "stopping" | "stopped";

export interface Scheduler {
  /** Begin the scheduling loop. Resolves once scheduling is live. */
  start(): Promise<void>;
  /** Graceful stop — waits for in-flight ticks to complete. */
  stop(): Promise<void>;
  /** Current lifecycle state. */
  getStatus(): SchedulerStatus;
  /** How many ticks are currently in flight across all jobs. */
  getInFlight(): number;
}

// ── Events ────────────────────────────────────────────────────────────────

/**
 * Scheduler lifecycle / operational events. These are distinct from the
 * per-invocation `HandlerEvent`s (which flow through the handler's journal).
 * These carry the scheduler's own concerns: drift, skipped ticks, job-level
 * exhaustion.
 */
export type SchedulerEvent =
  | {
      readonly type: "scheduler:started";
      readonly at: Instant;
      readonly jobCount: number;
    }
  | {
      readonly type: "scheduler:stopped";
      readonly at: Instant;
      readonly inFlightAtStop: number;
    }
  | {
      readonly type: "scheduler:tick-fired";
      readonly name: string;
      readonly scheduledAt: Instant;
      readonly firedAt: Instant;
      readonly driftMs: number;
      readonly tickIndex: number;
    }
  | {
      readonly type: "scheduler:tick-skipped";
      readonly name: string;
      readonly scheduledAt: Instant;
      readonly reason: "overlap" | "scheduler-stopping";
    }
  | {
      readonly type: "scheduler:job-exhausted";
      readonly name: string;
      readonly at: Instant;
    };

import type { Clock, Instant } from "@phyxiusjs/clock";
import type { Result } from "@phyxiusjs/fp";
import type { HandlerError, RunningHandler } from "@phyxiusjs/handler";

import type {
  CatchupPolicy,
  OverlapPolicy,
  ScheduledJob,
  ScheduledTick,
  Scheduler,
  SchedulerOptions,
  SchedulerStatus,
} from "./types.js";

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * Build a scheduler. Every job is pulled once from its `schedule` to
 * determine its first tick; after each fire, the next tick is computed.
 * Jobs whose schedules return `null` are dropped from rotation.
 *
 * The scheduler is single-process / single-threaded — ticks from different
 * jobs interleave, but each scheduler instance owns its own clock + loop.
 * Scaling across nodes is a transport concern (persistent schedule state,
 * leader election, etc.) that explicitly lives outside this primitive.
 */
export function createScheduler(options: SchedulerOptions & { readonly clock: Clock }): Scheduler {
  const { jobs, clock, emit } = options;

  if (jobs.length === 0) {
    throw new Error("Scheduler requires at least one job.");
  }

  // Per-job runtime state. The "slot" array has the same index as `jobs`.
  const slots: JobSlot[] = jobs.map((job, i) => ({
    job,
    index: i,
    nextAt: null,
    tickIndex: 0,
    inFlight: new Set<Promise<void>>(),
    exhausted: false,
    catchupFollowup: undefined,
  }));

  let status: SchedulerStatus = "idle";
  let loop: Promise<void> | null = null;
  const abortController = new AbortController();

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (status !== "idle") return;
    status = "running";

    const startInstant = clock.now();
    emit?.({
      type: "scheduler:started",
      at: startInstant,
      jobCount: jobs.length,
    });

    // Seed each slot with its first scheduled tick, honoring catchup policy.
    for (const slot of slots) {
      seedNextTick(slot, startInstant);
    }

    loop = runLoop();
  }

  async function stop(): Promise<void> {
    if (status === "idle" || status === "stopped") {
      status = "stopped";
      return;
    }
    if (status === "stopping") {
      await loop;
      return;
    }

    status = "stopping";
    abortController.abort();
    await loop;

    // Wait for any in-flight ticks to settle before declaring stopped.
    const allInFlight = slots.flatMap((s) => [...s.inFlight]);
    const inFlightAtStop = allInFlight.length;
    await Promise.allSettled(allInFlight);

    status = "stopped";
    emit?.({
      type: "scheduler:stopped",
      at: clock.now(),
      inFlightAtStop,
    });
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  async function runLoop(): Promise<void> {
    while (status === "running") {
      // Find the earliest next-tick across all active slots.
      const next = pickNextSlot();
      if (!next) {
        // All jobs exhausted — nothing left to do.
        break;
      }

      // Sleep (via Clock, abort-aware) until the target instant.
      const { slot, at: targetAt } = next;
      const now = clock.now();
      const waitMs = Math.max(0, targetAt.wallMs - now.wallMs);

      if (waitMs > 0) {
        try {
          await sleepUntil(clock, targetAt, abortController.signal);
        } catch {
          // Aborted — loop exits via the status check.
        }
      }

      if (status !== "running") break;

      fire(slot, targetAt);
      // Compute next-tick AFTER firing so the same slot doesn't immediately
      // get picked again with the stale `nextAt`.
      advanceSlot(slot, clock.now());
    }
  }

  function pickNextSlot(): { slot: JobSlot; at: Instant } | null {
    let best: { slot: JobSlot; at: Instant } | null = null;
    for (const slot of slots) {
      if (slot.exhausted) continue;
      if (slot.nextAt === null) continue;
      if (!best || slot.nextAt.wallMs < best.at.wallMs) {
        best = { slot, at: slot.nextAt };
      }
    }
    return best;
  }

  // ── Per-tick flow ───────────────────────────────────────────────────────

  function fire(slot: JobSlot, scheduledAt: Instant): void {
    const firedAt = clock.now();
    const driftMs = Math.max(0, firedAt.wallMs - scheduledAt.wallMs);

    const overlap = slot.job.overlap ?? "skip";
    if (slot.inFlight.size > 0 && overlap === "skip") {
      emit?.({
        type: "scheduler:tick-skipped",
        name: slot.job.name,
        scheduledAt,
        reason: "overlap",
      });
      return;
    }

    if (status === "stopping") {
      emit?.({
        type: "scheduler:tick-skipped",
        name: slot.job.name,
        scheduledAt,
        reason: "scheduler-stopping",
      });
      return;
    }

    const tick: ScheduledTick = {
      scheduledAt,
      firedAt,
      tickIndex: slot.tickIndex++,
    };

    emit?.({
      type: "scheduler:tick-fired",
      name: slot.job.name,
      scheduledAt,
      firedAt,
      driftMs,
      tickIndex: tick.tickIndex,
    });

    const promise = dispatch(slot, tick).finally(() => {
      slot.inFlight.delete(promise);
    });
    slot.inFlight.add(promise);
  }

  async function dispatch(slot: JobSlot, tick: ScheduledTick): Promise<void> {
    let input: unknown;
    try {
      input = await slot.job.input(tick);
    } catch (cause) {
      // Input construction failed — treat as if the tick produced a
      // Handler-style failure. We synthesize a HANDLER_ERROR-shaped Result
      // rather than invoking, carrying the original `cause` through
      // unaltered. No journal entry from the handler because the handler
      // never ran, so `scheduler:input-error` is the only place the real
      // message/stack surfaces — emit it before onResult so operators
      // never lose the original failure.
      emit?.({
        type: "scheduler:input-error",
        name: slot.job.name,
        at: clock.now(),
        tickIndex: tick.tickIndex,
        cause,
      });
      const synthesized: Result<unknown, HandlerError> = {
        _tag: "Err",
        error: { type: "HANDLER_ERROR", cause },
      };
      slot.job.onResult?.(synthesized, tick);
      return;
    }

    const handler = slot.job.handler as RunningHandler<unknown, unknown>;
    const result = await handler.invoke(input, {
      source: "scheduler",
      correlationId: `${slot.job.name}:${tick.tickIndex}`,
      context: {
        scheduledAtWallMs: tick.scheduledAt.wallMs,
        firedAtWallMs: tick.firedAt.wallMs,
        driftMs: Math.max(0, tick.firedAt.wallMs - tick.scheduledAt.wallMs),
        tickIndex: tick.tickIndex,
      },
    });

    slot.job.onResult?.(result, tick);
  }

  // ── Slot seeding / advancement ──────────────────────────────────────────

  function seedNextTick(slot: JobSlot, startInstant: Instant): void {
    const catchup: CatchupPolicy = slot.job.catchup ?? "none";

    if (catchup === "none") {
      const first = slot.job.schedule.nextTick(startInstant);
      if (first === null) {
        slot.exhausted = true;
        emit?.({
          type: "scheduler:job-exhausted",
          name: slot.job.name,
          at: startInstant,
        });
        return;
      }
      slot.nextAt = first;
      return;
    }

    // catchup === "last" | "all" — rewind the schedule to find missed ticks.
    // We can't actually call `nextTick(past)` because schedules only return
    // "after a given instant." Instead, we treat startInstant itself as the
    // pivot and let the schedule produce the first instant AFTER it; missed
    // ticks can only be modeled by walking backwards, which the Schedule
    // interface deliberately does not support (schedules are forward-only).
    //
    // For "last", if the schedule would have fired just before startInstant,
    // we want to fire once. We approximate: fire the first forward-tick
    // immediately at startInstant, then resume from there.
    //
    // For "all", same as "last" at the primitive level — we can't enumerate
    // unseen past ticks without a bidirectional schedule. Document this.
    const first = slot.job.schedule.nextTick(startInstant);
    slot.nextAt = startInstant; // fire "now" as the catchup tick
    slot.catchupFollowup = first; // then resume
  }

  function advanceSlot(slot: JobSlot, now: Instant): void {
    // If we just fired a catchup tick, resume from the pre-computed followup.
    if (slot.catchupFollowup !== undefined) {
      slot.nextAt = slot.catchupFollowup;
      slot.catchupFollowup = undefined;
      if (slot.nextAt === null) {
        slot.exhausted = true;
        emit?.({
          type: "scheduler:job-exhausted",
          name: slot.job.name,
          at: now,
        });
      }
      return;
    }

    const next = slot.job.schedule.nextTick(now);
    if (next === null) {
      slot.exhausted = true;
      slot.nextAt = null;
      emit?.({
        type: "scheduler:job-exhausted",
        name: slot.job.name,
        at: now,
      });
      return;
    }
    slot.nextAt = next;
  }

  // ── Handle ──────────────────────────────────────────────────────────────

  return {
    start,
    stop,
    getStatus: () => status,
    getInFlight: () => slots.reduce((n, s) => n + s.inFlight.size, 0),
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

interface JobSlot {
  readonly job: ScheduledJob<unknown, unknown>;
  readonly index: number;
  nextAt: Instant | null;
  tickIndex: number;
  readonly inFlight: Set<Promise<void>>;
  exhausted: boolean;
  /**
   * If the current `nextAt` is a catchup marker ("fire now"), this holds
   * the real next-tick to adopt after firing. Cleared once consumed.
   */
  catchupFollowup: Instant | null | undefined;
}

/**
 * Sleep on the clock until the target instant, or resolve early when the
 * signal aborts. Uses `clock.deadline` (not `sleepOrAbort`) so a controlled
 * clock can advance the test deterministically and so the deadline's own
 * drift telemetry keeps firing — this races a wall-clock *deadline*, not a
 * relative delay, which is exactly the case `sleepOrAbort`'s doc comment
 * carves out as staying separate.
 *
 * `signal` is the scheduler's own long-lived stop signal, reused across
 * every tick for the life of the scheduler — not a fresh, tick-scoped
 * signal. So the loser of the race must clean up after itself: when the
 * deadline wins (every non-aborted tick), the abort listener is removed
 * explicitly, since `{ once: true }` only retires it when abort actually
 * fires. Same discipline as `sleepOrAbort` and `raceAttempt`.
 */
// Exported (but not re-exported from index.ts) so tests can exercise the
// abort-listener cleanup directly, the same way scheduler.test.ts already
// imports `createScheduler` from this file rather than the package root.
export function sleepUntil(clock: Clock, target: Instant, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    void clock.deadline(target).then(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

// Prevent unused-import noise when parallelism features are re-exported
// later; the types file owns the externally-visible surface.
export type { OverlapPolicy, CatchupPolicy };

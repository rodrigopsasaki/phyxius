import type { Budget, Clock, EmitFn, Instant, TimerHandle, Millis, MonoMs, DeadlineTarget } from "./types.js";
import { deadlineFrom, elapsedSince } from "./mono.js";

type PendingTimeout = {
  kind: "timeout";
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
};

type PendingInterval = {
  kind: "interval";
  every: Millis;
  nextMono: number;
  fn: () => void | Promise<void>;
  cancelled: boolean;
  tickCount: number;
};

type PendingTimer = PendingTimeout | PendingInterval;

interface QueuedTimer {
  fireAt: number;
  timer: PendingTimer;
}

/**
 * Controlled clock for deterministic testing
 */
class ControlledClock implements Clock {
  private wallMs: number;
  private monoMs: number;
  private readonly emit: EmitFn | undefined;
  private readonly timers: PendingTimer[] = [];

  constructor(options?: { initialTime?: number; emit?: EmitFn }) {
    // Default to 0 for deterministic tests
    this.wallMs = options?.initialTime ?? 0;
    this.monoMs = options?.initialTime ?? 0;
    this.emit = options?.emit;
  }

  now(): Instant {
    // THE brand-construction site for ControlledClock. `this.monoMs` is a
    // private simulated-time counter — plain `number` throughout the rest
    // of this class, advanced by `advanceBy`/`advanceTo` and the timer
    // engine below, all of which stay internal and never claim to BE a
    // `MonoMs` until they're handed out here. Stamping happens at the same
    // seam SystemClock stamps `performance.now()`: the moment a reading
    // crosses from "this clock's own bookkeeping" to "a value the rest of
    // the program can hold."
    return { wallMs: this.wallMs, monoMs: this.monoMs as MonoMs };
  }

  async sleep(ms: Millis): Promise<void> {
    if (ms <= 0) return;

    const startTime = this.now();
    this.emit?.({
      type: "time:sleep:start",
      durationMs: ms,
      at: startTime,
    });

    return new Promise<void>((resolve) => {
      const timer: PendingTimeout = {
        kind: "timeout",
        fireAt: this.monoMs + ms,
        fn: () => {
          const endTime = this.now();
          this.emit?.({
            type: "time:sleep:end",
            durationMs: ms,
            actualMs: ms,
            at: endTime,
          });
          resolve();
        },
        cancelled: false,
      };
      this.timers.push(timer);
    });
  }

  timeout(ms: Millis): Budget {
    const start = this.now();
    const deadline: Instant = {
      wallMs: start.wallMs + ms,
      monoMs: deadlineFrom(start.monoMs, ms),
    };
    const controller = new AbortController();

    this.emit?.({
      type: "time:timeout:start",
      durationMs: ms,
      deadline,
      at: start,
    });

    const timer: PendingTimeout = {
      kind: "timeout",
      // Reuse the already-computed deadline rather than re-deriving it —
      // `start.monoMs` (this.monoMs, read a line above) hasn't moved, so
      // this is the same instant `deadline.monoMs` names; recomputing it
      // via a second `this.monoMs + ms` would just risk the two drifting
      // apart if a future edit touches one and not the other.
      fireAt: deadline.monoMs,
      fn: () => {
        controller.abort();
        this.emit?.({
          type: "time:timeout:expire",
          deadline,
          at: this.now(),
        });
      },
      cancelled: false,
    };
    this.timers.push(timer);

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- captured for use in returned method closures
    const clock = this;
    return {
      deadline,
      signal: controller.signal,
      remaining(): Millis {
        return elapsedSince(deadline.monoMs, clock.now().monoMs);
      },
      expired(): boolean {
        return controller.signal.aborted;
      },
      release(): void {
        timer.cancelled = true;
        clock.emit?.({
          type: "time:timeout:release",
          deadline,
          at: clock.now(),
        });
      },
    };
  }

  async deadline(target: DeadlineTarget): Promise<void> {
    const now = this.now();
    const delayMs = Math.max(0, target.wallMs - now.wallMs);

    this.emit?.({
      type: "time:deadline:start",
      targetMs: target.wallMs,
      delayMs,
      at: now,
    });

    if (delayMs > 0) {
      await this.sleep(delayMs as Millis);
    }

    const endTime = this.now();
    const isLate = endTime.wallMs > target.wallMs;

    this.emit?.({
      type: isLate ? "time:deadline:err" : "time:deadline:ok",
      targetMs: target.wallMs,
      actualMs: endTime.wallMs,
      driftMs: endTime.wallMs - target.wallMs,
      at: endTime,
    });
  }

  interval(ms: Millis, callback: () => void | Promise<void>): TimerHandle {
    if (ms <= 0) {
      throw new Error("Interval must be positive");
    }

    const startTime = this.now();

    this.emit?.({
      type: "time:interval:set",
      intervalMs: ms,
      at: startTime,
    });

    const timer: PendingInterval = {
      kind: "interval",
      every: ms,
      nextMono: this.monoMs + ms,
      fn: callback,
      cancelled: false,
      tickCount: 0,
    };

    this.timers.push(timer);

    return {
      cancel: () => {
        timer.cancelled = true;
        this.emit?.({
          type: "time:interval:cancel",
          intervalMs: ms,
          ticks: timer.tickCount,
          at: this.now(),
        });
      },
    };
  }

  /**
   * Jump wall time while keeping monotonic time continuous
   */
  jumpWallTime(newWallMs: number): void {
    this.emit?.({
      type: "time:wall_jump",
      fromWall: this.wallMs,
      toWall: newWallMs,
      monoMs: this.monoMs,
    });
    this.wallMs = newWallMs;
  }

  /**
   * Advance monotonic time by a specific duration, firing all due timers
   */
  advanceBy(ms: Millis): void {
    if (ms <= 0) return;

    const targetMono = this.monoMs + ms;
    this.emit?.({
      type: "time:advance",
      byMs: ms,
      fromMono: this.monoMs,
      toMono: targetMono,
    });

    this.advanceTo(targetMono);
  }

  /**
   * Advance monotonic time to a specific time, firing all due timers
   */
  advanceTo(targetMono: number): void {
    if (targetMono <= this.monoMs) return;

    this.drainUntil(targetMono);

    // Final jump to target time
    if (this.monoMs < targetMono) {
      const dt = targetMono - this.monoMs;
      this.monoMs = targetMono;
      this.wallMs += dt;
    }
  }

  /**
   * Process all timers due up to targetMono without awaiting callbacks
   */
  private drainUntil(targetMono: number): void {
    while (true) {
      const next = this.getNextDue(targetMono);
      if (!next) break;

      // Jump time to the event
      const dt = next.fireAt - this.monoMs;
      this.monoMs = next.fireAt;
      this.wallMs += dt;

      if (next.timer.kind === "timeout") {
        if (!next.timer.cancelled) {
          // Fire timeout without await
          next.timer.fn();
        }
        // Remove timeout timer
        this.removeTimer(next.timer);
      } else {
        // Handle interval with catch-up
        while (next.timer.nextMono <= this.monoMs && !next.timer.cancelled) {
          // Schedule next tick first to maintain stable cadence
          next.timer.nextMono += next.timer.every;
          next.timer.tickCount++;

          const tickTime = this.now();
          this.emit?.({
            type: "time:interval:tick",
            intervalMs: (next.timer as PendingInterval).every,
            tick: (next.timer as PendingInterval).tickCount,
            at: tickTime,
          });

          try {
            // Fire without await - queue microtask if async is needed
            const result = next.timer.fn();
            if (result && typeof result.then === "function") {
              // Queue promise but don't await
              result.catch((error) => {
                this.emit?.({
                  type: "time:interval:error",
                  intervalMs: (next.timer as PendingInterval).every,
                  tick: (next.timer as PendingInterval).tickCount,
                  error,
                  at: this.now(),
                });
              });
            }
          } catch (error) {
            this.emit?.({
              type: "time:interval:error",
              intervalMs: (next.timer as PendingInterval).every,
              tick: (next.timer as PendingInterval).tickCount,
              error,
              at: this.now(),
            });
          }
        }
      }
    }
  }

  /**
   * Get the next timer due at or before targetMono
   */
  private getNextDue(targetMono: number): QueuedTimer | null {
    let earliest: QueuedTimer | null = null;

    for (const timer of this.timers) {
      if (timer.cancelled) continue;

      const fireAt: number = timer.kind === "timeout" ? timer.fireAt : timer.nextMono;

      if (fireAt <= targetMono) {
        if (!earliest || fireAt < earliest.fireAt) {
          earliest = { fireAt, timer };
        }
      }
    }

    return earliest;
  }

  /**
   * Remove a timer from the list
   */
  private removeTimer(timer: PendingTimer): void {
    const index = this.timers.indexOf(timer);
    if (index >= 0) {
      this.timers.splice(index, 1);
    }
  }

  /**
   * Advance by one tick, firing the next timer if any
   */
  tick(): void {
    const next = this.getNextDue(Infinity);
    if (next) {
      this.advanceTo(next.fireAt);
    }
  }

  /**
   * Get the number of pending timers
   */
  getPendingTimerCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  /**
   * Await completion of callbacks fired so far (microtasks/promises queued)
   */
  async flush(): Promise<void> {
    // Allow multiple microtask cycles to complete
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Create a new controlled clock instance
 */
export function createControlledClock(options?: { initialTime?: number; emit?: EmitFn }): ControlledClock {
  return new ControlledClock(options);
}

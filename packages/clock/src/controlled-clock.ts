import type { Clock, EmitFn, Instant, TimerHandle, Millis, DeadlineTarget } from "./types.js";

interface PendingTimer {
  id: number;
  type: "timeout" | "interval";
  fireAt: number;
  callback: () => void | Promise<void>;
  intervalMs?: Millis;
  cancelled: boolean;
}

/**
 * Controlled clock for deterministic testing
 */
class ControlledClock implements Clock {
  private wallMs: number;
  private monoMs: number;
  private readonly emit: EmitFn | undefined;
  private readonly pendingTimers: PendingTimer[] = [];
  private nextTimerId = 1;

  constructor(options?: { initialTime?: number; emit?: EmitFn }) {
    this.wallMs = options?.initialTime ?? Date.now();
    this.monoMs = options?.initialTime ?? Date.now();
    this.emit = options?.emit;
  }

  now(): Instant {
    return { wallMs: this.wallMs, monoMs: this.monoMs };
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
      const timer: PendingTimer = {
        id: this.nextTimerId++,
        type: "timeout",
        fireAt: this.monoMs + ms,
        callback: () => {
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
      this.pendingTimers.push(timer);
      this.pendingTimers.sort((a, b) => a.fireAt - b.fireAt);
    });
  }

  async timeout(ms: Millis): Promise<void> {
    return this.sleep(ms);
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
    let tickCount = 0;

    this.emit?.({
      type: "time:interval:set",
      intervalMs: ms,
      at: startTime,
    });

    const timer: PendingTimer = {
      id: this.nextTimerId++,
      type: "interval",
      fireAt: this.monoMs + ms,
      intervalMs: ms,
      callback: async () => {
        if (timer.cancelled) return;

        tickCount++;
        const tickTime = this.now();

        this.emit?.({
          type: "time:interval:tick",
          intervalMs: ms,
          tick: tickCount,
          at: tickTime,
        });

        try {
          await callback();
        } catch (error) {
          this.emit?.({
            type: "time:interval:error",
            intervalMs: ms,
            tick: tickCount,
            error,
            at: this.now(),
          });
        }

        // Schedule next tick
        if (!timer.cancelled) {
          timer.fireAt = this.monoMs + ms;
          this.pendingTimers.sort((a, b) => a.fireAt - b.fireAt);
        }
      },
      cancelled: false,
    };

    this.pendingTimers.push(timer);
    this.pendingTimers.sort((a, b) => a.fireAt - b.fireAt);

    return {
      cancel: () => {
        timer.cancelled = true;
        const index = this.pendingTimers.indexOf(timer);
        if (index >= 0) {
          this.pendingTimers.splice(index, 1);
        }
        this.emit?.({
          type: "time:interval:cancel",
          intervalMs: ms,
          ticks: tickCount,
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
  async advanceBy(ms: Millis): Promise<void> {
    if (ms <= 0) return;

    const targetMono = this.monoMs + ms;
    this.emit?.({
      type: "time:advance",
      byMs: ms,
      fromMono: this.monoMs,
      toMono: targetMono,
    });

    await this.advanceTo(targetMono);
  }

  /**
   * Advance monotonic time to a specific time, firing all due timers
   */
  async advanceTo(targetMono: number): Promise<void> {
    if (targetMono <= this.monoMs) return;

    while (this.pendingTimers.length > 0 && this.pendingTimers[0]!.fireAt <= targetMono) {
      const timer = this.pendingTimers[0]!;
      const jumpTo = timer.fireAt;

      // Advance time to timer's fire time
      const timeDelta = jumpTo - this.monoMs;
      this.monoMs = jumpTo;
      this.wallMs += timeDelta;

      // Fire the timer
      if (!timer.cancelled) {
        this.pendingTimers.shift();
        await timer.callback();

        // Re-add interval timers
        if (timer.type === "interval" && !timer.cancelled && timer.intervalMs) {
          timer.fireAt = this.monoMs + timer.intervalMs;
          this.pendingTimers.push(timer);
          this.pendingTimers.sort((a, b) => a.fireAt - b.fireAt);
        }
      } else {
        this.pendingTimers.shift();
      }
    }

    // Advance to target if we haven't reached it
    if (this.monoMs < targetMono) {
      const remaining = targetMono - this.monoMs;
      this.monoMs = targetMono;
      this.wallMs += remaining;
    }
  }

  /**
   * Advance by one tick, firing the next timer if any
   */
  async tick(): Promise<void> {
    if (this.pendingTimers.length === 0) return;

    const nextTimer = this.pendingTimers[0]!;
    await this.advanceTo(nextTimer.fireAt);
  }

  /**
   * Get the number of pending timers
   */
  getPendingTimerCount(): number {
    return this.pendingTimers.filter((t) => !t.cancelled).length;
  }
}

/**
 * Create a new controlled clock instance
 */
export function createControlledClock(options?: { initialTime?: number; emit?: EmitFn }): ControlledClock {
  return new ControlledClock(options);
}

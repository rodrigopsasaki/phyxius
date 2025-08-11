import type { Clock, EmitFn, Instant, TimerHandle } from "./types.js";

interface PendingTimer {
  id: number;
  type: "timeout" | "interval";
  fireAt: number;
  callback: () => void | Promise<void>;
  intervalMs?: number;
  cancelled: boolean;
}

/**
 * Controlled clock for deterministic testing
 */
export class ControlledClock implements Clock {
  private wallMs: number;
  private monoMs: number;
  private readonly emit: EmitFn | undefined;
  private readonly pendingTimers: PendingTimer[] = [];
  private nextTimerId = 1;

  constructor(options?: { initialTime?: number; emit?: EmitFn }) {
    this.wallMs = options?.initialTime ?? Date.now();
    this.monoMs = 0;
    this.emit = options?.emit;
  }

  now(): Instant {
    return { wallMs: this.wallMs, monoMs: this.monoMs };
  }

  async sleep(ms: number): Promise<void> {
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

  async deadline(at: number): Promise<void> {
    const now = this.now();
    const targetWallMs = at < 1_000_000_000_000 ? now.wallMs + at : at;
    const delayMs = Math.max(0, targetWallMs - now.wallMs);

    this.emit?.({
      type: "time:deadline:start",
      targetMs: targetWallMs,
      delayMs,
      at: now,
    });

    if (delayMs > 0) {
      await this.sleep(delayMs);
    }

    const endTime = this.now();
    const isLate = endTime.wallMs > targetWallMs;

    this.emit?.({
      type: isLate ? "time:deadline:err" : "time:deadline:ok",
      targetMs: targetWallMs,
      actualMs: endTime.wallMs,
      driftMs: endTime.wallMs - targetWallMs,
      at: endTime,
    });
  }

  interval(ms: number, callback: () => void | Promise<void>): TimerHandle {
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
      id: timer.id,
      clear: () => {
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
   * Advance time by a specific duration, firing all due timers
   */
  async advanceBy(ms: number): Promise<void> {
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
   * Advance time to a specific monotonic time, firing all due timers
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

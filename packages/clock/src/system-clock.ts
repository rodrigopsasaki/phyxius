import { performance } from "node:perf_hooks";
import type { Clock, EmitFn, Instant, TimerHandle, Millis, DeadlineTarget } from "./types.js";

/**
 * Real system clock implementation using Node.js timers
 */
class SystemClock implements Clock {
  private readonly emit: EmitFn | undefined;
  private readonly startTime: number;

  constructor(options?: { emit?: EmitFn }) {
    this.emit = options?.emit;
    this.startTime = performance.now();
  }

  now(): Instant {
    const monoMs = performance.now() - this.startTime;
    const wallMs = Date.now();
    return { wallMs, monoMs };
  }

  async sleep(ms: Millis): Promise<void> {
    if (ms <= 0) return;

    const startTime = this.now();
    this.emit?.({
      type: "time:sleep:start",
      durationMs: ms,
      at: startTime,
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

    const endTime = this.now();
    this.emit?.({
      type: "time:sleep:end",
      durationMs: ms,
      actualMs: endTime.monoMs - startTime.monoMs,
      at: endTime,
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

    const id = setInterval(async () => {
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
    }, ms);

    return {
      cancel: () => {
        clearInterval(id);
        this.emit?.({
          type: "time:interval:cancel",
          intervalMs: ms,
          ticks: tickCount,
          at: this.now(),
        });
      },
    };
  }
}

/**
 * Create a new system clock instance
 */
export function createSystemClock(options?: { emit?: EmitFn }): Clock {
  return new SystemClock(options);
}

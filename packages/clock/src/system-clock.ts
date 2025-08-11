import { performance } from "node:perf_hooks";
import type { Clock, EmitFn, Instant, TimerHandle } from "./types.js";

/**
 * Real system clock implementation using Node.js timers
 */
export class SystemClock implements Clock {
  private readonly emit: EmitFn | undefined;

  constructor(options?: { emit?: EmitFn }) {
    this.emit = options?.emit;
  }

  now(): Instant {
    const monoMs = performance.now();
    const wallMs = Date.now();
    return { wallMs, monoMs };
  }

  async sleep(ms: number): Promise<void> {
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
        // Intervals continue even if callback throws
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
      id,
      clear: () => {
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

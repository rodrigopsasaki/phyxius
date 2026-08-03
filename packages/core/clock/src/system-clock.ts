import { performance } from "node:perf_hooks";
import type { Budget, Clock, EmitFn, Instant, TimerHandle, Millis, MonoMs, DeadlineTarget } from "./types.js";
import { deadlineFrom, elapsedSince } from "./mono.js";

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
    // THE brand-construction site for SystemClock: `performance.now()` is a
    // raw, un-owned number the moment it comes back from Node. This is the
    // one place it's stamped into a `MonoMs` — everywhere else in this
    // file, a `MonoMs` is either this fresh read or something derived from
    // it via `deadlineFrom`/`elapsedSince`, never another raw cast.
    const monoMs = (performance.now() - this.startTime) as MonoMs;
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
      actualMs: elapsedSince(endTime.monoMs, startTime.monoMs),
      at: endTime,
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

    const handle = setTimeout(
      () => {
        controller.abort();
        this.emit?.({
          type: "time:timeout:expire",
          deadline,
          at: this.now(),
        });
      },
      Math.max(0, ms),
    );

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
        clearTimeout(handle);
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
    let tickCount = 0;
    let inFlight = false;
    let active = true;

    this.emit?.({
      type: "time:interval:set",
      intervalMs: ms,
      at: startTime,
    });

    const id = setInterval(async () => {
      if (!active || inFlight) return;

      inFlight = true;
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
      } finally {
        inFlight = false;
      }
    }, ms);

    return {
      cancel: () => {
        active = false;
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

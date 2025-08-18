import type { Clock, EmitFn, Instant, TimerHandle, Millis, DeadlineTarget } from "./types.js";

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

      let fireAt: number;
      if (timer.kind === "timeout") {
        fireAt = timer.fireAt;
      } else {
        fireAt = timer.nextMono;
      }

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

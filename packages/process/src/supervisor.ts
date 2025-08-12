import type { SupervisionStrategy, ProcessId, EmitFn } from "./types.js";
import type { Clock, Millis } from "@phyxius/clock";

export interface RestartWindow {
  startTime: number;
  restarts: number;
}

export class Supervisor {
  private readonly strategy: SupervisionStrategy;
  private readonly clock: Clock;
  private readonly emit?: EmitFn;
  private readonly restartWindows = new Map<ProcessId, RestartWindow>();

  constructor(strategy: SupervisionStrategy, clock: Clock, emit?: EmitFn) {
    this.strategy = strategy;
    this.clock = clock;
    if (emit) this.emit = emit;
  }

  shouldRestart(processId: ProcessId): boolean {
    if (this.strategy.type === "none") {
      return false;
    }

    if (!this.strategy.maxRestarts) {
      return true; // No limit, always restart
    }

    const now = this.clock.now().wallMs;
    const window = this.restartWindows.get(processId);

    if (!window) {
      // First restart
      this.restartWindows.set(processId, {
        startTime: now,
        restarts: 1,
      });
      return true;
    }

    const windowElapsed = now - window.startTime;

    if (windowElapsed > this.strategy.maxRestarts.within) {
      // Window expired, reset
      this.restartWindows.set(processId, {
        startTime: now,
        restarts: 1,
      });
      return true;
    }

    if (window.restarts >= this.strategy.maxRestarts.count) {
      // Too many restarts in window
      this.emit?.({
        type: "supervisor:giveup",
        id: processId,
        attempts: window.restarts,
        withinMs: windowElapsed,
      });
      return false;
    }

    // Allow restart and increment counter
    window.restarts++;
    return true;
  }

  getRestartDelay(processId: ProcessId): Millis {
    if (!this.strategy.backoff) {
      return 0 as Millis;
    }

    const window = this.restartWindows.get(processId);
    const attempt = window ? window.restarts : 1;

    const { initial, max, factor, jitter } = this.strategy.backoff;
    let delay = initial * Math.pow(factor, attempt - 1);
    delay = Math.min(delay, max);

    // Apply jitter if specified (±5%)
    if (jitter !== undefined) {
      const jitterAmount = delay * (jitter / 100);
      delay += (Math.random() - 0.5) * 2 * jitterAmount;
      delay = Math.max(0, delay);
    }

    this.emit?.({
      type: "supervisor:restart",
      id: processId,
      attempt,
      delayMs: delay,
    });

    return delay as Millis;
  }

  clearRestartHistory(processId: ProcessId): void {
    this.restartWindows.delete(processId);
  }
}

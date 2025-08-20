import type {
  SupervisionStrategy,
  ProcessId,
  EmitFn,
  ProcessBehavior,
  ProcessRef,
  ProcessSpec,
  Tools,
  ProcessEvent,
  StopReason,
} from "./types.js";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { ProcessImpl } from "./process.js";

export interface RestartWindow {
  startTime: number;
  restarts: number;
}

export type SupervisionAction = "restart" | "stop" | "escalate";

export class Supervisor {
  readonly id: ProcessId;
  private readonly strategy: SupervisionStrategy;
  private readonly clock: Clock;
  private readonly emit?: EmitFn;
  private readonly restartWindows = new Map<ProcessId, RestartWindow>();
  private readonly children: ProcessRef<unknown>[] = [];
  private readonly supervisionActions = new Map<ProcessId, SupervisionAction>();
  private readonly processBehaviors = new Map<ProcessId, ProcessBehavior<unknown, unknown, unknown>>();
  private stopped: boolean = false;

  constructor(id: ProcessId, clock: Clock, emit?: EmitFn, strategy?: SupervisionStrategy) {
    this.id = id;
    this.strategy = strategy || {
      type: "one-for-one",
      maxRestarts: { count: 3, within: 10000 as Millis }, // Default: max 3 restarts in 10 seconds
      backoff: { initial: 1000 as Millis, max: 30000 as Millis, factor: 2 },
    };
    this.clock = clock;
    if (emit) this.emit = emit;
  }

  shouldRestart(processId: ProcessId): boolean {
    if (this.strategy.type === "none" || this.stopped) {
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
      // Window expired, reset with circuit breaker delay
      this.restartWindows.set(processId, {
        startTime: now,
        restarts: 1,
      });
      return true;
    }

    if (window.restarts >= this.strategy.maxRestarts.count) {
      // Too many restarts in window - circuit breaker activated
      this.emit?.({
        type: "supervisor:giveup",
        supervisorId: this.id,
        processId,
        attempts: window.restarts,
        withinMs: windowElapsed,
        timestamp: now,
      });

      // Clean up the restart window to prevent memory leaks
      this.restartWindows.delete(processId);
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

  getChildren(): ProcessRef<unknown>[] {
    return [...this.children];
  }

  async spawn<TMsg = unknown, TState = unknown, TCtx = unknown>(
    behavior: ProcessBehavior<TMsg, TState, TCtx>,
  ): Promise<ProcessRef<TMsg>> {
    if (this.stopped) {
      throw new Error("Cannot spawn process: supervisor is stopped");
    }

    this.emit?.({
      type: "supervisor:spawning",
      supervisorId: this.id,
      timestamp: this.clock.now().wallMs,
    });

    try {
      const process = await this.createSupervisedProcess(behavior);

      this.children.push(process as ProcessRef<unknown>);

      // Set default supervision action and emit supervision event
      this.supervisionActions.set(process.id, "restart");

      this.emit?.({
        type: "supervisor:supervising",
        supervisorId: this.id,
        processId: process.id,
        strategy: "restart",
        timestamp: this.clock.now().wallMs,
      });

      this.emit?.({
        type: "supervisor:spawned",
        supervisorId: this.id,
        processId: process.id,
        timestamp: this.clock.now().wallMs,
      });

      return process;
    } catch (error) {
      this.emit?.({
        type: "supervisor:spawn:failed",
        supervisorId: this.id,
        error,
        timestamp: this.clock.now().wallMs,
      });
      throw error;
    }
  }

  private async createSupervisedProcess<TMsg, TState, TCtx>(
    behavior: ProcessBehavior<TMsg, TState, TCtx>,
  ): Promise<ProcessRef<TMsg>> {
    // Convert behavior to spec format with failure monitoring
    const spec: ProcessSpec<TMsg, TState, TCtx> = {
      name: "supervised-process",
      handle: (state: TState, msg: TMsg, tools: Tools<TState, TMsg, TCtx>) => {
        const handleFunc = behavior.handle;
        let result;

        if (handleFunc.length === 0) {
          result = handleFunc();
        } else if (handleFunc.length === 1) {
          result = (handleFunc as (msg: TMsg) => TState | Promise<TState> | void | Promise<void>)(msg);
        } else if (handleFunc.length === 2) {
          result = handleFunc(state, msg);
        } else {
          result = handleFunc(state, msg, tools);
        }

        if (result === undefined) {
          return state;
        }
        return result as TState;
      },
      ...(behavior.init && {
        init: (ctx: TCtx) => {
          const result = behavior.init!(ctx);
          return result as TState;
        },
      }),
      ...(behavior.terminate && {
        onStop: (state: TState, reason: StopReason, ctx: TCtx) => {
          const terminateFunc = behavior.terminate!;
          if (terminateFunc.length === 0) {
            return terminateFunc();
          } else {
            return terminateFunc(state, reason, ctx);
          }
        },
      }),
    };

    const process = new ProcessImpl(spec, {} as TCtx, this.clock, this.createFailureMonitor());
    await process.start();

    // Store behavior for restart purposes
    this.processBehaviors.set(process.id, behavior as ProcessBehavior<unknown, unknown, unknown>);

    return process;
  }

  private createFailureMonitor(): EmitFn {
    return (event: ProcessEvent) => {
      // Forward all events
      this.emit?.(event);

      // Monitor for process failure
      if (event.type === "process:fail" && event.id) {
        // Get behavior from storage to avoid closure capture
        const behavior = this.processBehaviors.get(event.id);
        if (behavior) {
          // Handle failure asynchronously to avoid blocking
          this.handleProcessFailure(event.id, behavior).catch((error) => {
            this.emit?.({
              type: "supervisor:restart:failed",
              supervisorId: this.id,
              processId: event.id!,
              error,
              timestamp: this.clock.now().wallMs,
            });
          });
        }
      }
    };
  }

  private async handleProcessFailure<TMsg, TState, TCtx>(
    processId: ProcessId,
    behavior: ProcessBehavior<TMsg, TState, TCtx>,
  ): Promise<void> {
    const action = this.supervisionActions.get(processId) || "restart";

    // Always clean up the failed process first
    await this.cleanupProcess(processId);

    if (action === "restart" && this.shouldRestart(processId)) {
      const delay = this.getRestartDelay(processId);

      // Wait for restart delay
      if (delay > 0) {
        await this.clock.timeout(delay);
      }

      // Check if supervisor was stopped during delay
      if (this.stopped) {
        return;
      }

      try {
        // Create new process instance
        const newProcess = await this.createSupervisedProcess(behavior);
        this.children.push(newProcess as ProcessRef<unknown>);

        // Maintain supervision action
        this.supervisionActions.set(newProcess.id, action);

        this.emit?.({
          type: "supervisor:child:restarted",
          supervisorId: this.id,
          oldProcessId: processId,
          newProcessId: newProcess.id,
          timestamp: this.clock.now().wallMs,
        });
      } catch (error) {
        this.emit?.({
          type: "supervisor:restart:failed",
          supervisorId: this.id,
          processId,
          error,
          timestamp: this.clock.now().wallMs,
        });
      }
    } else if (action === "stop") {
      this.emit?.({
        type: "supervisor:child:stopped",
        supervisorId: this.id,
        processId,
        timestamp: this.clock.now().wallMs,
      });
    } else if (action === "escalate") {
      this.emit?.({
        type: "supervisor:escalated",
        supervisorId: this.id,
        processId,
        timestamp: this.clock.now().wallMs,
      });
    }
  }

  private async cleanupProcess(processId: ProcessId): Promise<void> {
    // Remove from children
    const processIndex = this.children.findIndex((child) => child.id === processId);
    if (processIndex >= 0) {
      const process = this.children[processIndex];

      // Stop the process if it's still running
      if (process) {
        try {
          if (process.state === "running" || process.state === "starting") {
            await process.stop();
          }
        } catch {
          // Ignore stop errors for failed processes
        }
      }

      this.children.splice(processIndex, 1);
    }

    // Clean up supervision actions
    this.supervisionActions.delete(processId);
  }

  supervise<TMsg>(process: ProcessRef<TMsg>, action: SupervisionAction): void {
    this.supervisionActions.set(process.id, action);

    this.emit?.({
      type: "supervisor:supervising",
      supervisorId: this.id,
      processId: process.id,
      strategy: action,
      timestamp: this.clock.now().wallMs,
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return; // Idempotent
    }

    this.stopped = true;

    this.emit?.({
      type: "supervisor:stopping",
      supervisorId: this.id,
      timestamp: this.clock.now().wallMs,
    });

    // Stop all children
    const stopPromises = this.children.map(async (child) => {
      try {
        await child.stop();
      } catch (error) {
        this.emit?.({
          type: "supervisor:child:stop:error",
          supervisorId: this.id,
          processId: child.id,
          error,
          timestamp: this.clock.now().wallMs,
        });
      }
    });

    await Promise.all(stopPromises);

    this.children.length = 0;

    this.emit?.({
      type: "supervisor:stopped",
      supervisorId: this.id,
      timestamp: this.clock.now().wallMs,
    });
  }
}

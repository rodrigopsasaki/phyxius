import type {
  SupervisionStrategy,
  ProcessId,
  EmitFn,
  ProcessRef,
  ProcessSpec,
  ProcessEvent,
  RestartDeclined,
} from "./types.js";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { ProcessImpl } from "./process.js";
import { createProcessId } from "./process-id.js";

export interface RestartWindow {
  startTime: number;
  restarts: number;
}

export type SupervisionAction = "restart" | "stop" | "escalate";

/**
 * A declined restart, carrying its reason. The budget case also carries what
 * the budget had recorded, so the caller can emit the give-up event without
 * re-deriving numbers the decision already computed.
 */
export type RestartDeclinedDecision =
  | { kind: "declined"; because: Exclude<RestartDeclined, "restart-budget-exhausted"> }
  | {
      kind: "declined";
      because: "restart-budget-exhausted";
      spent: { attempts: number; withinMs: number };
    };

export type RestartDecision = { kind: "restart" } | RestartDeclinedDecision;

/**
 * A flat supervisor: it owns a set of children, restarts them on failure
 * (per strategy), and stops them on shutdown. Hierarchical nesting is done
 * explicitly by creating nested supervisors — there is no implicit
 * `tools.spawn` inside a child that silently registers with its parent.
 */
export class Supervisor {
  readonly id: ProcessId;
  private readonly strategy: SupervisionStrategy;
  private readonly clock: Clock;
  private readonly emit?: EmitFn;
  private readonly restartWindows = new Map<ProcessId, RestartWindow>();
  private readonly children: ProcessRef<unknown>[] = [];
  private readonly supervisionActions = new Map<ProcessId, SupervisionAction>();
  // Kept so a restart can re-spawn the same shape after the failed instance
  // is cleaned up. Supervisor, not Process, owns restart bookkeeping.
  private readonly processSpecs = new Map<ProcessId, ProcessSpec<unknown, unknown, unknown>>();
  private readonly processCtxs = new Map<ProcessId, unknown>();
  private readonly restartCounts = new Map<ProcessId, number>();
  private stopped = false;

  constructor(options: { id?: ProcessId; clock: Clock; emit?: EmitFn; strategy?: SupervisionStrategy }) {
    this.id = options.id ?? createProcessId();
    this.clock = options.clock;
    if (options.emit) this.emit = options.emit;
    this.strategy = options.strategy ?? {
      type: "one-for-one",
      maxRestarts: { count: 3, within: 10_000 as Millis },
      backoff: { initial: 1_000 as Millis, max: 30_000 as Millis, factor: 2 },
    };
  }

  /** Number of times the supervisor has restarted this process. */
  getRestartCount(processId: ProcessId): number {
    return this.restartCounts.get(processId) ?? 0;
  }

  getChildren(): ProcessRef<unknown>[] {
    return [...this.children];
  }

  /**
   * Spawn a supervised child. Returns a running ref.
   */
  async spawn<TMsg, TState = void, TCtx = void>(
    spec: ProcessSpec<TMsg, TState, TCtx>,
    ctx?: TCtx,
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
      const process = await this.createSupervisedProcess(spec, ctx as TCtx);

      this.children.push(process as ProcessRef<unknown>);
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
    if (this.stopped) return;
    this.stopped = true;

    this.emit?.({
      type: "supervisor:stopping",
      supervisorId: this.id,
      timestamp: this.clock.now().wallMs,
    });

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

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Decide whether a failed child is restarted, and when it is not, say which
   * of the three reasons it was. This returned a bare boolean: "no" was
   * indistinguishable across a policy of never restarting, a shutdown already
   * under way, and a spent restart budget — and only the last of those emitted
   * anything, so the other two ended a child's life with no record at all.
   * `ProcessEvent`'s own contract is that a state transition a consumer would
   * care about MUST produce an event; two of these three did not.
   *
   * Emitting stays with the caller (the `supervisor:giveup` event this used to
   * fire from in here now fires there), so this function decides and the
   * caller acts — the same classify-then-act split `@phyxiusjs/drain` uses for
   * its flush. The restart-window bookkeeping deliberately stays here: it is
   * the accounting the decision is made from, not a consequence of it.
   */
  private decideRestart(processId: ProcessId): RestartDecision {
    if (this.strategy.type === "none") {
      return { kind: "declined", because: "strategy-none" };
    }

    if (this.stopped) {
      return { kind: "declined", because: "supervisor-stopping" };
    }

    if (!this.strategy.maxRestarts) {
      return { kind: "restart" }; // no limit
    }

    const now = this.clock.now().wallMs;
    const window = this.restartWindows.get(processId);

    if (!window) {
      this.restartWindows.set(processId, { startTime: now, restarts: 1 });
      return { kind: "restart" };
    }

    const windowElapsed = now - window.startTime;

    if (windowElapsed > this.strategy.maxRestarts.within) {
      // Window expired — fresh budget.
      this.restartWindows.set(processId, { startTime: now, restarts: 1 });
      return { kind: "restart" };
    }

    if (window.restarts >= this.strategy.maxRestarts.count) {
      const spent = { attempts: window.restarts, withinMs: windowElapsed };
      this.restartWindows.delete(processId);
      return { kind: "declined", because: "restart-budget-exhausted", spent };
    }

    window.restarts++;
    return { kind: "restart" };
  }

  /** The one place a declined restart becomes an event. */
  private emitDeclinedRestart(processId: ProcessId, declined: RestartDeclinedDecision): void {
    const timestamp = this.clock.now().wallMs;

    if (declined.because === "restart-budget-exhausted") {
      // Unchanged in name and payload — existing consumers of the give-up
      // signal keep reading exactly what they read before.
      this.emit?.({
        type: "supervisor:giveup",
        supervisorId: this.id,
        processId,
        attempts: declined.spent.attempts,
        withinMs: declined.spent.withinMs,
        timestamp,
      });
      return;
    }

    this.emit?.({
      type: "supervisor:restart:abandoned",
      supervisorId: this.id,
      processId,
      because: declined.because,
      timestamp,
    });
  }

  private getRestartDelay(processId: ProcessId): Millis {
    if (!this.strategy.backoff) return 0 as Millis;

    const window = this.restartWindows.get(processId);
    const attempt = window ? window.restarts : 1;

    const { initial, max, factor, jitter } = this.strategy.backoff;
    let delay = initial * Math.pow(factor, attempt - 1);
    delay = Math.min(delay, max);

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

  private async createSupervisedProcess<TMsg, TState, TCtx>(
    spec: ProcessSpec<TMsg, TState, TCtx>,
    ctx: TCtx,
  ): Promise<ProcessRef<TMsg>> {
    const process = new ProcessImpl(spec, ctx, this.clock, this.createFailureMonitor());
    await process.start();

    // Record spec+ctx for restart re-spawning.
    this.processSpecs.set(process.id, spec as ProcessSpec<unknown, unknown, unknown>);
    this.processCtxs.set(process.id, ctx);

    return process;
  }

  private createFailureMonitor(): EmitFn {
    return (event: ProcessEvent) => {
      this.emit?.(event);

      if (event.type === "process:fail" && event.id) {
        const failedId = event.id;
        const spec = this.processSpecs.get(failedId);
        const ctx = this.processCtxs.get(failedId);
        if (spec) {
          this.handleProcessFailure(failedId, spec, ctx).catch((error) => {
            this.emit?.({
              type: "supervisor:restart:failed",
              supervisorId: this.id,
              processId: failedId,
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
    spec: ProcessSpec<TMsg, TState, TCtx>,
    ctx: TCtx,
  ): Promise<void> {
    const action = this.supervisionActions.get(processId) ?? "restart";

    await this.cleanupProcess(processId);

    if (action === "restart") {
      const decision = this.decideRestart(processId);
      if (decision.kind === "declined") {
        this.emitDeclinedRestart(processId, decision);
        return;
      }

      const delay = this.getRestartDelay(processId);
      if (delay > 0) {
        await this.clock.sleep(delay);
      }

      // Shutdown can land inside that sleep. The restart was already decided
      // and its budget already spent, so returning here silently retired a
      // child on a decision that says the opposite — the one drop in this
      // method that left no trace of itself.
      if (this.stopped) {
        this.emitDeclinedRestart(processId, { kind: "declined", because: "supervisor-stopping" });
        return;
      }

      try {
        const newProcess = await this.createSupervisedProcess(spec, ctx);
        this.children.push(newProcess as ProcessRef<unknown>);
        this.supervisionActions.set(newProcess.id, action);

        // Bump the restart counter against the original id for observability.
        this.restartCounts.set(processId, (this.restartCounts.get(processId) ?? 0) + 1);

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
      return;
    }

    if (action === "stop") {
      this.emit?.({
        type: "supervisor:child:stopped",
        supervisorId: this.id,
        processId,
        timestamp: this.clock.now().wallMs,
      });
      return;
    }

    if (action === "escalate") {
      this.emit?.({
        type: "supervisor:escalated",
        supervisorId: this.id,
        processId,
        timestamp: this.clock.now().wallMs,
      });
    }
  }

  private async cleanupProcess(processId: ProcessId): Promise<void> {
    const index = this.children.findIndex((child) => child.id === processId);
    if (index >= 0) {
      const process = this.children[index];
      if (process) {
        try {
          const state = process.status();
          if (state === "running" || state === "starting") {
            await process.stop();
          }
        } catch {
          // Failed process's own stop failures don't propagate here.
        }
      }
      this.children.splice(index, 1);
    }

    this.supervisionActions.delete(processId);
    this.processSpecs.delete(processId);
    this.processCtxs.delete(processId);
  }
}

import type {
  SupervisionStrategy,
  ProcessId,
  EmitFn,
  ProcessRef,
  ProcessSpec,
  ProcessEvent,
  ProcessStatus,
  StopReason,
  RestartDeclined,
} from "./types.js";
import type { Clock, Millis, MonoMs } from "@phyxiusjs/clock";
import { elapsedSince } from "@phyxiusjs/clock";
import { ProcessImpl } from "./process.js";
import { createProcessId } from "./process-id.js";

export interface RestartWindow {
  startTime: MonoMs;
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

type Backoff = NonNullable<SupervisionStrategy["backoff"]>;

/**
 * A backoff whose jitter is absent, or pinned to the literal `0` — an
 * explicit "off", not an absence left to default. Computing it never
 * touches randomness, so a supervisor built with one needs no injected
 * `random`.
 */
type NoJitterBackoff = Backoff & { jitter?: 0 };

/**
 * A backoff whose jitter is a real, nonzero magnitude. There is no way to
 * turn "jitter: 50" into an actual delay without a source of randomness.
 */
type JitteredBackoff = Backoff & { jitter: number };

/**
 * `random` stays optional exactly when the strategy's backoff cannot draw on
 * it. See `SupervisorOptionsWithJitter` below for the strategy shape that
 * requires it.
 */
interface SupervisorOptionsNoJitter {
  id?: ProcessId;
  clock: Clock;
  emit?: EmitFn;
  strategy?: SupervisionStrategy & { backoff?: NoJitterBackoff };
  random?: () => number;
}

/**
 * The moment a strategy's backoff declares real jitter, this is the only
 * constructor overload that matches it, and it makes `random` required —
 * "jitter but no injected random" is a compile error here, not a silent
 * fallback to the runtime's own global RNG.
 */
interface SupervisorOptionsWithJitter {
  id?: ProcessId;
  clock: Clock;
  emit?: EmitFn;
  strategy: SupervisionStrategy & { backoff: JitteredBackoff };
  random: () => number;
}

/**
 * The address a caller holds for a supervised child. `id` is minted once,
 * at `spawn` time, and never changes: it names the *slot* ("the thing this
 * caller is supervising"), not whichever `ProcessImpl` incarnation happens
 * to be running behind it. `current` is swapped in place on every successful
 * restart, so `send` / `ask` / `stop` / `status` always reach the live
 * incarnation instead of freezing on the one that failed.
 *
 * This is the fix for "the ref returned by spawn goes stale after the first
 * restart". Without it, a caller's only way back to a running child after
 * a restart was `supervisor.getChildren()`, which silently made the ref
 * `spawn` returned a footgun.
 */
class SupervisedRef<TMsg> implements ProcessRef<TMsg> {
  // Untyped in TMsg on purpose: the supervisor's own bookkeeping stores
  // `SupervisedRef<unknown>` for every slot regardless of what message type
  // the caller spawned it with, and swaps this field to each freshly created
  // incarnation. Typing it `ProcessRef<TMsg>` would make that storage need a
  // cast; typing it `ProcessRef<unknown>` needs none, because every message
  // this class's own `send`/`ask` methods hand it is trivially a `TMsg`
  // widened to `unknown`, never the other way around.
  current: ProcessRef<unknown>;

  constructor(
    readonly id: ProcessId,
    current: ProcessRef<unknown>,
  ) {
    this.current = current;
  }

  status(): ProcessStatus {
    return this.current.status();
  }

  send(msg: TMsg): Promise<boolean> {
    return this.current.send(msg);
  }

  ask<TResp>(build: (reply: (r: TResp) => void) => TMsg, timeout?: Millis): Promise<TResp> {
    return this.current.ask(build, timeout);
  }

  stop(reason?: StopReason): Promise<void> {
    return this.current.stop(reason);
  }
}

/**
 * Everything the supervisor tracks about one supervised child, keyed by the
 * child's stable slot id (`SupervisedRef.id`) rather than by any single
 * incarnation's `ProcessId`. `spec` and `ctx` are kept here so a restart can
 * re-spawn the same shape after the failed instance is cleaned up.
 */
interface Slot {
  readonly ref: SupervisedRef<unknown>;
  readonly spec: ProcessSpec<unknown, unknown, unknown>;
  readonly ctx: unknown;
  action: SupervisionAction;
}

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
  /**
   * Jitter's source of entropy. Injected so backoff stays deterministic
   * under a ControlledClock. The constructor overloads below make a
   * strategy with real jitter uncompilable without one, so by the time a
   * jittered `getRestartDelay` reads this field it is always the caller's
   * own source — never the runtime's own global RNG. A strategy with no
   * jitter never reads it; the throwing stub the constructor stores in
   * that case exists only to fail loudly if that guarantee is ever bypassed.
   */
  private readonly random: () => number;
  private readonly restartWindows = new Map<ProcessId, RestartWindow>();
  private readonly restartCounts = new Map<ProcessId, number>();
  private readonly slots = new Map<ProcessId, Slot>();
  /** Slot ids currently inside their own restart-retry loop. Guards against
   * the re-entrant `process:fail` a failed re-init raises through the very
   * failure monitor that loop is already handling. See `handleProcessFailure`. */
  private readonly restarting = new Set<ProcessId>();
  private stopped = false;

  constructor(options: SupervisorOptionsNoJitter);
  constructor(options: SupervisorOptionsWithJitter);
  constructor(options: {
    id?: ProcessId;
    clock: Clock;
    emit?: EmitFn;
    strategy?: SupervisionStrategy;
    random?: () => number;
  }) {
    this.id = options.id ?? createProcessId();
    this.clock = options.clock;
    if (options.emit) this.emit = options.emit;
    this.random =
      options.random ??
      (() => {
        throw new Error(
          "Supervisor: backoff jitter needs an injected `random`; this strategy declared none, so jitter is never computed and this call is unreachable by construction.",
        );
      });
    this.strategy = options.strategy ?? {
      type: "one-for-one",
      maxRestarts: { count: 3, within: 10_000 as Millis },
      backoff: { initial: 1_000 as Millis, max: 30_000 as Millis, factor: 2 },
    };
  }

  /** Number of times the supervisor has successfully restarted this child. */
  getRestartCount(processId: ProcessId): number {
    return this.restartCounts.get(processId) ?? 0;
  }

  getChildren(): ProcessRef<unknown>[] {
    return [...this.slots.values()].map((slot) => slot.ref);
  }

  /**
   * Spawn a supervised child. Returns a ref that keeps addressing the
   * current incarnation across restarts.
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

    const slotId = createProcessId();

    try {
      const process = await this.createSupervisedProcess(spec, ctx, slotId);
      const ref = new SupervisedRef<TMsg>(slotId, process);

      this.slots.set(slotId, { ref, spec, ctx, action: "restart" });

      this.emit?.({
        type: "supervisor:supervising",
        supervisorId: this.id,
        processId: slotId,
        strategy: "restart",
        timestamp: this.clock.now().wallMs,
      });

      this.emit?.({
        type: "supervisor:spawned",
        supervisorId: this.id,
        processId: slotId,
        timestamp: this.clock.now().wallMs,
      });

      return ref;
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
    const slot = this.slots.get(process.id);
    if (slot) slot.action = action;

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

    const stopPromises = [...this.slots.values()].map(async (slot) => {
      try {
        await slot.ref.stop();
      } catch (error) {
        this.emit?.({
          type: "supervisor:child:stop:error",
          supervisorId: this.id,
          processId: slot.ref.id,
          error,
          timestamp: this.clock.now().wallMs,
        });
      }
    });

    await Promise.all(stopPromises);
    this.slots.clear();

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
   * under way, and a spent restart budget. Only the last of those emitted
   * anything, so the other two ended a child's life with no record at all.
   * `ProcessEvent`'s own contract is that a state transition a consumer would
   * care about MUST produce an event; two of these three did not.
   *
   * Emitting stays with the caller (the `supervisor:giveup` event this used to
   * fire from in here now fires there), so this function decides and the
   * caller acts: the same classify-then-act split `@phyxiusjs/drain` uses for
   * its flush. The restart-window bookkeeping deliberately stays here: it is
   * the accounting the decision is made from, not a consequence of it.
   *
   * Keyed by `slotId`, the stable address `spawn` handed the caller, and
   * measured on the clock's monotonic reading. Keying by each incarnation's
   * own fresh `ProcessId` (the original defect) meant every restart looked up
   * an empty window and started over at `restarts = 1`, so the budget never
   * accumulated and never tripped. Measuring on `wallMs` (the other original
   * defect) meant a wall-clock jump could open or close the window on its own.
   */
  private decideRestart(slotId: ProcessId): RestartDecision {
    if (this.strategy.type === "none") {
      return { kind: "declined", because: "strategy-none" };
    }

    if (this.stopped) {
      return { kind: "declined", because: "supervisor-stopping" };
    }

    if (!this.strategy.maxRestarts) {
      return { kind: "restart" }; // no limit
    }

    const now = this.clock.now().monoMs;
    const window = this.restartWindows.get(slotId);

    if (!window) {
      this.restartWindows.set(slotId, { startTime: now, restarts: 1 });
      return { kind: "restart" };
    }

    const windowElapsed = elapsedSince(now, window.startTime);

    if (windowElapsed > this.strategy.maxRestarts.within) {
      // Window expired — fresh budget.
      this.restartWindows.set(slotId, { startTime: now, restarts: 1 });
      return { kind: "restart" };
    }

    if (window.restarts >= this.strategy.maxRestarts.count) {
      const spent = { attempts: window.restarts, withinMs: windowElapsed };
      this.restartWindows.delete(slotId);
      return { kind: "declined", because: "restart-budget-exhausted", spent };
    }

    window.restarts++;
    return { kind: "restart" };
  }

  /** The one place a declined restart becomes an event. */
  private emitDeclinedRestart(slotId: ProcessId, declined: RestartDeclinedDecision): void {
    const timestamp = this.clock.now().wallMs;

    if (declined.because === "restart-budget-exhausted") {
      // Unchanged in name and payload: existing consumers of the give-up
      // signal keep reading exactly what they read before.
      this.emit?.({
        type: "supervisor:giveup",
        supervisorId: this.id,
        processId: slotId,
        attempts: declined.spent.attempts,
        withinMs: declined.spent.withinMs,
        timestamp,
      });
      return;
    }

    this.emit?.({
      type: "supervisor:restart:abandoned",
      supervisorId: this.id,
      processId: slotId,
      because: declined.because,
      timestamp,
    });
  }

  private getRestartDelay(slotId: ProcessId): Millis {
    if (!this.strategy.backoff) return 0 as Millis;

    const window = this.restartWindows.get(slotId);
    const attempt = window ? window.restarts : 1;

    const { initial, max, factor, jitter } = this.strategy.backoff;
    let delay = initial * Math.pow(factor, attempt - 1);
    delay = Math.min(delay, max);

    if (jitter !== undefined) {
      const jitterAmount = delay * (jitter / 100);
      delay += (this.random() - 0.5) * 2 * jitterAmount;
      delay = Math.max(0, delay);
    }

    this.emit?.({
      type: "supervisor:restart",
      id: slotId,
      attempt,
      delayMs: delay,
    });

    return delay as Millis;
  }

  private async createSupervisedProcess<TMsg, TState, TCtx>(
    spec: ProcessSpec<TMsg, TState, TCtx>,
    ctx: TCtx,
    slotId: ProcessId,
  ): Promise<ProcessRef<TMsg>> {
    const process = new ProcessImpl(spec, ctx, this.clock, this.createFailureMonitor(slotId));
    await process.start();
    return process;
  }

  /**
   * One monitor per incarnation, closed over the slot it belongs to rather
   * than looking the slot up from the failed incarnation's own id: there is
   * no map from incarnation id back to slot, on purpose. A failed re-init
   * inside `handleProcessFailure`'s own retry loop raises `process:fail`
   * through this very monitor before that loop's `await` on
   * `createSupervisedProcess` has a chance to observe the rejection; the
   * `restarting` guard in `handleProcessFailure` is what makes that re-entrant
   * call a no-op instead of a second, racing handler for the same slot.
   */
  private createFailureMonitor(slotId: ProcessId): EmitFn {
    return (event: ProcessEvent) => {
      this.emit?.(event);

      if (event.type === "process:fail") {
        this.handleProcessFailure(slotId).catch((error) => {
          this.emit?.({
            type: "supervisor:restart:failed",
            supervisorId: this.id,
            processId: slotId,
            error,
            timestamp: this.clock.now().wallMs,
          });
        });
      }
    };
  }

  private async handleProcessFailure(slotId: ProcessId): Promise<void> {
    const slot = this.slots.get(slotId);
    if (!slot) return; // already retired (e.g. by shutdown, or a stale re-entrant signal)

    if (slot.action === "stop") {
      this.retireSlot(slotId);
      this.emit?.({
        type: "supervisor:child:stopped",
        supervisorId: this.id,
        processId: slotId,
        timestamp: this.clock.now().wallMs,
      });
      return;
    }

    if (slot.action === "escalate") {
      this.retireSlot(slotId);
      this.emit?.({
        type: "supervisor:escalated",
        supervisorId: this.id,
        processId: slotId,
        timestamp: this.clock.now().wallMs,
      });
      return;
    }

    // action === "restart"
    if (this.restarting.has(slotId)) return; // re-entrant: the in-flight loop below owns this failure
    this.restarting.add(slotId);

    try {
      await this.restartLoop(slotId, slot);
    } finally {
      this.restarting.delete(slotId);
    }
  }

  /**
   * Keep trying to bring the slot back up until the budget says stop. A
   * failed re-init (`createSupervisedProcess` rejecting) is just another
   * failure of the same child: it counts against the same budget and is
   * retried with the same backoff, instead of ending supervision after a
   * single `supervisor:restart:failed` the way it used to.
   */
  private async restartLoop(slotId: ProcessId, slot: Slot): Promise<void> {
    const failedIncarnationId = slot.ref.current.id;

    while (true) {
      const decision = this.decideRestart(slotId);
      if (decision.kind === "declined") {
        this.emitDeclinedRestart(slotId, decision);
        this.retireSlot(slotId);
        return;
      }

      const delay = this.getRestartDelay(slotId);
      if (delay > 0) {
        await this.clock.sleep(delay);
      }

      // Shutdown can land inside that sleep. The restart was already decided
      // and its budget already spent, so returning here silently retired a
      // child on a decision that says the opposite: the one drop in this
      // method that left no trace of itself.
      if (this.stopped) {
        this.emitDeclinedRestart(slotId, { kind: "declined", because: "supervisor-stopping" });
        this.retireSlot(slotId);
        return;
      }

      try {
        const newProcess = await this.createSupervisedProcess(slot.spec, slot.ctx, slotId);
        slot.ref.current = newProcess;

        this.restartCounts.set(slotId, (this.restartCounts.get(slotId) ?? 0) + 1);

        this.emit?.({
          type: "supervisor:child:restarted",
          supervisorId: this.id,
          oldProcessId: failedIncarnationId,
          newProcessId: newProcess.id,
          timestamp: this.clock.now().wallMs,
        });
        return;
      } catch (error) {
        this.emit?.({
          type: "supervisor:restart:failed",
          supervisorId: this.id,
          processId: slotId,
          error,
          timestamp: this.clock.now().wallMs,
        });
        // Loop again: decideRestart runs once more and spends more of the
        // same budget, rather than ending supervision here.
      }
    }
  }

  private retireSlot(slotId: ProcessId): void {
    this.slots.delete(slotId);
    this.restartWindows.delete(slotId);
    // restartCounts is intentionally NOT cleared: it is the final tally a
    // caller can still read (via the slot id it already holds) after giveup.
  }
}

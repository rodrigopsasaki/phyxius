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
import { elapsedSince, ms } from "@phyxiusjs/clock";
import { ProcessImpl } from "./process.js";
import { createProcessId } from "./process-id.js";

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

/**
 * `attempt` is which restart this is, counting the ones still inside the
 * budget window: the input to the backoff curve, decided next to the
 * bookkeeping it is read from.
 */
export type RestartDecision = { kind: "restart"; attempt: number } | RestartDeclinedDecision;

type Backoff = NonNullable<SupervisionStrategy["backoff"]>;

/**
 * The shortest wait before a failed re-init is tried again. A retry driven by
 * the supervisor itself, with no message behind it, that waits nothing is a
 * loop that never yields: it starves every other timer on the event loop, and
 * on a controlled clock nothing can interrupt it. One millisecond is the
 * smallest wait the clock will actually park on.
 */
const MIN_REINIT_RETRY_DELAY = ms(1);

/**
 * A backoff the type can see needs no `random`: one that does not mention
 * `jitter`, or pins it to the literal `0`, an explicit "off". Computing it
 * never touches randomness.
 *
 * The union is what tells a written-out literal from a value that is merely
 * typed as `SupervisionStrategy`. A fresh literal that writes `jitter: 50`
 * matches neither member (50 is not `0`, and the first member has no such
 * key), so it falls through to the overload that requires `random`. A value
 * already typed as `SupervisionStrategy` has no literal to inspect, only the
 * wide `jitter?: number`, and is accepted on its shape: the type cannot say
 * whether it carries jitter, and does not pretend to. `jitterFrom` refuses
 * that case at construction instead. test/supervisor-options.types.ts pins
 * both sides.
 */
type BackoffWithoutJitter = Omit<Backoff, "jitter">;
type NoJitterBackoff = BackoffWithoutJitter | (BackoffWithoutJitter & { jitter?: 0 });

/**
 * `random` is optional here: nothing the type can see draws on it.
 */
interface SupervisorOptionsNoJitter {
  id?: ProcessId;
  clock: Clock;
  emit?: EmitFn;
  strategy?: Omit<SupervisionStrategy, "backoff"> & { backoff?: NoJitterBackoff };
  random?: () => number;
}

/**
 * Any `SupervisionStrategy`, with the randomness it might need injected. A
 * literal that declares a real jitter magnitude lands here, since it cannot be
 * turned into a delay without a source of randomness, and is a compile error
 * without `random`: never a silent fallback to the runtime's own global RNG.
 */
interface SupervisorOptionsWithRandom {
  id?: ProcessId;
  clock: Clock;
  emit?: EmitFn;
  strategy?: SupervisionStrategy;
  random: () => number;
}

/**
 * Resolve the backoff's jitter into a total function, once, at construction.
 * The alternative is a `random` field that is sometimes a stand-in and a
 * check at every delay computation; here "jitter declared but no randomness"
 * cannot be constructed, so nothing downstream can meet it. The overloads on
 * the constructor keep a written-out literal from compiling; this is the same
 * refusal for the callers the overloads cannot see: a value typed as the wide
 * `SupervisionStrategy`, and JavaScript. It fails here, at the composition
 * root, rather than on the first restart of a child that is already crashing.
 */
function jitterFrom(backoff: Backoff | undefined, random: (() => number) | undefined): (delay: number) => number {
  const percent = backoff?.jitter;
  if (percent === undefined || percent === 0) return (delay) => delay;

  if (random === undefined) {
    throw new Error(
      `Supervisor: strategy.backoff.jitter is ${percent}, which needs an injected \`random\`; pass \`random: () => number\` or set jitter to 0.`,
    );
  }

  return (delay) => {
    const jitterAmount = delay * (percent / 100);
    return Math.max(0, delay + (random() - 0.5) * 2 * jitterAmount);
  };
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
    private readonly retire: () => void,
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

  /**
   * Stopping a child through its ref is final, and the slot is retired before
   * the stop begins. Otherwise the stop could be undone: a restart already
   * asleep in backoff would wake and bring the child back, and an `onStop`
   * that throws is reported as `process:fail`, the same event a crash is, and
   * would be restarted as one.
   */
  stop(reason?: StopReason): Promise<void> {
    this.retire();
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
   * The backoff's jitter, already bound to the caller's own `random` (or to
   * the identity when the strategy has none). See `jitterFrom`.
   */
  private readonly jittered: (delay: number) => number;
  /** Per slot, when each restart inside the trailing budget window was decided. */
  private readonly restartWindows = new Map<ProcessId, MonoMs[]>();
  /**
   * Per slot, restarts decided when the strategy has no `maxRestarts`. There
   * is no window to count them in, and nothing leaves one, so the count only
   * grows: it is the backoff curve's input, and the curve's own `max` is what
   * bounds the wait.
   */
  private readonly unwindowedAttempts = new Map<ProcessId, number>();
  private readonly restartCounts = new Map<ProcessId, number>();
  private readonly slots = new Map<ProcessId, Slot>();
  private stopped = false;

  constructor(options: SupervisorOptionsNoJitter);
  constructor(options: SupervisorOptionsWithRandom);
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
    this.strategy = options.strategy ?? {
      type: "one-for-one",
      maxRestarts: { count: 3, within: ms(10_000) },
      backoff: { initial: ms(1_000), max: ms(30_000), factor: 2 },
    };
    this.jittered = jitterFrom(this.strategy.backoff, options.random);
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
      const ref = new SupervisedRef<TMsg>(slotId, process, () => this.retireSlot(slotId));

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

    await Promise.all([...this.slots.values()].map((slot) => this.stopQuietly(slot.ref.id, slot.ref)));
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
   * reason it was. This returned a bare boolean: "no" was indistinguishable
   * across a policy of never restarting, a shutdown already under way, and a
   * spent restart budget. Only the last of those emitted anything, so the
   * other two ended a child's life with no record at all. `ProcessEvent`'s
   * own contract is that a state transition a consumer would care about MUST
   * produce an event; two of those three did not.
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

    const gone = this.whyNoLongerSupervised(slotId);
    if (gone) {
      return { kind: "declined", because: gone };
    }

    const budget = this.strategy.maxRestarts;
    if (!budget) {
      // No limit: restarting never stops, but backoff still has to grow.
      const attempt = (this.unwindowedAttempts.get(slotId) ?? 0) + 1;
      this.unwindowedAttempts.set(slotId, attempt);
      return { kind: "restart", attempt };
    }

    // The window slides: it holds the restarts decided at most `within` ago,
    // and each one leaves it on its own schedule. One that is exactly `within`
    // old is still inside. A window that restarted from scratch when it
    // "expired" would let a burst straddling that moment spend the budget
    // twice over.
    const now = this.clock.now().monoMs;
    const recent = (this.restartWindows.get(slotId) ?? []).filter((at) => elapsedSince(now, at) <= budget.within);

    if (recent.length >= budget.count) {
      const oldest = recent[0];
      const spent = {
        attempts: recent.length,
        withinMs: oldest === undefined ? 0 : elapsedSince(now, oldest),
      };
      return { kind: "declined", because: "restart-budget-exhausted", spent };
    }

    recent.push(now);
    this.restartWindows.set(slotId, recent);
    return { kind: "restart", attempt: recent.length };
  }

  /**
   * A restart that is decided and then has to wait (a backoff sleep, a
   * replacement that is still starting) can outlive the thing it was for.
   * Says which of the two ended it, or `undefined` if it is still wanted:
   * the supervisor shut down, or the caller stopped the child through its ref
   * and the slot is gone.
   */
  private whyNoLongerSupervised(slotId: ProcessId): "supervisor-stopping" | "child-stopped" | undefined {
    if (this.stopped) return "supervisor-stopping";
    if (!this.slots.has(slotId)) return "child-stopped";
    return undefined;
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

  /**
   * The wait before a restart: the backoff curve at `attempt`
   * (`initial * factor^(attempt-1)`, capped at `max`, then jittered), and never
   * less than `floor`. Total: the result is always a finite number of at least
   * `floor`, whatever the curve computes to. A curve that overflows
   * (`factor^(attempt-1)` is Infinity from attempt 1025 at factor 2) is capped
   * by `max`, but with `initial` 0 it is `0 * Infinity`, which is NaN, and NaN
   * slips past `Math.max` and every `> 0` check. The comparison is written so
   * that it cannot: a NaN or infinite delay, or one below the floor, is the
   * floor.
   */
  private restartDelay(attempt: number, floor: Millis): Millis {
    const { backoff } = this.strategy;
    if (!backoff) return floor;

    const { initial, max, factor } = backoff;
    const delay = this.jittered(Math.min(initial * Math.pow(factor, attempt - 1), max));
    return Number.isFinite(delay) && delay >= floor ? ms(delay) : floor;
  }

  /**
   * Build one incarnation and start it. Its failures reach the supervisor's
   * failure handling only once it has come up: a failure while starting
   * (`init` throwing) is `start()`'s rejection, and belongs to whoever
   * awaited it, `spawn` or the restart loop, each of which already decides
   * what a failed start means. Routing it through the monitor as well handed
   * the same failure to two handlers, and the guard that stopped them racing
   * (a per-slot flag held for the whole loop) also swallowed a genuine
   * failure signalled in the instant after a restart succeeded.
   *
   * The monitor is closed over the slot it belongs to rather than looking the
   * slot up from the failed incarnation's own id: there is no map from
   * incarnation id back to slot, on purpose.
   */
  private async createSupervisedProcess<TMsg, TState, TCtx>(
    spec: ProcessSpec<TMsg, TState, TCtx>,
    ctx: TCtx,
    slotId: ProcessId,
  ): Promise<ProcessRef<TMsg>> {
    let hasStarted = false;

    const process = new ProcessImpl(spec, ctx, this.clock, (event: ProcessEvent) => {
      this.emit?.(event);

      if (hasStarted && event.type === "process:fail") {
        this.handleProcessFailure(slotId).catch((error) => this.settleAfterFault(slotId, error));
      }
    });

    await process.start();
    hasStarted = true;
    return process;
  }

  private async handleProcessFailure(slotId: ProcessId): Promise<void> {
    const slot = this.slots.get(slotId);
    if (!slot) return; // already retired, e.g. by shutdown

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
    await this.restartLoop(slotId, slot);
  }

  /**
   * Keep trying to bring the slot back up until the budget says stop. A
   * failed re-init (`createSupervisedProcess` rejecting) is just another
   * failure of the same child: it counts against the same budget and is
   * retried with the same backoff, instead of ending supervision after a
   * single `supervisor:restart:failed` the way it used to.
   *
   * With no `maxRestarts` the budget never says stop, and that is honoured:
   * "no limit" is what the strategy declares, so the loop backs off along the
   * curve for as long as re-init keeps failing, bounded only by `backoff.max`.
   * Ending it after some number of tries would retire a child the caller
   * asked to have restarted without limit, on a limit nobody configured. What
   * it may not do is spin: a failed re-init always waits at least
   * `MIN_REINIT_RETRY_DELAY`, whatever the curve says.
   */
  private async restartLoop(slotId: ProcessId, slot: Slot): Promise<void> {
    const failedIncarnationId = slot.ref.current.id;
    let reinitFailed = false;

    while (true) {
      const decision = this.decideRestart(slotId);
      if (decision.kind === "declined") {
        this.retireSlot(slotId);
        this.emitDeclinedRestart(slotId, decision);
        return;
      }

      const delay = this.restartDelay(decision.attempt, reinitFailed ? MIN_REINIT_RETRY_DELAY : ms(0));
      this.emit?.({
        type: "supervisor:restart",
        id: slotId,
        attempt: decision.attempt,
        delayMs: delay,
      });

      if (delay > 0) {
        await this.clock.sleep(delay);
      }

      // Shutdown, or the caller stopping the child through its ref, can land
      // inside that sleep. The restart was already decided and its budget
      // already spent, so returning here silently retired a child on a
      // decision that says the opposite: the one drop in this method that
      // left no trace of itself.
      const goneAfterSleep = this.whyNoLongerSupervised(slotId);
      if (goneAfterSleep) {
        this.retireSlot(slotId);
        this.emitDeclinedRestart(slotId, { kind: "declined", because: goneAfterSleep });
        return;
      }

      // Only the create is guarded. It is the one step whose failure means
      // "this incarnation would not start", which is what earns another
      // attempt. Anything else that throws (an emit sink, the clock, the
      // backoff arithmetic) is not a failed re-init: retrying would create a
      // second replacement while the first is still installed. Those leave
      // through `settleAfterFault` instead.
      let newProcess: ProcessRef<unknown>;
      try {
        newProcess = await this.createSupervisedProcess(slot.spec, slot.ctx, slotId);
      } catch (error) {
        this.emit?.({
          type: "supervisor:restart:failed",
          supervisorId: this.id,
          processId: slotId,
          error,
          timestamp: this.clock.now().wallMs,
        });
        reinitFailed = true;
        // Loop again: decideRestart runs once more and spends more of the
        // same budget, rather than ending supervision here.
        continue;
      }

      // The same two things can land while the replacement is starting. It is
      // unowned by then, and installing it would leave a running child that
      // nothing supervises and nothing will stop: stop it instead.
      const goneWhileStarting = this.whyNoLongerSupervised(slotId);
      if (goneWhileStarting) {
        await this.stopQuietly(slotId, newProcess);
        this.retireSlot(slotId);
        this.emitDeclinedRestart(slotId, { kind: "declined", because: goneWhileStarting });
        return;
      }

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
    }
  }

  /**
   * Something other than the guarded create threw while a failure was being
   * handled: a backoff computation, the clock, or an emit sink. Nothing is
   * dropped, and the slot ends in one of exactly two states.
   *
   * If a replacement had already been installed and is running, the child is
   * fine and stays supervised; the fault is reported on its own, as
   * `supervisor:restart:failed`. Otherwise nothing is running for the slot
   * and no restart is coming, so it is retired with a typed reason
   * (`supervisor-fault`) rather than left in `getChildren()` as a failed child
   * that is waiting for something that will not happen.
   *
   * The report goes through the same sink that may be the fault. If it throws
   * again there is no channel left to say so on, and the retired slot is the
   * record.
   */
  private settleAfterFault(slotId: ProcessId, error: unknown): void {
    const isRunning = this.slots.get(slotId)?.ref.status() === "running";
    if (!isRunning) this.retireSlot(slotId);

    try {
      this.emit?.(
        isRunning
          ? {
              type: "supervisor:restart:failed",
              supervisorId: this.id,
              processId: slotId,
              error,
              timestamp: this.clock.now().wallMs,
            }
          : {
              type: "supervisor:restart:abandoned",
              supervisorId: this.id,
              processId: slotId,
              because: "supervisor-fault",
              error,
              timestamp: this.clock.now().wallMs,
            },
      );
    } catch {
      // See above: the sink is what is broken.
    }
  }

  /** Stop a process, reporting a failed stop as an event instead of throwing it. */
  private async stopQuietly(slotId: ProcessId, process: ProcessRef<unknown>): Promise<void> {
    try {
      await process.stop();
    } catch (error) {
      this.emit?.({
        type: "supervisor:child:stop:error",
        supervisorId: this.id,
        processId: slotId,
        error,
        timestamp: this.clock.now().wallMs,
      });
    }
  }

  private retireSlot(slotId: ProcessId): void {
    this.slots.delete(slotId);
    this.restartWindows.delete(slotId);
    this.unwindowedAttempts.delete(slotId);
    // restartCounts is intentionally NOT cleared: it is the final tally a
    // caller can still read (via the slot id it already holds) after giveup.
  }
}

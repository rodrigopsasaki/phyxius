import type {
  ProcessSpec,
  ProcessRef,
  ProcessId,
  ProcessStatus,
  StopReason,
  Tools,
  ScheduledMessage,
  EmitFn,
} from "./types.js";
import type { Clock, Millis } from "@phyxiusjs/clock";
import { Mailbox } from "./mailbox.js";
import {
  emitProcessStarting,
  emitProcessStart,
  emitProcessStarted,
  emitProcessStopping,
  emitProcessStopped,
  emitProcessStop,
  emitProcessFail,
  emitMessageQueued,
  emitMessageProcessing,
  emitMessageProcessed,
  emitMessageStart,
  emitMessageEnd,
  emitMessageError,
} from "./events.js";
import { TimeoutError, ProcessError } from "./types.js";
import { createProcessId } from "./process-id.js";

interface PendingAsk<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  cancelled: boolean;
}

export class ProcessImpl<TMsg, TState, TCtx> implements ProcessRef<TMsg> {
  readonly id: ProcessId;
  private _status: ProcessStatus = "starting";
  private processState: TState | undefined;
  private readonly mailbox: Mailbox<TMsg>;
  private readonly scheduledMessages = new Map<string, ScheduledMessage<TMsg>>();
  private readonly pendingAsks = new Map<string, PendingAsk<unknown>>();
  private nextScheduleId = 0;
  private nextAskId = 0;
  private isProcessing = false;
  private shouldStop = false;
  private startedAt = 0;
  private lastError?: Error;

  constructor(
    private readonly spec: ProcessSpec<TMsg, TState, TCtx>,
    private readonly ctx: TCtx,
    private readonly clock: Clock,
    private readonly emit?: EmitFn,
    id?: ProcessId,
  ) {
    this.id = id ?? createProcessId();
    const maxInbox = spec.maxInbox ?? 1024;
    const policy = spec.mailboxPolicy ?? "reject";
    this.mailbox = new Mailbox(maxInbox, { type: policy }, this.id, emit);
  }

  async start(): Promise<void> {
    if (this._status !== "starting") {
      throw new ProcessError(`Cannot start process in state: ${this._status}`, this.id);
    }

    emitProcessStarting(this.emit, this.spec.name, this.id);
    emitProcessStart(this.emit, this.spec.name, this.id);

    try {
      this.startedAt = this.clock.now().wallMs;
      if (this.spec.init) {
        this.processState = await this.spec.init(this.ctx);
      }
      this._status = "running";
      emitProcessStarted(this.emit, this.id, this.startedAt);
      this.startMessagePump();
    } catch (error) {
      this._status = "failed";
      this.lastError = error instanceof Error ? error : new Error(String(error));
      emitProcessFail(this.emit, this.id, error);
      throw error;
    }
  }

  async send(msg: TMsg): Promise<boolean> {
    if (this._status !== "running") {
      throw new ProcessError(`Cannot send message to process in state: ${this._status}`, this.id);
    }
    const success = this.mailbox.enqueue(msg, this.clock.now().wallMs);
    if (success) {
      const msgType = this.msgTypeOf(msg);
      const seq = this.mailbox.size();
      emitMessageQueued(this.emit, this.id, msgType, seq, this.clock.now().wallMs);

      if (!this.isProcessing) {
        this.startMessagePump();
      }
    }
    return success;
  }

  async stop(reason: StopReason = "normal"): Promise<void> {
    if (this._status === "stopped" || this._status === "stopping") return;

    this.shouldStop = true;
    this._status = "stopping";
    emitProcessStopping(this.emit, this.id, reason);
    this.cancelAll();

    while (this.isProcessing) {
      await this.clock.sleep(1 as Millis);
    }

    if (this.spec.onStop) {
      try {
        await this.spec.onStop(this.getProcessState(), reason, this.ctx);
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this._status = "failed";
        emitProcessFail(this.emit, this.id, error);
        throw error;
      }
    }

    this._status = "stopped";
    emitProcessStopped(this.emit, this.id, reason);
    emitProcessStop(this.emit, this.id, reason);
  }

  async ask<TResp>(build: (reply: (r: TResp) => void) => TMsg, timeout: Millis = 5000 as Millis): Promise<TResp> {
    return new Promise<TResp>((resolve, reject) => {
      const askId = `ask-${this.nextAskId++}`;

      // Timer fires at most once; completion path clears the pending ask.
      this.clock.sleep(timeout).then(() => {
        const ask = this.pendingAsks.get(askId);
        if (ask && !ask.cancelled) {
          this.pendingAsks.delete(askId);
          reject(new TimeoutError(`Ask timeout after ${timeout}ms`));
        }
      });

      const reply = (response: TResp) => {
        const ask = this.pendingAsks.get(askId);
        if (ask && !ask.cancelled) {
          this.pendingAsks.delete(askId);
          resolve(response);
        }
      };

      this.pendingAsks.set(askId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cancelled: false,
      });

      const msg = build(reply);
      this.send(msg).catch((error) => {
        this.pendingAsks.delete(askId);
        reject(error);
      });
    });
  }

  status(): ProcessStatus {
    return this._status;
  }

  get state(): ProcessStatus {
    return this._status;
  }

  getInfo(): { id: ProcessId; state: ProcessStatus; startedAt: number; lastError?: Error } {
    const info: { id: ProcessId; state: ProcessStatus; startedAt: number; lastError?: Error } = {
      id: this.id,
      state: this._status,
      startedAt: this.startedAt,
    };
    if (this.lastError) {
      info.lastError = this.lastError;
    }
    return info;
  }

  private startMessagePump(): void {
    if (this.isProcessing || this.shouldStop || this._status !== "running") return;
    if (this.mailbox.isEmpty()) return;
    this.isProcessing = true;
    this.clock.sleep(0 as Millis).then(() => this.processNext());
  }

  private processNext(): void {
    if (this.shouldStop || this._status !== "running") {
      this.isProcessing = false;
      return;
    }

    const item = this.mailbox.dequeue();
    if (!item) {
      this.isProcessing = false;
      return;
    }

    const { msg, seq } = item;
    const msgType = this.msgTypeOf(msg);
    const startTime = this.clock.now().wallMs;

    emitMessageProcessing(this.emit, this.id, msgType, seq, startTime);
    emitMessageStart(this.emit, this.id, msgType, seq, startTime);

    const tools: Tools<TMsg> = {
      clock: this.clock,
      ...(this.emit ? { emit: this.emit } : {}),
      schedule: (after: Millis, scheduledMsg: TMsg) => this.scheduleMessage(after, scheduledMsg),
    };

    try {
      const newStateOrPromise = this.spec.handle(this.getProcessState(), msg, tools);

      Promise.resolve(newStateOrPromise)
        .then((nextState) => {
          // `void`/`undefined` return means "keep state."
          if (nextState !== undefined) {
            this.processState = nextState as TState;
          }
          const duration = this.clock.now().wallMs - startTime;
          emitMessageProcessed(this.emit, this.id, msgType, seq, duration);
          emitMessageEnd(this.emit, this.id, msgType, seq, duration);
          this.clock.sleep(0 as Millis).then(() => this.processNext());
        })
        .catch((error) => {
          this.lastError = error instanceof Error ? error : new Error(String(error));
          emitMessageError(this.emit, this.id, msgType, seq, error);
          this._status = "failed";
          this.isProcessing = false;
          emitProcessFail(this.emit, this.id, error);
        });
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      emitMessageError(this.emit, this.id, msgType, seq, error);
      this._status = "failed";
      this.isProcessing = false;
      emitProcessFail(this.emit, this.id, error);
    }
  }

  /**
   * Schedule a message-to-self. Each scheduled message is backed by its own
   * Clock-based timer — the pump does NOT need to be alive for the timer
   * to fire. When the delay elapses, the message is enqueued and the pump
   * is woken up. Cancellation (e.g. from `stop`) flips the `cancelled` flag
   * so in-flight timers no-op on fire.
   */
  private scheduleMessage(after: Millis, msg: TMsg): void {
    const id = `sched-${this.nextScheduleId++}`;
    const scheduled: ScheduledMessage<TMsg> = {
      id,
      fireAt: this.clock.now().wallMs + after,
      msg,
      cancelled: false,
    };
    this.scheduledMessages.set(id, scheduled);

    this.clock.sleep(after).then(() => {
      if (scheduled.cancelled) return;
      this.scheduledMessages.delete(id);
      if (this._status !== "running") return;

      this.mailbox.enqueue(msg, this.clock.now().wallMs);
      if (!this.isProcessing) {
        this.startMessagePump();
      }
    });
  }

  private getProcessState(): TState {
    return this.processState as TState;
  }

  private cancelAll(): void {
    this.scheduledMessages.forEach((s) => (s.cancelled = true));
    this.scheduledMessages.clear();
    this.pendingAsks.forEach((ask) => {
      ask.cancelled = true;
      ask.reject(new Error("Process stopping"));
    });
    this.pendingAsks.clear();
  }

  private msgTypeOf(msg: TMsg): string {
    const value: unknown = msg;
    if (value && typeof value === "object" && "type" in value && typeof value.type === "string") {
      return value.type;
    }
    return value?.constructor?.name ?? "unknown";
  }
}

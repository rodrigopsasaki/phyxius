import type {
  ProcessSpec,
  ProcessRef,
  ProcessId,
  ProcessStatus,
  StopReason,
  Tools,
  ScheduledMessage,
  PendingAsk,
  EmitFn,
} from "./types.js";
import type { Clock, Millis } from "@phyxius/clock";
import { Mailbox } from "./mailbox.js";
import {
  emitProcessStart,
  emitProcessReady,
  emitProcessStop,
  emitProcessFail,
  emitMessageStart,
  emitMessageEnd,
  emitMessageError,
} from "./events.js";
import { TimeoutError, ProcessError } from "./types.js";

export function createProcessId(): ProcessId {
  return crypto.randomUUID() as ProcessId;
}

export class ProcessImpl<TMsg, TState, TCtx> implements ProcessRef<TMsg> {
  readonly id: ProcessId = createProcessId();
  private _status: ProcessStatus = "starting";
  private state: TState | undefined;
  private readonly mailbox: Mailbox<TMsg>;
  private readonly scheduledMessages = new Map<string, ScheduledMessage<TMsg>>();
  private readonly pendingAsks = new Map<string, PendingAsk<unknown>>();
  private nextScheduleId = 0;
  private nextAskId = 0;
  private isProcessing = false;
  private shouldStop = false;

  constructor(
    private readonly spec: ProcessSpec<TMsg, TState, TCtx>,
    private readonly ctx: TCtx,
    private readonly clock: Clock,
    private readonly emit?: EmitFn,
  ) {
    const maxInbox = spec.maxInbox ?? 1024;
    const policy = spec.mailboxPolicy ?? "reject";
    this.mailbox = new Mailbox(maxInbox, { type: policy }, this.id, emit);
  }

  async start(): Promise<void> {
    if (this._status !== "starting") throw new ProcessError(`Process ${this.id} already started`, this.id);

    emitProcessStart(this.emit, this.spec.name, this.id);
    try {
      this.state = await this.spec.init(this.ctx);
      this._status = "running";
      emitProcessReady(this.emit, this.id, this.clock.now().wallMs);
      this.pump();
    } catch (error) {
      this._status = "failed";
      emitProcessFail(this.emit, this.id, error);
      throw error;
    }
  }

  send(msg: TMsg): boolean {
    if (this._status !== "running") return false;
    const success = this.mailbox.enqueue(msg, this.clock.now().wallMs);
    if (success && !this.isProcessing) {
      this.clock.timeout(0 as Millis).then(() => this.pump());
    }
    return success;
  }

  async stop(reason: StopReason = "normal"): Promise<void> {
    if (this._status === "stopped" || this._status === "stopping") return;

    this.shouldStop = true;
    this._status = "stopping";
    this.cancelAll();

    while (this.isProcessing) {
      await this.clock.timeout(1 as Millis);
    }

    if (this.spec.onStop && this.state !== undefined) {
      try {
        await this.spec.onStop(this.state, reason, this.ctx);
      } catch (error) {
        emitProcessFail(this.emit, this.id, error);
      }
    }

    this._status = "stopped";
    emitProcessStop(this.emit, this.id, reason);
  }

  async ask<TResp>(build: (reply: (r: TResp) => void) => TMsg, timeout = 5000 as Millis): Promise<TResp> {
    return new Promise((resolve, reject) => {
      const askId = `ask-${this.nextAskId++}`;
      const timeoutAt = this.clock.now().wallMs + timeout;

      // Set up timeout using clock.timeout
      this.clock.timeout(timeout).then(() => {
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

      this.pendingAsks.set(askId, { id: askId, resolve, reject, timeout: timeoutAt, cancelled: false });

      const msg = build(reply);
      if (!this.send(msg)) {
        this.pendingAsks.delete(askId);
        reject(new ProcessError("Failed to send ask message", this.id));
      }
    });
  }

  status(): ProcessStatus {
    return this._status;
  }

  private pump(): void {
    if (this.isProcessing || this.shouldStop || this._status !== "running") return;
    this.isProcessing = true;
    this.processNext();
  }

  private processNext(): void {
    if (this.shouldStop || this._status !== "running") {
      this.isProcessing = false;
      return;
    }

    this.processScheduledMessages();
    const item = this.mailbox.dequeue();
    if (!item) {
      this.isProcessing = false;
      return;
    }

    const { msg, seq } = item;
    const msgType = msg?.constructor?.name || "unknown";
    const startTime = this.clock.now().wallMs;

    emitMessageStart(this.emit, this.id, msgType, seq, startTime);

    try {
      const tools: Tools<TState, TMsg, TCtx> = {
        clock: this.clock,
        ...(this.emit ? { emit: this.emit } : {}),
        ctx: this.ctx,
        spawn: () => {
          throw new Error("spawn not implemented");
        },
        ask: <T>(
          desc: string,
          f: (res: (value: T) => void, rej: (e: unknown) => void) => void,
          timeout?: Millis,
        ): Promise<T> => {
          return new Promise((resolve, reject) => {
            const askTimeout = timeout ?? (5000 as Millis);
            let completed = false;

            this.clock.timeout(askTimeout).then(() => {
              if (!completed) {
                completed = true;
                reject(new TimeoutError(`Ask '${desc}' timeout`));
              }
            });

            f(
              (value: T) => {
                if (!completed) {
                  completed = true;
                  resolve(value);
                }
              },
              (error: unknown) => {
                if (!completed) {
                  completed = true;
                  reject(error);
                }
              },
            );
          });
        },
        schedule: (after: Millis, msg: TMsg) => this.scheduleMessage(after, msg),
      };

      const newStateOrPromise = this.spec.handle(this.state!, msg, tools);

      Promise.resolve(newStateOrPromise)
        .then((newState) => {
          this.state = newState;
          const duration = this.clock.now().wallMs - startTime;
          emitMessageEnd(this.emit, this.id, msgType, seq, duration);
          this.clock.timeout(0 as Millis).then(() => this.processNext());
        })
        .catch((error) => {
          emitMessageError(this.emit, this.id, msgType, seq, error);
          this._status = "failed";
          this.isProcessing = false;
          emitProcessFail(this.emit, this.id, error);
        });
    } catch (error) {
      emitMessageError(this.emit, this.id, msgType, seq, error);
      this._status = "failed";
      this.isProcessing = false;
      emitProcessFail(this.emit, this.id, error);
    }
  }

  private scheduleMessage(after: Millis, msg: TMsg): void {
    const id = `sched-${this.nextScheduleId++}`;
    this.scheduledMessages.set(id, {
      id,
      fireAt: this.clock.now().wallMs + after,
      msg,
      cancelled: false,
    });
  }

  private processScheduledMessages(): void {
    const now = this.clock.now().wallMs;
    for (const [id, scheduled] of [...this.scheduledMessages]) {
      if (!scheduled.cancelled && scheduled.fireAt <= now) {
        this.scheduledMessages.delete(id);
        this.mailbox.enqueue(scheduled.msg, now);
      }
    }
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
}

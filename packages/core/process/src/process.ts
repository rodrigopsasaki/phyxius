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
import { createProcessId as createId } from "./process-id.js";

// Use the createProcessId from process-id.ts instead of this one

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
  private restartCount = 0;
  private lastError?: Error;

  constructor(
    private readonly spec: ProcessSpec<TMsg, TState, TCtx>,
    private readonly ctx: TCtx,
    private readonly clock: Clock,
    private readonly emit?: EmitFn,
    id?: ProcessId,
  ) {
    this.id = id || createId();
    const maxInbox = spec.maxInbox ?? 1024;
    const policy = spec.mailboxPolicy ?? "reject";
    this.mailbox = new Mailbox(maxInbox, { type: policy }, this.id, emit);
  }

  async start(): Promise<void> {
    if (this._status !== "starting") throw new ProcessError(`Cannot start process in state: ${this._status}`, this.id);

    emitProcessStarting(this.emit, this.spec.name, this.id);
    emitProcessStart(this.emit, this.spec.name, this.id);
    try {
      this.startedAt = this.clock.now().wallMs;
      if (this.spec.init) {
        this.processState = await this.spec.init(this.ctx);
      }
      this._status = "running";
      emitProcessStarted(this.emit, this.id, this.startedAt);
      // Start message processing asynchronously
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
      const msgType = msg?.constructor?.name || "unknown";
      const seq = this.mailbox.size(); // Approximate sequence number
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
      await this.clock.timeout(1 as Millis);
    }

    if (this.spec.onStop) {
      try {
        await this.spec.onStop(this.processState!, reason, this.ctx);
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

      this.pendingAsks.set(askId, {
        id: askId,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutAt,
        cancelled: false,
      });

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

  get state(): ProcessStatus {
    return this._status;
  }

  getInfo() {
    const info: {
      id: ProcessId;
      state: ProcessStatus;
      startedAt: number;
      restartCount: number;
      lastError?: Error;
    } = {
      id: this.id,
      state: this._status,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
    };

    if (this.lastError) {
      info.lastError = this.lastError;
    }

    return info;
  }

  private startMessagePump(): void {
    if (this.isProcessing || this.shouldStop || this._status !== "running") return;
    this.isProcessing = true;
    // Schedule processing on next tick to avoid blocking
    this.clock.timeout(0 as Millis).then(() => this.processNext());
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

    emitMessageProcessing(this.emit, this.id, msgType, seq, startTime);
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

      const newStateOrPromise = this.spec.handle(this.processState!, msg, tools);

      Promise.resolve(newStateOrPromise)
        .then((newState) => {
          this.processState = newState;
          const duration = this.clock.now().wallMs - startTime;
          emitMessageProcessed(this.emit, this.id, msgType, seq, duration);
          emitMessageEnd(this.emit, this.id, msgType, seq, duration);
          // Continue processing more messages
          this.clock.timeout(0 as Millis).then(() => this.processNext());
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

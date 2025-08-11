import type { Process, ProcessBehavior, ProcessId, ProcessState, ProcessInfo, Message, EmitFn } from "./types.js";
import { createProcessId } from "./process-id.js";

export class ProcessImpl implements Process {
  readonly id: ProcessId;
  private _state: ProcessState = "starting";
  private readonly behavior: ProcessBehavior;
  private readonly messageQueue: Message[] = [];
  private readonly emit: EmitFn | undefined;
  private processing = false;
  private startedAt = 0;
  private restartCount = 0;
  private lastError: Error | undefined;

  constructor(behavior: ProcessBehavior, options?: { id?: ProcessId; emit?: EmitFn }) {
    this.id = options?.id ?? createProcessId();
    this.behavior = behavior;
    this.emit = options?.emit;
  }

  get state(): ProcessState {
    return this._state;
  }

  async start(): Promise<void> {
    if (this._state !== "starting") {
      throw new Error(`Cannot start process in state: ${this._state}`);
    }

    this.startedAt = Date.now();
    this.emit?.({
      type: "process:starting",
      processId: this.id.value,
      timestamp: this.startedAt,
    });

    try {
      if (this.behavior.init) {
        await this.behavior.init();
      }

      this._state = "running";
      this.emit?.({
        type: "process:started",
        processId: this.id.value,
        timestamp: Date.now(),
      });

      // Start processing messages
      this.processMessages();
    } catch (error) {
      this._state = "failed";
      this.lastError = error instanceof Error ? error : new Error(String(error));

      this.emit?.({
        type: "process:failed",
        processId: this.id.value,
        error: this.lastError,
        timestamp: Date.now(),
      });

      throw this.lastError;
    }
  }

  async send(message: Message): Promise<void> {
    if (this._state !== "running") {
      throw new Error(`Cannot send message to process in state: ${this._state}`);
    }

    this.messageQueue.push(message);
    this.emit?.({
      type: "process:message:queued",
      processId: this.id.value,
      queueSize: this.messageQueue.length,
      timestamp: Date.now(),
    });

    // Trigger message processing if not already processing
    if (!this.processing) {
      setImmediate(() => this.processMessages());
    }
  }

  async stop(): Promise<void> {
    if (this._state === "stopped" || this._state === "stopping") {
      return;
    }

    this._state = "stopping";
    this.emit?.({
      type: "process:stopping",
      processId: this.id.value,
      timestamp: Date.now(),
    });

    try {
      // Wait for current message processing to complete
      while (this.processing) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Call terminate if available
      if (this.behavior.terminate) {
        await this.behavior.terminate();
      }

      this._state = "stopped";
      this.emit?.({
        type: "process:stopped",
        processId: this.id.value,
        timestamp: Date.now(),
      });
    } catch (error) {
      this._state = "failed";
      this.lastError = error instanceof Error ? error : new Error(String(error));

      this.emit?.({
        type: "process:failed",
        processId: this.id.value,
        error: this.lastError,
        timestamp: Date.now(),
      });

      throw this.lastError;
    }
  }

  getInfo(): ProcessInfo {
    return {
      id: this.id,
      state: this._state,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      lastError: this.lastError,
    };
  }

  async restart(): Promise<void> {
    this.restartCount++;
    this.lastError = undefined;

    this.emit?.({
      type: "process:restarting",
      processId: this.id.value,
      restartCount: this.restartCount,
      timestamp: Date.now(),
    });

    // Reset state and restart
    this._state = "starting";
    await this.start();
  }

  private async processMessages(): Promise<void> {
    if (this.processing || this._state !== "running") {
      return;
    }

    this.processing = true;

    try {
      while (this.messageQueue.length > 0 && this._state === "running") {
        const message = this.messageQueue.shift()!;

        this.emit?.({
          type: "process:message:processing",
          processId: this.id.value,
          timestamp: Date.now(),
        });

        try {
          await this.behavior.handle(message);

          this.emit?.({
            type: "process:message:processed",
            processId: this.id.value,
            timestamp: Date.now(),
          });
        } catch (error) {
          const processError = error instanceof Error ? error : new Error(String(error));
          this.lastError = processError;

          this.emit?.({
            type: "process:message:error",
            processId: this.id.value,
            error: processError,
            timestamp: Date.now(),
          });

          // Mark as failed but don't throw - let supervisor handle it
          this._state = "failed";
          break;
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

import type { Supervisor, Process, ProcessBehavior, ProcessId, Message, SupervisionStrategy, EmitFn } from "./types.js";
import { createProcessId } from "./process-id.js";
import { ProcessImpl } from "./process.js";

interface SupervisedProcess {
  process: Process;
  strategy: SupervisionStrategy;
}

export class SupervisorImpl implements Supervisor {
  readonly id: ProcessId;
  private readonly children = new Map<string, SupervisedProcess>();
  private readonly emit: EmitFn | undefined;
  private stopped = false;

  constructor(options?: { id?: ProcessId; emit?: EmitFn }) {
    this.id = options?.id ?? createProcessId();
    this.emit = options?.emit;

    this.emit?.({
      type: "supervisor:created",
      supervisorId: this.id.value,
      timestamp: Date.now(),
    });
  }

  async spawn<T extends Message = Message>(behavior: ProcessBehavior<T>): Promise<Process> {
    if (this.stopped) {
      throw new Error("Cannot spawn process: supervisor is stopped");
    }

    const process = new ProcessImpl(behavior, this.emit ? { emit: this.emit } : {});

    this.emit?.({
      type: "supervisor:spawning",
      supervisorId: this.id.value,
      processId: process.id.value,
      timestamp: Date.now(),
    });

    try {
      await process.start();

      // Default supervision strategy
      this.supervise(process, "restart");

      this.emit?.({
        type: "supervisor:spawned",
        supervisorId: this.id.value,
        processId: process.id.value,
        timestamp: Date.now(),
      });

      return process;
    } catch (error) {
      this.emit?.({
        type: "supervisor:spawn:failed",
        supervisorId: this.id.value,
        processId: process.id.value,
        error,
        timestamp: Date.now(),
      });

      throw error;
    }
  }

  supervise(process: Process, strategy: SupervisionStrategy): void {
    this.children.set(process.id.value, { process, strategy });

    this.emit?.({
      type: "supervisor:supervising",
      supervisorId: this.id.value,
      processId: process.id.value,
      strategy,
      timestamp: Date.now(),
    });

    // Monitor the process
    this.monitorProcess(process, strategy);
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    this.emit?.({
      type: "supervisor:stopping",
      supervisorId: this.id.value,
      childCount: this.children.size,
      timestamp: Date.now(),
    });

    // Stop all children
    const stopPromises = Array.from(this.children.values()).map(async ({ process }) => {
      try {
        await process.stop();
      } catch (error) {
        // Log error but continue stopping other processes
        this.emit?.({
          type: "supervisor:child:stop:error",
          supervisorId: this.id.value,
          processId: process.id.value,
          error,
          timestamp: Date.now(),
        });
      }
    });

    await Promise.all(stopPromises);
    this.children.clear();

    this.emit?.({
      type: "supervisor:stopped",
      supervisorId: this.id.value,
      timestamp: Date.now(),
    });
  }

  getChildren(): Process[] {
    return Array.from(this.children.values()).map(({ process }) => process);
  }

  private async monitorProcess(process: Process, strategy: SupervisionStrategy): Promise<void> {
    // Simple monitoring - in a real implementation, this would be more sophisticated
    const checkInterval = setInterval(async () => {
      if (this.stopped || !this.children.has(process.id.value)) {
        clearInterval(checkInterval);
        return;
      }

      const info = process.getInfo();

      if (info.state === "failed") {
        clearInterval(checkInterval);
        await this.handleFailedProcess(process, strategy);
      }
    }, 100); // Check every 100ms
  }

  private async handleFailedProcess(process: Process, strategy: SupervisionStrategy): Promise<void> {
    this.emit?.({
      type: "supervisor:child:failed",
      supervisorId: this.id.value,
      processId: process.id.value,
      strategy,
      timestamp: Date.now(),
    });

    switch (strategy) {
      case "restart":
        try {
          if (process instanceof ProcessImpl) {
            await process.restart();

            this.emit?.({
              type: "supervisor:child:restarted",
              supervisorId: this.id.value,
              processId: process.id.value,
              timestamp: Date.now(),
            });

            // Resume monitoring
            this.monitorProcess(process, strategy);
          }
        } catch (error) {
          // If restart fails, remove from supervision
          this.children.delete(process.id.value);

          this.emit?.({
            type: "supervisor:child:restart:failed",
            supervisorId: this.id.value,
            processId: process.id.value,
            error,
            timestamp: Date.now(),
          });
        }
        break;

      case "stop":
        this.children.delete(process.id.value);
        try {
          await process.stop();
        } catch {
          // Ignore stop errors
        }

        this.emit?.({
          type: "supervisor:child:stopped",
          supervisorId: this.id.value,
          processId: process.id.value,
          timestamp: Date.now(),
        });
        break;

      case "escalate":
        // Remove from supervision and escalate to parent supervisor
        this.children.delete(process.id.value);

        this.emit?.({
          type: "supervisor:escalate",
          supervisorId: this.id.value,
          processId: process.id.value,
          error: process.getInfo().lastError,
          timestamp: Date.now(),
        });

        // In a full implementation, this would notify a parent supervisor
        break;
    }
  }
}

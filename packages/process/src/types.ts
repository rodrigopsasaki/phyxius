export interface EmitFn {
  (event: Record<string, unknown>): void;
}

export type Message = Record<string, unknown>;

export interface ProcessId {
  readonly value: string;
}

export type ProcessState = "starting" | "running" | "stopping" | "stopped" | "failed";

export type SupervisionStrategy = "restart" | "stop" | "escalate";

export interface ProcessInfo {
  readonly id: ProcessId;
  readonly state: ProcessState;
  readonly startedAt: number;
  readonly restartCount: number;
  readonly lastError: Error | undefined;
}

export interface ProcessBehavior<T extends Message = Message> {
  init?(): Promise<void>;
  handle(message: T): Promise<void>;
  terminate?(): Promise<void>;
}

export interface Process {
  readonly id: ProcessId;
  readonly state: ProcessState;
  send(message: Message): Promise<void>;
  stop(): Promise<void>;
  getInfo(): ProcessInfo;
}

export interface Supervisor {
  readonly id: ProcessId;
  spawn<T extends Message = Message>(behavior: ProcessBehavior<T>): Promise<Process>;
  supervise(process: Process, strategy: SupervisionStrategy): void;
  stop(): Promise<void>;
  getChildren(): Process[];
}

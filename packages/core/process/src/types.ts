import type { Clock, Millis } from "@phyxius/clock";

// Brands for type safety
export interface ProcessId {
  readonly value: string;
  toString(): string;
  equals(other: ProcessId): boolean;
}

// Basic message type for tests
export type Message = unknown;

// Simplified behavior interface for tests
export interface ProcessBehavior<TMsg = Message, TState = unknown, TCtx = unknown> {
  handle(
    state?: TState,
    msg?: TMsg,
    tools?: Tools<TState, TMsg, TCtx>,
  ): Promise<TState> | TState | Promise<void> | void;
  init?(ctx?: TCtx): Promise<TState> | TState;
  terminate?(state?: TState, reason?: StopReason, ctx?: TCtx): Promise<void> | void;
}

// Public types (6 types max per acceptance gate)
export interface ProcessSpec<TMsg, TState, TCtx = unknown> {
  name: string;
  init?(ctx: TCtx): Promise<TState> | TState;
  handle(state: TState, msg: TMsg, tools: Tools<TState, TMsg, TCtx>): Promise<TState> | TState;
  onStop?(state: TState, reason: StopReason, ctx: TCtx): Promise<void> | void;
  maxInbox?: number; // default 1024
  mailboxPolicy?: "reject" | "drop-oldest";
  supervision?: SupervisionStrategy; // default "none"
}

export interface Tools<TState, TMsg, TCtx> {
  clock: Clock;
  journal?: Journal;
  emit?: EmitFn;
  ctx: TCtx;
  spawn<TM, TS, TC>(spec: ProcessSpec<TM, TS, TC>, ctx: TC): ProcessRef<TM>;
  ask<T>(desc: string, f: (res: (value: T) => void, rej: (e: unknown) => void) => void, timeout?: Millis): Promise<T>;
  schedule(after: Millis, msg: TMsg): void;
  // State parameter is used for type safety with process handlers
  readonly __stateType?: TState;
}

export interface ProcessRef<TMsg> {
  id: ProcessId;
  state: ProcessStatus;
  send(msg: TMsg): Promise<boolean>;
  stop(reason?: StopReason): Promise<void>;
  ask<TResp>(build: (reply: (r: TResp) => void) => TMsg, timeout?: Millis): Promise<TResp>;
  status(): ProcessStatus;
  start(): Promise<void>;
  getInfo(): ProcessInfo;
}

export interface ProcessInfo {
  id: ProcessId;
  state: ProcessStatus;
  startedAt: number;
  restartCount: number;
  lastError?: Error;
}

export type StopReason = "normal" | "shutdown" | "error" | { type: "error"; error: unknown };

export type ProcessStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface SupervisionStrategy {
  type: "none" | "one-for-one";
  backoff?: { initial: Millis; max: Millis; factor: number; jitter?: number };
  maxRestarts?: { count: number; within: Millis };
}

export interface RootSupervisorOptions {
  clock: Clock;
  emit?: EmitFn;
  journal?: Journal;
}

// Internal types for implementation
export interface ProcessEvent {
  type: string;
  id?: ProcessId;
  name?: string;
  reason?: StopReason;
  error?: unknown;
  startedAt?: number;
  size?: number;
  policy?: "reject" | "drop-oldest";
  msgType?: string;
  seq?: number;
  at?: number;
  durationMs?: number;
  attempt?: number;
  delayMs?: number;
  attempts?: number;
  withinMs?: number;
  afterMs?: number;
  // Supervisor-specific fields
  supervisorId?: ProcessId;
  processId?: ProcessId;
  oldProcessId?: ProcessId;
  newProcessId?: ProcessId;
  strategy?: string;
  timestamp?: number;
}

export type EmitFn = (event: ProcessEvent) => void;

export interface Journal {
  append(entry: unknown): void;
}

export interface ScheduledMessage<TMsg> {
  id: string;
  fireAt: number;
  msg: TMsg;
  cancelled: boolean;
}

export interface PendingAsk<T> {
  id: string;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timeout: number;
  cancelled: boolean;
}

export interface MailboxItem<TMsg> {
  msg: TMsg;
  seq: number;
  enqueuedAt: number;
}

// Error types
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class ProcessError extends Error {
  constructor(
    message: string,
    public readonly processId: ProcessId,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

import type { Clock, Millis } from "@phyxiusjs/clock";

// ── Process identity ────────────────────────────────────────────────────────

export interface ProcessId {
  readonly value: string;
  toString(): string;
  equals(other: ProcessId): boolean;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export type ProcessStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export type StopReason = "normal" | "shutdown" | "error";

/**
 * Why a decided restart did not happen. A boolean could say only "not
 * restarting", never which of these it was, so two of the three left no
 * trace at all. `restart-budget-exhausted` keeps its own long-standing
 * `supervisor:giveup` event; the other two are why
 * `supervisor:restart:abandoned` exists.
 */
export type RestartDeclined = "strategy-none" | "supervisor-stopping" | "restart-budget-exhausted";

// ── Supervision ─────────────────────────────────────────────────────────────

export interface SupervisionStrategy {
  type: "none" | "one-for-one";
  backoff?: { initial: Millis; max: Millis; factor: number; jitter?: number };
  maxRestarts?: { count: number; within: Millis };
}

// ── Process spec (the only shape) ───────────────────────────────────────────

/**
 * Tools handed to the `handle` function. Intentionally narrow — anything an
 * actor can do to the outside world goes through here, so tests can inspect
 * and substitute. No hierarchical `spawn`: supervision is flat. No second
 * `ask`: callers use `ref.ask()` from outside and `tools.schedule` from inside.
 */
export interface Tools<TMsg> {
  /** Injected clock — no `Date.now()` inside handlers. */
  readonly clock: Clock;
  /** Optional structured event sink, forwarded from process construction. */
  readonly emit?: EmitFn;
  /** Schedule a message-to-self to be enqueued after `after` milliseconds. */
  schedule(after: Millis, msg: TMsg): void;
}

/**
 * The full behavior of a process. Immutable description; `spawn` materializes
 * a running instance.
 *
 * `handle` returns the next state (or `void`/`undefined` if the state is
 * unchanged). The signature is fixed — no arity dispatch, no "flexible"
 * variants. Tests that don't care about state should use `TState = void`.
 */
export interface ProcessSpec<TMsg, TState = void, TCtx = void> {
  /** Human-readable name for observability; appears in emitted events. */
  readonly name: string;
  /** Called once at spawn time. Receives the caller-provided ctx. */
  init?(ctx: TCtx): TState | Promise<TState>;
  /** Called per message. Return the next state (or void to keep current). */
  handle(state: TState, msg: TMsg, tools: Tools<TMsg>): TState | void | Promise<TState | void>;
  /** Called once when the process stops — normally, on shutdown, or on error. */
  onStop?(state: TState, reason: StopReason, ctx: TCtx): void | Promise<void>;
  /** Cap on the mailbox (default 1024). */
  maxInbox?: number;
  /** What to do when the mailbox is full (default "reject"). */
  mailboxPolicy?: "reject" | "drop-oldest";
}

// ── Process ref ─────────────────────────────────────────────────────────────

export interface ProcessRef<TMsg> {
  readonly id: ProcessId;
  /** Current lifecycle state. */
  status(): ProcessStatus;
  /** Enqueue a message. Rejects if the process isn't running. */
  send(msg: TMsg): Promise<boolean>;
  /**
   * Request/response against a running process. The `build` function receives
   * a `reply` callback and constructs the outgoing message. The returned
   * promise resolves when `reply` is called, or rejects on timeout.
   */
  ask<TResp>(build: (reply: (r: TResp) => void) => TMsg, timeout?: Millis): Promise<TResp>;
  /** Gracefully stop the process. Idempotent. */
  stop(reason?: StopReason): Promise<void>;
}

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * Out-of-band process events for the observability contract. State transitions
 * that a consumer would care about MUST produce an event here.
 */
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
  supervisorId?: ProcessId;
  processId?: ProcessId;
  oldProcessId?: ProcessId;
  newProcessId?: ProcessId;
  strategy?: string;
  because?: RestartDeclined;
  timestamp?: number;
}

export type EmitFn = (event: ProcessEvent) => void;

// ── Internal types (exported for tests) ────────────────────────────────────

export interface ScheduledMessage<TMsg> {
  id: string;
  fireAt: number;
  msg: TMsg;
  cancelled: boolean;
}

export interface MailboxItem<TMsg> {
  readonly msg: TMsg;
  readonly seq: number;
  readonly enqueuedAt: number;
}

// ── Errors ──────────────────────────────────────────────────────────────────

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

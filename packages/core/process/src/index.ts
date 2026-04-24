// ── Public API ──────────────────────────────────────────────────────────────

import type { Clock } from "@phyxiusjs/clock";
import type { EmitFn, ProcessId, ProcessRef, ProcessSpec } from "./types.js";
import { ProcessImpl } from "./process.js";

export type {
  ProcessSpec,
  ProcessRef,
  ProcessId,
  ProcessStatus,
  StopReason,
  Tools,
  SupervisionStrategy,
  ProcessEvent,
  EmitFn,
  ScheduledMessage,
  MailboxItem,
} from "./types.js";

export { createProcessId, ProcessIdImpl } from "./process-id.js";
export { ProcessImpl } from "./process.js";
export { Supervisor } from "./supervisor.js";
export { TimeoutError, ProcessError } from "./types.js";

// ── spawn ───────────────────────────────────────────────────────────────────

/**
 * Options for `spawn`. Clock is required (no `Date.now()` inside the
 * primitive); everything else is optional.
 *
 * `ctx` flows into `spec.init(ctx)` at startup. If your spec has no init, or
 * TCtx is `void`, you can omit it.
 */
export interface SpawnOptions<TCtx> {
  readonly clock: Clock;
  readonly ctx?: TCtx;
  readonly emit?: EmitFn;
  readonly id?: ProcessId;
}

/**
 * Materialize a ProcessSpec into a running, message-processing actor.
 *
 * The returned ref starts in state "running" — spawn awaits `spec.init`, so
 * init failures bubble up here. Subsequent lifecycle (send / ask / stop) is
 * safe to call on the ref.
 *
 * This is the only entry point. Supervised spawning goes through
 * `new Supervisor(...).spawn(spec, ctx)`.
 */
export async function spawn<TMsg, TState = void, TCtx = void>(
  spec: ProcessSpec<TMsg, TState, TCtx>,
  options: SpawnOptions<TCtx>,
): Promise<ProcessRef<TMsg>> {
  const process = new ProcessImpl(spec, options.ctx as TCtx, options.clock, options.emit, options.id);
  await process.start();
  return process;
}

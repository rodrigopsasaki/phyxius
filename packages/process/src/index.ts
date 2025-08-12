// Public API exports (≤12 exports total per acceptance gate)
export type { ProcessSpec, ProcessRef, ProcessId, StopReason, Tools, RootSupervisorOptions } from "./types.js";
export { createProcessId } from "./process.js";
export { Supervisor } from "./supervisor.js";
export { TimeoutError, ProcessError } from "./types.js";

import type { ProcessSpec, RootSupervisorOptions, ProcessRef } from "./types.js";
import type { Clock } from "@phyxius/clock";
import { ProcessImpl } from "./process.js";

// Spawn process function (public function)
export function spawn<TMsg, TState, TCtx = unknown>(
  spec: ProcessSpec<TMsg, TState, TCtx>,
  ctx: TCtx,
  clock: Clock,
): ProcessRef<TMsg> {
  const process = new ProcessImpl(spec, ctx, clock);
  process.start();
  return process;
}

// Root supervisor function (public function)
export function createRootSupervisor(options: RootSupervisorOptions) {
  return {
    spawn<TMsg, TState, TCtx = unknown>(spec: ProcessSpec<TMsg, TState, TCtx>, ctx: TCtx): ProcessRef<TMsg> {
      const process = new ProcessImpl(spec, ctx, options.clock, options.emit);
      process.start();
      return process;
    },
  };
}

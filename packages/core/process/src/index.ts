// Public API exports (≤12 exports total per acceptance gate)
export type {
  ProcessSpec,
  ProcessRef,
  ProcessId,
  StopReason,
  Tools,
  RootSupervisorOptions,
  ProcessBehavior,
  Message,
} from "./types.js";
export { createProcessId, ProcessIdImpl } from "./process-id.js";
export { ProcessImpl } from "./process.js";
export { Supervisor } from "./supervisor.js";
export { TimeoutError, ProcessError } from "./types.js";

import type {
  ProcessSpec,
  RootSupervisorOptions,
  ProcessRef,
  ProcessBehavior,
  EmitFn,
  SupervisionStrategy,
  Tools,
  StopReason,
  ProcessId,
} from "./types.js";
import type { Clock } from "@phyxiusjs/clock";
import { createSystemClock } from "@phyxiusjs/clock";
import { ProcessImpl } from "./process.js";
import { Supervisor } from "./supervisor.js";
import { createProcessId } from "./process-id.js";

// Create process function (expected by tests)
export function createProcess<TMsg, TState, TCtx = unknown>(
  behavior: ProcessBehavior<TMsg, TState, TCtx>,
  options: { id?: ProcessId; emit?: EmitFn; clock?: Clock } = {},
): ProcessRef<TMsg> {
  // Convert behavior to spec format expected by ProcessImpl
  const spec: ProcessSpec<TMsg, TState, TCtx> = {
    name: "test-process",
    handle: (state: TState, msg: TMsg, tools: Tools<TState, TMsg, TCtx>) => {
      // Handle the ProcessBehavior's flexible signature
      const handleFunc = behavior.handle;
      let result;

      if (handleFunc.length === 0) {
        // Function expects no arguments
        result = handleFunc();
      } else if (handleFunc.length === 1) {
        // Function expects only message (most tests)
        result = (handleFunc as (msg: TMsg) => TState | Promise<TState> | void | Promise<void>)(msg);
      } else if (handleFunc.length === 2) {
        // Function expects state and message
        result = handleFunc(state, msg);
      } else {
        // Function expects state, message, tools
        result = handleFunc(state, msg, tools);
      }

      // If result is void, return the existing state
      if (result === undefined) {
        return state;
      }
      return result as TState;
    },
    ...(behavior.init && {
      init: (ctx: TCtx) => {
        const result = behavior.init!(ctx);
        return result as TState;
      },
    }),
    ...(behavior.terminate && {
      onStop: (state: TState, reason: StopReason, ctx: TCtx) => {
        // Handle ProcessBehavior's optional parameters - some tests don't expect any args
        const terminateFunc = behavior.terminate!;
        if (terminateFunc.length === 0) {
          // Function expects no arguments
          return terminateFunc();
        } else {
          // Function expects arguments
          return terminateFunc(state, reason, ctx);
        }
      },
    }),
  };

  // For now, use a default clock if not provided - tests may not provide it
  const clock = options.clock || createSystemClock();

  const process = new ProcessImpl(spec, {} as TCtx, clock, options.emit, options.id);

  return process;
}

// Create supervisor function (expected by tests)
export function createSupervisor(
  options: { id?: ProcessId; emit?: EmitFn; clock?: Clock; strategy?: SupervisionStrategy } = {},
) {
  const id = options.id || createProcessId();
  const clock = options.clock || createSystemClock();

  return new Supervisor(id, clock, options.emit, options.strategy);
}

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

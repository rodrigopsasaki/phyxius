export type {
  EmitFn,
  Message,
  ProcessId,
  ProcessState,
  SupervisionStrategy,
  ProcessInfo,
  ProcessBehavior,
  Process,
  Supervisor,
} from "./types.js";

export { ProcessIdImpl, createProcessId } from "./process-id.js";
export { ProcessImpl } from "./process.js";
export { SupervisorImpl } from "./supervisor.js";

import { ProcessImpl } from "./process.js";
import { SupervisorImpl } from "./supervisor.js";
import type { ProcessBehavior, EmitFn, ProcessId, Message } from "./types.js";

export function createProcess<T extends Message = Message>(
  behavior: ProcessBehavior<T>,
  options?: { id?: ProcessId; emit?: EmitFn },
): ProcessImpl {
  return new ProcessImpl(behavior, options);
}

export function createSupervisor(options?: { id?: ProcessId; emit?: EmitFn }): SupervisorImpl {
  return new SupervisorImpl(options);
}

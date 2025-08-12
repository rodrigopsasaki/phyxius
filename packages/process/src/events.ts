import type { ProcessId, EmitFn, StopReason } from "./types.js";

export function emitProcessStart(emit: EmitFn | undefined, name: string, id: ProcessId): void {
  emit?.({
    type: "process:start",
    name,
    id,
  });
}

export function emitProcessReady(emit: EmitFn | undefined, id: ProcessId, startedAt: number): void {
  emit?.({
    type: "process:ready",
    id,
    startedAt,
  });
}

export function emitProcessStop(emit: EmitFn | undefined, id: ProcessId, reason: StopReason): void {
  emit?.({
    type: "process:stop",
    id,
    reason,
  });
}

export function emitProcessFail(emit: EmitFn | undefined, id: ProcessId, error: unknown): void {
  emit?.({
    type: "process:fail",
    id,
    error,
  });
}

export function emitMessageStart(
  emit: EmitFn | undefined,
  id: ProcessId,
  msgType: string,
  seq: number,
  at: number,
): void {
  emit?.({
    type: "process:msg:start",
    id,
    msgType,
    seq,
    at,
  });
}

export function emitMessageEnd(
  emit: EmitFn | undefined,
  id: ProcessId,
  msgType: string,
  seq: number,
  durationMs: number,
): void {
  emit?.({
    type: "process:msg:end",
    id,
    msgType,
    seq,
    durationMs,
  });
}

export function emitMessageError(
  emit: EmitFn | undefined,
  id: ProcessId,
  msgType: string,
  seq: number,
  error: unknown,
): void {
  emit?.({
    type: "process:msg:error",
    id,
    msgType,
    seq,
    error,
  });
}

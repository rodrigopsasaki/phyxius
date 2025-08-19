import type { ProcessId, EmitFn, StopReason } from "./types.js";

export function emitProcessStarting(emit: EmitFn | undefined, name: string, id: ProcessId): void {
  emit?.({
    type: "process:starting",
    name,
    id,
  });
}

export function emitProcessStart(emit: EmitFn | undefined, name: string, id: ProcessId): void {
  emit?.({
    type: "process:start",
    name,
    id,
  });
}

export function emitProcessStarted(emit: EmitFn | undefined, id: ProcessId, startedAt: number): void {
  emit?.({
    type: "process:started",
    id,
    startedAt,
  });
}

export function emitProcessStopping(emit: EmitFn | undefined, id: ProcessId, reason: StopReason): void {
  emit?.({
    type: "process:stopping",
    id,
    reason,
  });
}

export function emitProcessStopped(emit: EmitFn | undefined, id: ProcessId, reason: StopReason): void {
  emit?.({
    type: "process:stopped",
    id,
    reason,
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

export function emitMessageQueued(
  emit: EmitFn | undefined,
  id: ProcessId,
  msgType: string,
  seq: number,
  at: number,
): void {
  emit?.({
    type: "process:message:queued",
    id,
    msgType,
    seq,
    at,
  });
}

export function emitMessageProcessing(
  emit: EmitFn | undefined,
  id: ProcessId,
  msgType: string,
  seq: number,
  at: number,
): void {
  emit?.({
    type: "process:message:processing",
    id,
    msgType,
    seq,
    at,
  });
}

export function emitMessageProcessed(
  emit: EmitFn | undefined,
  id: ProcessId,
  msgType: string,
  seq: number,
  durationMs: number,
): void {
  emit?.({
    type: "process:message:processed",
    id,
    msgType,
    seq,
    durationMs,
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

import { randomUUID } from "node:crypto";
import type { ProcessId } from "./types.js";

export class ProcessIdImpl implements ProcessId {
  readonly value: string;

  constructor(value?: string) {
    this.value = value ?? randomUUID();
  }

  toString(): string {
    return this.value;
  }

  equals(other: ProcessId): boolean {
    return this.value === other.value;
  }
}

export function createProcessId(value?: string): ProcessId {
  return new ProcessIdImpl(value);
}

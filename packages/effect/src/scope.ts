import { randomUUID } from "node:crypto";
import type { Scope } from "./types.js";

export class ScopeImpl implements Scope {
  readonly id: string;
  readonly parentId: string | undefined;
  private cancelled = false;
  private readonly cancelCallbacks: (() => void)[] = [];

  constructor(parentId?: string) {
    this.id = randomUUID();
    this.parentId = parentId;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    if (this.cancelled) return;

    this.cancelled = true;

    for (const callback of this.cancelCallbacks) {
      try {
        callback();
      } catch {
        // Ignore callback errors during cancellation
      }
    }

    this.cancelCallbacks.length = 0;
  }

  onCancel(callback: () => void): void {
    if (this.cancelled) {
      callback();
    } else {
      this.cancelCallbacks.push(callback);
    }
  }
}

export function createScope(parentId?: string): Scope {
  return new ScopeImpl(parentId);
}

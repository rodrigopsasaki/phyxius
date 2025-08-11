import { randomUUID } from "node:crypto";

export interface CancelToken {
  id: string;
  isCanceled(): boolean;
  onCancel(cb: () => void): () => void;
  cancel(reason?: unknown): void;
}

class CancelTokenImpl implements CancelToken {
  readonly id: string;
  private canceled = false;
  private readonly callbacks: (() => void)[] = [];
  private readonly parent: CancelToken | undefined;
  private parentUnsubscribe: (() => void) | undefined = undefined;

  constructor(parent?: CancelToken) {
    this.id = randomUUID();
    this.parent = parent;

    if (parent) {
      this.parentUnsubscribe = parent.onCancel(() => {
        this.cancel(this.parent?.isCanceled() ? "parent-canceled" : undefined);
      });
    }
  }

  isCanceled(): boolean {
    return this.canceled;
  }

  onCancel(cb: () => void): () => void {
    if (this.canceled) {
      // Already canceled, fire immediately
      cb();
      return () => {}; // No-op unsubscribe
    }

    this.callbacks.push(cb);

    return () => {
      const index = this.callbacks.indexOf(cb);
      if (index !== -1) {
        this.callbacks.splice(index, 1);
      }
    };
  }

  cancel(_reason?: unknown): void {
    if (this.canceled) return; // Already canceled

    this.canceled = true;
    // Store reason if needed in future

    // Fire all callbacks exactly once
    const callbacks = [...this.callbacks];
    this.callbacks.length = 0;

    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // Ignore callback errors during cancellation
      }
    }

    // Clean up parent subscription
    if (this.parentUnsubscribe) {
      this.parentUnsubscribe();
      this.parentUnsubscribe = undefined as (() => void) | undefined;
    }
  }
}

export function createCancelToken(parent?: CancelToken): CancelToken {
  return new CancelTokenImpl(parent);
}

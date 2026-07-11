import type { MailboxItem, ProcessId, EmitFn } from "./types.js";

export interface MailboxPolicy {
  type: "reject" | "drop-oldest";
}

export class Mailbox<TMsg> {
  private readonly items: MailboxItem<TMsg>[] = [];
  private readonly maxSize: number;
  private readonly policy: MailboxPolicy;
  private readonly processId: ProcessId;
  private readonly emit?: EmitFn;
  private nextSeq = 0;

  constructor(maxSize: number, policy: MailboxPolicy, processId: ProcessId, emit?: EmitFn) {
    this.maxSize = maxSize;
    this.policy = policy;
    this.processId = processId;
    if (emit) {
      this.emit = emit;
    }
  }

  enqueue(msg: TMsg, enqueuedAt: number): boolean {
    const seq = this.nextSeq++;

    if (this.items.length >= this.maxSize) {
      this.emit?.({
        type: "process:mailbox:full",
        id: this.processId,
        policy: this.policy.type,
        size: this.items.length,
      });

      if (this.policy.type === "reject") {
        return false;
      }

      if (this.policy.type === "drop-oldest") {
        // Remove the oldest message
        this.items.shift();
      }
    }

    const item: MailboxItem<TMsg> = {
      msg,
      seq,
      enqueuedAt,
    };

    this.items.push(item);

    this.emit?.({
      type: "process:mailbox:enqueue",
      id: this.processId,
      size: this.items.length,
    });

    return true;
  }

  // Removes and returns the head item. This is the only method that hands
  // out the mailbox's own item object: `shift()` drops it from `items` in
  // the same step, so the mailbox retains no reference to it afterward and
  // ownership passes entirely to the caller.
  dequeue(): MailboxItem<TMsg> | undefined {
    return this.items.shift();
  }

  size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  clear(): void {
    this.items.length = 0;
  }

  // Reads the head item without removing it, so the mailbox still owns it.
  // Returns a copy — never the stored object — so a caller mutating the
  // result can't corrupt the item that's still queued (and will later be
  // handed to `dequeue()`).
  peek(): MailboxItem<TMsg> | undefined {
    const head = this.items[0];
    return head ? { ...head } : undefined;
  }

  // Snapshot of all items, still owned by the mailbox (for testing/inspection).
  // Each item is copied for the same reason as `peek()`.
  getItems(): readonly MailboxItem<TMsg>[] {
    return this.items.map((item) => ({ ...item }));
  }
}

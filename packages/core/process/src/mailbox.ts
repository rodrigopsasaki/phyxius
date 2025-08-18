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
    this.emit = emit;
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

  peek(): MailboxItem<TMsg> | undefined {
    return this.items[0];
  }

  // Get all items without removing them (for testing/inspection)
  getItems(): readonly MailboxItem<TMsg>[] {
    return [...this.items];
  }
}

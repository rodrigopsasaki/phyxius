import { describe, it, expect } from "vitest";
import { Mailbox } from "../src/mailbox.js";
import { createProcessId } from "../src/index.js";

describe("Mailbox", () => {
  const processId = createProcessId("mailbox-test");

  describe("dequeue", () => {
    it("removes the item from internal storage, transferring ownership", () => {
      const mailbox = new Mailbox<{ value: number }>(10, { type: "reject" }, processId);
      mailbox.enqueue({ value: 1 }, 0);

      const dequeued = mailbox.dequeue();
      dequeued!.msg.value = 999;

      // Mutating the dequeued item must not resurrect it or affect the
      // (now empty) mailbox — dequeue() fully transferred ownership.
      expect(mailbox.isEmpty()).toBe(true);
      expect(mailbox.dequeue()).toBeUndefined();
    });
  });

  describe("peek", () => {
    it("does not remove the item", () => {
      const mailbox = new Mailbox<{ value: number }>(10, { type: "reject" }, processId);
      mailbox.enqueue({ value: 1 }, 0);

      mailbox.peek();

      expect(mailbox.size()).toBe(1);
    });

    it("returns a copy, so mutating the result cannot corrupt the still-queued item", () => {
      const mailbox = new Mailbox<{ value: number }>(10, { type: "reject" }, processId);
      mailbox.enqueue({ value: 1 }, 0);

      const peeked = mailbox.peek();
      (peeked as { seq: number }).seq = 999;

      const dequeued = mailbox.dequeue();
      expect(dequeued?.seq).toBe(0);
    });

    it("peek shares msg contents by design — the copy boundary is the wrapper", () => {
      const mailbox = new Mailbox<{ value: number }>(10, { type: "reject" }, processId);
      mailbox.enqueue({ value: 1 }, 0);

      const peeked = mailbox.peek();
      peeked!.msg.value = 999;

      // The wrapper (seq, enqueuedAt, the msg reference) is copied, but the
      // copy is shallow: msg is still the exact object the mailbox holds,
      // so mutating its contents mutates the still-queued item too. This
      // is the boundary the peek() comment documents — made executable.
      const dequeued = mailbox.dequeue();
      expect(dequeued?.msg.value).toBe(999);
    });
  });

  describe("getItems", () => {
    it("returns copies, so mutating the snapshot cannot corrupt queued items", () => {
      const mailbox = new Mailbox<{ value: number }>(10, { type: "reject" }, processId);
      mailbox.enqueue({ value: 1 }, 0);
      mailbox.enqueue({ value: 2 }, 1);

      const snapshot = mailbox.getItems();
      (snapshot[0] as { seq: number }).seq = 999;

      expect(mailbox.dequeue()?.seq).toBe(0);
    });
  });
});
